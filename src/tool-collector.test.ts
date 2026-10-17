import assert from "node:assert/strict";
import test from "node:test";
import { ToolCollector } from "./tool-collector.js";
import type { AcpToolActivity } from "./acp-activity.js";
import { FakeClock } from "./test-support/fake-clock.js";

void test("parallel tool patches coalesce status-only changes and flush cumulative terminal output before finish", () => {
  const clock = new FakeClock();
  const records: { id: string; tool?: AcpToolActivity }[] = [];
  const collector = new ToolCollector({
    settings: { agentTextFlushBytes: 256, agentTextQuietMs: 100, agentTextMaxIntervalMs: 250 },
    maxRetainedEvents: 2,
    clock,
    onCapacity: () => assert.fail("unexpected capacity"),
    sink: { flush: (id, tool) => records.push({ id, tool }), finish: (id) => records.push({ id }) },
  });
  for (const id of ["a", "b"]) collector.accept({ sessionId: "s", kind: "tool_call", toolCallId: id, title: id });
  assert.equal(records.length, 2);
  collector.accept({ sessionId: "s", kind: "tool_call_update", toolCallId: "a", status: "in_progress" });
  assert.equal(records.length, 2);
  clock.advanceBy(100);
  assert.equal(records.at(-1)?.tool?.status, "in_progress");
  collector.accept({
    sessionId: "s",
    kind: "tool_call_update",
    toolCallId: "a",
    content: [{ type: "content", text: "replace me" }],
  });
  collector.accept({
    sessionId: "s",
    kind: "tool_call_update",
    toolCallId: "a",
    content: [{ type: "content", text: "final result" }],
    terminalOutput: { data: "first" },
  });
  collector.accept({
    sessionId: "s",
    kind: "tool_call_update",
    toolCallId: "a",
    status: "completed",
    terminalOutput: { data: " last" },
  });
  const final = records.at(-2)!.tool!;
  assert.equal(final.content?.[0]?.type === "content" && final.content[0].text, "final result");
  assert.equal(final.terminalSmall, "first last");
  assert.equal(final.status, "completed");
  assert.deepEqual(records.at(-1), { id: "identified:a" });
  assert.equal(collector.activeCount, 1);
  assert.equal(records[0]?.tool?.status, "pending");
  collector.accept({ sessionId: "s", kind: "tool_call_update", toolCallId: "b", status: "failed" });
  assert.deepEqual(records.at(-1), { id: "identified:b" });
  assert.equal(collector.activeCount, 0);
  assert.equal(clock.pendingTimerCount, 0);
  collector.accept({ sessionId: "s", kind: "tool_call_update", toolCallId: "a", status: "failed" });
  assert.deepEqual(records.at(-1), { id: "identified:b" });
});

void test("tool capacity and cancellation discard pending work without terminal success", () => {
  const clock = new FakeClock();
  const failures: string[] = [];
  const records: string[] = [];
  const collector = new ToolCollector({
    settings: { agentTextFlushBytes: 256, agentTextQuietMs: 100, agentTextMaxIntervalMs: 250 },
    maxRetainedEvents: 1,
    clock,
    onCapacity: () => {
      failures.push("capacity");
      collector.stop();
    },
    sink: { flush: (id) => records.push(id), finish: () => assert.fail("unfinished tool finished") },
  });
  collector.accept({ sessionId: "s", kind: "tool_call", toolCallId: "a" });
  collector.accept({ sessionId: "s", kind: "tool_call_update", toolCallId: "a", status: "in_progress" });
  assert.equal(clock.pendingTimerCount, 1);
  collector.accept({ sessionId: "s", kind: "tool_call", toolCallId: "b" });
  assert.deepEqual(failures, ["capacity"]);
  assert.equal(clock.pendingTimerCount, 0);
  clock.advanceBy(1000);
  assert.deepEqual(records, ["identified:a"]);
});

void test("tool constructor rejects invalid capacity and pacing before accepting updates", () => {
  const options = {
    settings: { agentTextFlushBytes: 256, agentTextQuietMs: 100, agentTextMaxIntervalMs: 250 },
    maxRetainedEvents: 1,
    onCapacity: () => assert.fail("invalid constructor retained work"),
    sink: { flush: () => assert.fail("invalid constructor published"), finish: () => {} },
  };
  for (const maxRetainedEvents of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new ToolCollector({ ...options, maxRetainedEvents }), /maxRetainedEvents/u);
  }
  assert.throws(
    () => new ToolCollector({ ...options, settings: { ...options.settings, agentTextQuietMs: 0 } }),
    /agent_text_quiet_ms/u,
  );
});

void test("capacity rejection releases unaccepted model entries even when the callback keeps intake open", () => {
  const records: string[] = [];
  let failures = 0;
  const collector = new ToolCollector({
    settings: { agentTextFlushBytes: 256, agentTextQuietMs: 100, agentTextMaxIntervalMs: 250 },
    maxRetainedEvents: 1,
    onCapacity: () => {
      failures += 1;
    },
    sink: { flush: (_id, content) => records.push(content.title!), finish: () => {} },
  });
  collector.accept({ sessionId: "s", kind: "tool_call", toolCallId: "accepted", title: "accepted" });
  for (let index = 0; index < 20; index++)
    collector.accept({ sessionId: "s", kind: "tool_call", toolCallId: `rejected-${index}`, title: "rejected" });
  assert.equal(failures, 20);
  assert.equal(collector.activeCount, 1);
  collector.accept({ sessionId: "s", kind: "tool_call_update", toolCallId: "accepted", status: "completed" });
  for (let index = 0; index < 20; index++)
    collector.accept({
      sessionId: "s",
      kind: "tool_call_update",
      toolCallId: `rejected-${index}`,
      status: "completed",
    });
  assert.deepEqual(records, ["accepted", "accepted"]);
  assert.equal(collector.activeCount, 0);
  collector.accept({
    sessionId: "s",
    kind: "tool_call",
    toolCallId: "rejected-0",
    title: "new start",
    status: "completed",
  });
  assert.equal(records.at(-1), "new start");
});
