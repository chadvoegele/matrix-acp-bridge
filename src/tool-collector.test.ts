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
  assert.deepEqual(records.at(-1), { id: "a" });
  assert.equal(collector.activeCount, 1);
  assert.equal(records[0]?.tool?.status, "pending");
  collector.accept({ sessionId: "s", kind: "tool_call_update", toolCallId: "b", status: "failed" });
  assert.deepEqual(records.at(-1), { id: "b" });
  assert.equal(collector.activeCount, 0);
  assert.equal(clock.pendingTimerCount, 0);
  collector.accept({ sessionId: "s", kind: "tool_call_update", toolCallId: "a", status: "failed" });
  assert.deepEqual(records.at(-1), { id: "b" });
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
  assert.deepEqual(records, ["a"]);
});
