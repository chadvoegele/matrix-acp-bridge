import assert from "node:assert/strict";
import test from "node:test";

import { AcpToolModel } from "./acp-activity.js";
import { ActivityCardCollector, type ActivityCard } from "./activity-card-collector.js";
import { renderActivityCard } from "./acp-activity-rendering.js";
import { matrixHtmlEditContentBytes } from "./matrix-message-content.js";

function fixture(maxEvents = 2, maxRetainedEvents = 20) {
  const records: { id: string; card?: ActivityCard }[] = [];
  const failures: string[] = [];
  const cards = new ActivityCardCollector({
    limits: {
      maxEvents,
      maxMessageBytes: 4096,
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
  const f = fixture(1);
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
  const f = fixture();
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
  const f = fixture();
  for (let index = 0; index < 100; index++) {
    f.thought(String(index), "text");
    f.cards.finishThought(String(index));
    f.cards.collapse();
    assert.equal(f.cards.retainedEvents, 0);
    assert.equal(f.cards.retainedCards, 0);
  }
  assert.equal(new Set(f.records.map(({ id }) => id)).size, 100);
});

void test("card capacity is explicit, close clears state, and invalid limits fail early", () => {
  assert.throws(() => fixture(2, 0), /maxRetainedEvents/u);
  const f = fixture(1, 1);
  f.thought("a", "one");
  f.thought("b", "two");
  assert.deepEqual(f.failures, ["capacity"]);
  f.cards.close();
  f.thought("c", "late");
  assert.equal(f.cards.retainedEvents, 0);
  assert.equal(f.cards.retainedCards, 0);
});

void test("byte budgets roll cards before event count and rendering includes escaped wrappers and thread envelope", () => {
  const f = fixture(10);
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
  const f = fixture();
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
