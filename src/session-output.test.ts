import assert from "node:assert/strict";
import test from "node:test";

import { ConversationPublication } from "./conversation-publication.js";
import type { MatrixOutputPublication } from "./matrix-output-sender.js";
import { SessionOutput } from "./session-output.js";
import { FakeClock } from "./test-support/fake-clock.js";

function fixture(maxRetainedEvents = 20) {
  const clock = new FakeClock();
  const calls: (MatrixOutputPublication & { kind: string })[] = [];
  const failures: string[] = [];
  const queue = new ConversationPublication(20, (reason) => failures.push(reason));
  // eslint-disable-next-line unicorn/consistent-function-scoping -- Fixture-specific transport gate.
  let send: () => Promise<void> = () => Promise.resolve();
  const output = new SessionOutput({
    settings: { agentTextFlushBytes: 256, agentTextQuietMs: 100, agentTextMaxIntervalMs: 250 },
    maxOutputBytes: 16_384,
    maxMatrixMessageBytes: 4096,
    maxEventsPerCard: 2,
    maxRetainedEvents,
    queue,
    clock,
    publish: async (kind, publication) => {
      calls.push({ kind, ...publication });
      await send();
      return publication.targetEventId ?? `$event-${calls.length}`;
    },
    onAbandoned: (reason) => {
      failures.push(reason);
      if (reason === "capacity") queue.stop();
    },
  });
  const text = (id: string, value: string) =>
    output.accept({ sessionId: "session", kind: "agent_message_chunk", messageId: id, text: value });
  const thought = (id: string, value: string) =>
    output.accept({ sessionId: "session", kind: "agent_thought_chunk", messageId: id, text: value });
  const tool = (id: string) =>
    output.accept({ sessionId: "session", kind: "tool_call", toolCallId: id, title: id, status: "in_progress" });
  const terminal = (id: string, status = "completed") =>
    output.accept({
      sessionId: "session",
      kind: "tool_call_update",
      toolCallId: id,
      status,
      terminalOutput: { data: "final output" },
    });
  return {
    output,
    queue,
    clock,
    calls,
    failures,
    text,
    thought,
    tool,
    terminal,
    setSend: (value: typeof send) => {
      send = value;
    },
  };
}

void test("alternating same-response thoughts and text retain both destinations across collapse", async () => {
  const f = fixture();
  f.thought("a", "First");
  f.clock.advanceBy(100);
  await f.queue.waitForIdle();
  f.text("a", "Answer");
  f.clock.advanceBy(100);
  await f.queue.waitForIdle();
  f.thought("a", "\n\nmore **detail**");
  f.clock.advanceBy(100);
  await f.queue.waitForIdle();
  const latest = f.calls.at(-1)!;
  assert.equal(latest.targetEventId, "$event-1");
  assert.match(latest.body, /First\n\n💭 more \*\*detail\*\*/u);
  assert.match(latest.formattedBody, /Past agent events.*<strong>detail<\/strong>/su);
  f.text("a", " tail");
  f.text("b", "new response");
  f.clock.advanceBy(100);
  await f.queue.waitForIdle();
  assert.equal(f.output.retainedEvents, 0);
  assert.ok(f.calls.some((call) => call.body === "Answer tail" && call.targetEventId));
  assert.equal(f.calls.filter((call) => call.kind === "text" && !call.targetEventId).length, 2);
});

void test("pending thought prevents card finish when its last tool ends", async () => {
  const f = fixture();
  f.thought("a", "pending thought");
  f.tool("tool");
  f.text("a", "text");
  f.terminal("tool");
  assert.equal(f.output.retainedEvents, 2);
  f.clock.advanceBy(100);
  await f.queue.waitForIdle();
  assert.equal(f.output.retainedEvents, 2);
  f.text("b", "next");
  await f.queue.waitForIdle();
  assert.equal(f.output.retainedEvents, 0);
  const final = [...f.calls].reverse().find((call) => call.kind === "activity")!;
  assert.match(final.body, /pending thought.*completed.*final output/su);
  assert.ok(final.targetEventId);
});

void test("parallel old cards receive final updates and expanded/collapse barriers survive blocked sends", async () => {
  const f = fixture();
  let release!: () => void;
  f.queue.enqueue(
    {},
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  f.tool("first");
  f.text("a", "one");
  f.tool("second");
  f.text("a", "two");
  f.terminal("second", "failed");
  f.terminal("first");
  release();
  await f.queue.waitForIdle();
  assert.equal(f.output.retainedCards, 0);
  for (const name of ["first", "second"]) {
    const publications = f.calls.filter((call) => call.kind === "activity" && call.body.includes(name));
    assert.doesNotMatch(publications[0]!.formattedBody, /Past agent events/u);
    assert.equal(publications[0]!.targetEventId, undefined);
    assert.match(publications.at(-1)!.formattedBody, /Past agent events/u);
    assert.ok(publications.at(-1)!.targetEventId);
    assert.match(publications.at(-1)!.body, /final output/u);
  }
});

void test("tool message metadata cannot finish either response collector; status-only intermediate updates are paced", async () => {
  const f = fixture();
  f.thought("a", "thought");
  f.text("a", "text");
  f.tool("tool");
  await f.queue.waitForIdle();
  f.output.accept({
    sessionId: "session",
    kind: "tool_call_update",
    toolCallId: "tool",
    messageId: "unrelated",
    status: "pending",
  });
  await f.queue.waitForIdle();
  assert.equal(f.calls.filter((call) => call.body.includes("[pending]")).length, 0);
  f.clock.advanceBy(100);
  await f.queue.waitForIdle();
  assert.ok(f.calls.some((call) => call.body.includes("[pending]")));
  f.thought("a", " more");
  f.text("a", " more");
  f.clock.advanceBy(100);
  await f.queue.waitForIdle();
  assert.ok(f.calls.some((call) => call.body.includes("thought more")));
  assert.equal(f.calls.filter((call) => call.kind === "text" && !call.targetEventId).length, 1);
});

void test("ID-less thoughts retain whitespace and legacy message/tool boundaries", async () => {
  const f = fixture();
  const thought = (text: string) => f.output.accept({ sessionId: "session", kind: "agent_thought_chunk", text });
  thought("**Plan**");
  thought("\n\n");
  thought("next");
  f.text("a", "answer");
  thought("second");
  f.tool("tool");
  await f.queue.waitForIdle();
  assert.ok(f.calls.some((call) => call.body === "💭 Plan\n\n💭 next"));
  assert.ok(f.calls.some((call) => call.body.includes("second") && !call.body.includes("Plan")));
});

void test("capacity and lifecycle stop cancel timers and prevent obsolete publications", async () => {
  const f = fixture(2);
  f.tool("one");
  f.tool("two");
  f.tool("three");
  await f.queue.waitForIdle();
  assert.ok(f.failures.includes("capacity"));
  assert.equal(f.output.retainedEvents, 0);
  assert.equal(f.clock.pendingTimerCount, 0);
  const other = fixture();
  other.thought("a", "buffered");
  other.text("a", "buffered");
  other.queue.stop();
  other.clock.advanceBy(1000);
  await other.queue.waitForIdle();
  assert.equal(other.calls.length, 0);
  assert.equal(other.clock.pendingTimerCount, 0);
});

void test("ID-less thought identities cannot collide with adapter-provided thought IDs", async () => {
  const f = fixture();
  f.thought("legacy-thought-0", "identified thought");
  f.output.accept({ sessionId: "session", kind: "agent_thought_chunk", text: "legacy thought" });
  f.clock.advanceBy(100);
  await f.queue.waitForIdle();
  const latest = f.calls.at(-1)!;
  assert.match(latest.body, /identified thought/u);
  assert.match(latest.body, /legacy thought/u);
  f.text("legacy-thought-0", "answer");
  assert.equal(f.output.retainedEvents, 2);
  f.thought("legacy-thought-0", " resumed");
  f.clock.advanceBy(100);
  await f.queue.waitForIdle();
  assert.ok(f.calls.some((call) => call.body.includes("identified thought resumed") && call.targetEventId));
});
