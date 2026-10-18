import assert from "node:assert/strict";
import test from "node:test";

import type { AcpUpdate } from "./acp-activity-update.js";
import { ConversationPublication } from "./conversation-publication.js";
import type { MatrixOutputPublication } from "./conversation-publication.js";
import { SessionOutput } from "./session-output.js";
import { FakeClock } from "./test-support/fake-clock.js";

function createFixture(maxRetainedEvents = 20) {
  const clock = new FakeClock();
  const calls: (MatrixOutputPublication & { kind: string })[] = [];
  const failures: string[] = [];
  // eslint-disable-next-line unicorn/consistent-function-scoping -- Fixture-specific transport gate.
  let send: () => Promise<void> = () => Promise.resolve();
  const queue = new ConversationPublication({
    maximumPending: 20,
    maxMatrixMessageBytes: 4096,
    onFailure: (reason) => failures.push(reason),
    publish: async (kind, publication) => {
      calls.push({ kind, ...publication });
      await send();
      return publication.targetEventId ?? `$event-${calls.length}`;
    },
  });
  const output = new SessionOutput({
    settings: { agentTextFlushBytes: 256, agentTextQuietMs: 100, agentTextMaxIntervalMs: 250 },
    maxOutputBytes: 16_384,
    maxMatrixMessageBytes: 4096,
    maxEventsPerCard: 2,
    maxRetainedEvents,
    queue,
    clock,
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

void test("leading blank or control-only thoughts reserve no card entry or timer and do not reduce tool capacity", async () => {
  const f = createFixture(2);
  f.thought("a", "\n\n");
  f.output.accept({
    sessionId: "session",
    kind: "agent_thought_chunk",
    messageId: "a",
    text: "\u001B[31m\n\n\u001B[0m",
  });
  assert.equal(f.output.retainedEvents, 0);
  assert.equal(f.output.retainedCards, 0);
  assert.equal(f.clock.pendingTimerCount, 0);
  f.tool("first");
  f.tool("second");
  await f.queue.waitForIdle();
  assert.deepEqual(f.failures, []);
  assert.equal(f.output.retainedEvents, 2);
  f.terminal("first");
  f.terminal("second");
  f.text("a", "answer");
  f.thought("b", "  ");
  await f.queue.waitForIdle();
  assert.equal(f.output.retainedEvents, 0);
  assert.equal(f.output.retainedCards, 0);
  assert.equal(f.clock.pendingTimerCount, 0);
  f.queue.stop();
});

void test("alternating same-response thoughts and text retain both destinations across collapse", async () => {
  const f = createFixture();
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
  const f = createFixture();
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
  const f = createFixture();
  let release!: () => void;
  f.setSend(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  f.text("blocker", "blocking");
  f.clock.advanceBy(100);
  await Promise.resolve();
  f.setSend(() => Promise.resolve());
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
  const f = createFixture();
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

void test("rejected thoughts cannot reserve entries or interfere with tool boundaries", async () => {
  const f = createFixture(2);
  for (const text of ["**private plan**", "\n\n", "\u001B[31m\n\n\u001B[0m"]) {
    f.output.accept({ sessionId: "session", kind: "agent_thought_chunk", text });
    assert.equal(f.output.retainedEvents, 0);
    assert.equal(f.output.retainedCards, 0);
    assert.equal(f.clock.pendingTimerCount, 0);
  }
  f.tool("first");
  f.output.accept({ sessionId: "session", kind: "agent_thought_chunk", text: "private boundary" });
  f.tool("second");
  await f.queue.waitForIdle();
  assert.equal(f.output.retainedEvents, 2);
  assert.deepEqual(f.failures, []);
  assert.doesNotMatch(JSON.stringify(f.calls), /private/u);
  f.queue.stop();
});

void test("capacity and lifecycle stop cancel timers and prevent obsolete publications", async () => {
  const f = createFixture(2);
  f.tool("one");
  f.tool("two");
  f.tool("three");
  await f.queue.waitForIdle();
  assert.ok(f.failures.includes("capacity"));
  assert.equal(f.output.retainedEvents, 0);
  assert.equal(f.clock.pendingTimerCount, 0);
  const other = createFixture();
  other.thought("a", "buffered");
  other.text("a", "buffered");
  other.queue.stop();
  other.clock.advanceBy(1000);
  await other.queue.waitForIdle();
  assert.equal(other.calls.length, 0);
  assert.equal(other.clock.pendingTimerCount, 0);
});

void test("rejected thoughts cannot collide with adapter-provided IDs or change their original destination", async () => {
  const f = createFixture();
  f.thought("legacy-thought-0", "identified thought");
  f.output.accept({ sessionId: "session", kind: "agent_thought_chunk", text: "legacy thought" });
  f.clock.advanceBy(100);
  await f.queue.waitForIdle();
  const latest = f.calls.at(-1)!;
  assert.match(latest.body, /identified thought/u);
  assert.doesNotMatch(latest.body, /legacy thought/u);
  f.text("legacy-thought-0", "answer");
  assert.equal(f.output.retainedEvents, 1);
  f.thought("legacy-thought-0", " resumed");
  assert.equal(f.clock.pendingTimerCount > 0, true);
  f.clock.advanceBy(100);
  await f.queue.waitForIdle();
  assert.ok(f.calls.some((call) => call.body.includes("identified thought resumed") && call.targetEventId));
});

void test("ID-less tool identities cannot replace or finish an identified tool with a generated-looking ID", async () => {
  for (const toolId of ["anonymous-tool-0", "anonymous:0"]) {
    const f = createFixture();
    f.tool(toolId);
    f.output.accept({ sessionId: "session", kind: "tool_call", title: "anonymous result", status: "completed" });
    await f.queue.waitForIdle();
    assert.equal(f.output.retainedEvents, 2);
    const latest = f.calls.at(-1)!;
    assert.ok(latest.body.includes(`[running] 🔧 Tool(${toolId})`));
    assert.match(latest.body, /\[completed\].*anonymous result/u);
    f.text("answer", "collapse");
    await f.queue.waitForIdle();
    assert.equal(f.output.retainedCards, 1);
    f.terminal(toolId);
    await f.queue.waitForIdle();
    assert.equal(f.output.retainedEvents, 0);
    assert.equal(f.output.retainedCards, 0);
    assert.equal(f.calls.at(-1)?.targetEventId, latest.targetEventId ?? "$event-1");
    assert.ok(f.calls.at(-1)!.body.includes(`[completed] 🔧 Tool(${toolId})`));
    assert.match(f.calls.at(-1)!.body, /anonymous result/u);
    f.queue.stop();
  }
});

void test("invalid message and thought IDs create no collector state, timers or publication", async () => {
  const f = createFixture();
  for (const kind of ["agent_message_chunk", "agent_thought_chunk"] as const) {
    for (const messageId of [undefined, "", " \t\n", "\u0000\u001B", null, 42, {}, []]) {
      f.output.accept({
        sessionId: "session",
        kind,
        messageId,
        text: "private rejected",
      } as AcpUpdate);
      assert.equal(f.output.retainedEvents, 0);
      assert.equal(f.output.retainedCards, 0);
      assert.equal(f.output.hasPendingText, false);
      assert.equal(f.clock.pendingTimerCount, 0);
    }
  }
  f.clock.advanceBy(30_000);
  await f.queue.waitForIdle();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.failures, []);
  f.queue.stop();
});

void test("rejected text and thoughts leave identified thought and text destinations intact", async () => {
  const f = createFixture();
  f.thought("answer", "identified ");
  const timers = f.clock.pendingTimerCount;
  f.output.accept({ sessionId: "session", kind: "agent_message_chunk", text: "private boundary" });
  assert.equal(f.clock.pendingTimerCount, timers);
  assert.equal(f.calls.length, 0);
  assert.equal(f.output.retainedEvents, 1);
  f.output.accept({ sessionId: "session", kind: "agent_thought_chunk", messageId: "", text: "private thought" });
  f.thought("answer", "thought");
  f.clock.advanceBy(100);
  await f.queue.waitForIdle();
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.body, /identified thought/);
  assert.doesNotMatch(f.calls[0]!.formattedBody, /Past agent events/);
  f.text("answer", "before ");
  f.output.accept({ sessionId: "session", kind: "agent_message_chunk", messageId: " ", text: "private mixed" });
  f.text("answer", "after");
  f.clock.advanceBy(100);
  await f.queue.waitForIdle();
  const messages = f.calls.filter((call) => call.kind === "text");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.body, "before after");
  assert.doesNotMatch(JSON.stringify(f.calls), /private/);
  assert.deepEqual(f.failures, []);
  f.queue.stop();
  assert.equal(f.clock.pendingTimerCount, 0);
});
