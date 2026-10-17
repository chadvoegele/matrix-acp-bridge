import assert from "node:assert/strict";
import test from "node:test";

import { AcpToolModel } from "./acp-activity.js";
import { ActivityCardCollector, type ActivityCard } from "./activity-card-collector.js";
import { renderActivityCard } from "./acp-activity-rendering.js";
import { matrixHtmlEditContentBytes } from "./matrix-message-content.js";

function createFixture(maxEvents = 2, maxRetainedEvents = 20, maxMessageBytes = 4096) {
  const records: { id: string; card?: ActivityCard }[] = [];
  const failures: string[] = [];
  const cards = new ActivityCardCollector({
    limits: {
      maxEvents,
      maxMessageBytes,
      measure: (card) =>
        matrixHtmlEditContentBytes(renderActivityCard(card, Number.MAX_SAFE_INTEGER, matrixHtmlEditContentBytes)),
    },
    maxRetainedEvents,
    onCapacity: () => failures.push("capacity"),
    sink: { flush: (id, card) => records.push({ id, card }), finish: (id) => records.push({ id }) },
  });
  const thought = (id: string, text: string) => cards.flushThought(id, { text, cut: false });
  return { cards, records, failures, thought };
}

void test("rollover preserves old entry destinations and cumulative snapshots replace", () => {
  const f = createFixture(1);
  f.thought("a", "first");
  f.thought("b", "second");
  f.thought("a", "first updated");
  const last = f.records.at(-1)!;
  assert.equal(last.id, f.records[0]?.id);
  assert.equal(last.card?.collapsed, true);
  assert.equal(last.card?.events.length, 1);
  assert.equal(last.card?.events[0]?.type === "thought" && last.card.events[0].text, "first updated");
  assert.equal(f.cards.retainedCards, 2);
  f.cards.finishThought("a");
  assert.deepEqual(f.records.at(-1), { id: last.id });
  assert.equal(f.cards.retainedCards, 1);
  f.cards.finishThought("b");
  assert.equal(f.cards.retainedCards, 1);
  f.cards.collapse();
  assert.equal(f.cards.retainedCards, 0);
  assert.equal(f.cards.retainedEvents, 0);
});

void test("a reserved thought prevents retirement until its delayed flush and finish", () => {
  const f = createFixture();
  f.cards.openThought("pending");
  f.cards.collapse();
  assert.equal(f.records.length, 0);
  f.thought("pending", "buffered tail");
  assert.deepEqual(
    f.records.map((record) => record.card?.collapsed),
    [false, true],
  );
  assert.equal(f.cards.retainedCards, 1);
  f.cards.finishThought("pending");
  assert.equal(f.records.at(-1)?.card, undefined);
  assert.equal(f.cards.retainedCards, 0);
});

void test("closed cards release sequential source state without historical growth", () => {
  const f = createFixture();
  for (let index = 0; index < 100; index++) {
    f.thought(String(index), "text");
    f.cards.finishThought(String(index));
    f.cards.collapse();
    assert.equal(f.cards.retainedEvents, 0);
    assert.equal(f.cards.retainedCards, 0);
  }
  assert.equal(new Set(f.records.map(({ id }) => id)).size, 100);
});

void test("rollover releases completed cards before applying retention capacity", () => {
  const f = createFixture(1, 1);
  for (let index = 0; index < 20; index++) {
    f.thought(String(index), `thought ${index}`);
    f.cards.finishThought(String(index));
    assert.deepEqual(f.failures, []);
    assert.equal(f.cards.retainedEvents, 1);
    assert.equal(f.cards.retainedCards, 1);
    const latest = f.records.at(-1)!;
    assert.equal(latest.card?.collapsed, false);
    assert.equal(latest.card?.events[0]?.type === "thought" && latest.card.events[0].text, `thought ${index}`);
  }
  f.cards.collapse();
  assert.equal(f.cards.retainedEvents, 0);
  assert.equal(f.cards.retainedCards, 0);
  assert.equal(new Set(f.records.map(({ id }) => id)).size, 20);
});

void test("closing during card publication cannot repopulate state or emit after cleanup", () => {
  for (const phase of ["rollover", "finished-rollover", "deferred"]) {
    const records: ActivityCard[] = [];
    const cards = new ActivityCardCollector({
      limits: { maxEvents: 1, maxMessageBytes: 4096, measure: () => 0 },
      maxRetainedEvents: 2,
      onCapacity: () => assert.fail("unexpected capacity"),
      sink: {
        flush: (_id, card) => {
          records.push(card);
          if (phase === "deferred" || card.collapsed) cards.close();
        },
        finish: () => assert.fail("closed card finished"),
      },
    });
    if (phase === "deferred") {
      cards.openThought("a");
      cards.collapse();
      cards.flushThought("a", { text: "delayed first snapshot", cut: false });
    } else {
      cards.flushThought("a", { text: "first", cut: false });
      if (phase === "finished-rollover") cards.finishThought("a");
      cards.flushThought("b", { text: "must be abandoned", cut: false });
    }
    assert.equal(records.length, phase === "deferred" ? 1 : 2);
    assert.equal(cards.retainedEvents, 0);
    assert.equal(cards.retainedCards, 0);
    cards.flushThought("c", { text: "late", cut: false });
    assert.equal(records.length, phase === "deferred" ? 1 : 2);
  }
});

void test("card capacity is explicit, close clears state, and invalid limits fail early", () => {
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createFixture(2, invalid), /maxRetainedEvents/u);
    assert.throws(() => createFixture(invalid), /maxEvents/u);
    assert.throws(() => createFixture(2, 20, invalid), /maxMessageBytes/u);
  }
  const f = createFixture(1, 1);
  f.thought("a", "one");
  f.thought("b", "two");
  assert.deepEqual(f.failures, ["capacity"]);
  f.cards.close();
  f.thought("c", "late");
  assert.equal(f.cards.retainedEvents, 0);
  assert.equal(f.cards.retainedCards, 0);
});

void test("byte budgets roll cards before event count and rendering includes escaped wrappers and thread envelope", () => {
  const f = createFixture(10);
  f.thought("a", "<&😀".repeat(300));
  f.thought("b", "<&😀".repeat(300));
  assert.equal(f.cards.retainedCards, 2);
  const routing = { threadRootEventId: `$${"r".repeat(254)}`, threadInReplyToEventId: "$reply" };
  const measure = (rendered: Parameters<typeof matrixHtmlEditContentBytes>[0]) =>
    matrixHtmlEditContentBytes({ ...rendered, ...routing });
  for (const collapsed of [false, true]) {
    const rendered = renderActivityCard(
      { events: [{ type: "thought", text: "<&😀".repeat(2000), cut: false }], collapsed },
      2048,
      measure,
    );
    assert.ok(measure(rendered) <= 2048);
    assert.match(rendered.formattedBody, /&lt;&amp;/u);
    assert.doesNotMatch(rendered.body, /�/u);
    assert.equal(rendered.formattedBody.includes("Past agent events"), collapsed);
  }
});

void test("thought Markdown is safe inside trusted card wrappers and tool output stays literal", () => {
  const f = createFixture();
  f.thought(
    "a",
    "**Heading**\n\nSome **bold** and [safe](https://example.org) <details><script>bad</script> [bad](javascript:evil)",
  );
  const tool = new AcpToolModel().accept({
    sessionId: "s",
    kind: "tool_call",
    toolCallId: "a",
    title: "read",
    content: [{ type: "content", text: "**tool** <script>literal</script>" }],
  })!;
  f.cards.flushTool("a", tool);
  f.cards.collapse();
  f.cards.finishTool("a");
  assert.equal(f.cards.retainedEvents, 2);
  const rendered = renderActivityCard(f.records.at(-1)!.card!, 4096, matrixHtmlEditContentBytes);
  assert.match(rendered.formattedBody, /<p>💭 Heading<\/p>/u);
  assert.match(rendered.formattedBody, /<strong>bold<\/strong>/u);
  assert.match(rendered.formattedBody, /href="https:\/\/example.org"/u);
  assert.doesNotMatch(rendered.formattedBody, /<script>|href="javascript:|<details><script>/u);
  assert.equal((rendered.formattedBody.match(/<details>/gu) ?? []).length, 1);
  assert.match(rendered.formattedBody, /<code>\*\*tool\*\* &lt;script&gt;literal&lt;\/script&gt;<\/code>/u);
  assert.doesNotMatch(rendered.formattedBody, /<strong>tool/u);
});
