import assert from "node:assert/strict";
import test from "node:test";

import {
  ACP_ACTIVITY_UPDATE_MAX_BYTES,
  isAcpUpdateNotification,
  normalizeAcpUpdateNotification,
  type AcpToolCallUpdate,
} from "./acp-activity-update.js";

function normalize(update: Record<string, unknown>) {
  return normalizeAcpUpdateNotification({ sessionId: "session", update });
}

function tool(update: Record<string, unknown>): AcpToolCallUpdate {
  const result = normalize({ sessionUpdate: "tool_call_update", ...update });
  assert.ok(
    result?.kind === "tool_call" || result?.kind === "tool_call_update",
  );
  return result;
}

void test("validates notification envelopes without requiring known update kinds", () => {
  for (const value of [
    null,
    [],
    {},
    { sessionId: 1, update: {} },
    { sessionId: "session", update: null },
    { sessionId: "session", update: {} },
    { sessionId: "session", update: { sessionUpdate: false } },
  ]) {
    assert.equal(isAcpUpdateNotification(value), false);
    assert.equal(normalizeAcpUpdateNotification(value), undefined);
  }
  assert.equal(
    isAcpUpdateNotification({
      sessionId: "session",
      update: { sessionUpdate: "future" },
    }),
    true,
  );
  assert.deepEqual(normalize({ sessionUpdate: "future", messageId: "id" }), {
    sessionId: "session",
    kind: "unknown",
    messageId: "id",
  });
});

void test("preserves ignored-kind aliases and drops invalid message IDs", () => {
  const aliases = {
    user_message_chunk: "user_message_chunk",
    plan: "plan",
    plan_update: "plan",
    plan_removed: "plan",
    available_commands_update: "available_commands",
    current_mode_update: "current_mode_update",
    config_option_update: "config_option_update",
    usage_update: "usage_update",
  };
  for (const [sessionUpdate, kind] of Object.entries(aliases)) {
    assert.deepEqual(normalize({ sessionUpdate, messageId: 1 }), {
      sessionId: "session",
      kind,
    });
  }
});

void test("accepts only text chunks and leaves ordinary messages unbounded", () => {
  for (const sessionUpdate of ["agent_message_chunk", "agent_thought_chunk"]) {
    for (const content of [
      null,
      {},
      { type: "image", text: "image" },
      { type: "text", text: 1 },
    ]) {
      assert.equal(normalize({ sessionUpdate, content }), undefined);
    }
  }
  const text = "x".repeat(ACP_ACTIVITY_UPDATE_MAX_BYTES + 1);
  assert.deepEqual(
    normalize({
      sessionUpdate: "agent_message_chunk",
      messageId: "id",
      content: { type: "text", text },
    }),
    {
      sessionId: "session",
      kind: "agent_message_chunk",
      messageId: "id",
      text,
    },
  );
});

void test("bounds thoughts with one Unicode-safe budget including the message ID", () => {
  const result = normalize({
    sessionUpdate: "agent_thought_chunk",
    messageId: "id",
    content: { type: "text", text: "😀".repeat(ACP_ACTIVITY_UPDATE_MAX_BYTES) },
  });
  assert.equal(result?.kind, "agent_thought_chunk");
  if (result?.kind !== "agent_thought_chunk") return;
  assert.equal(
    Buffer.byteLength(result.text, "utf8"),
    ACP_ACTIVITY_UPDATE_MAX_BYTES - 4,
  );
  assert.equal(result.messageId, "id");
  assert.equal(result.textCut, true);
  assert.doesNotMatch(result.text, /�/u);
  assert.deepEqual(
    normalize({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "small" },
    }),
    { sessionId: "session", kind: "agent_thought_chunk", text: "small" },
  );
  const idOnly = normalize({
    sessionUpdate: "agent_thought_chunk",
    messageId: "x".repeat(ACP_ACTIVITY_UPDATE_MAX_BYTES + 1),
    content: { type: "text", text: "" },
  });
  assert.equal(idOnly?.kind, "agent_thought_chunk");
  if (idOnly?.kind === "agent_thought_chunk")
    assert.equal(idOnly.textCut, true);
});

void test("shares the tool budget across identifiers, locations, content, terminal metadata, and raw input", () => {
  const result = tool({
    messageId: "m",
    toolCallId: "t",
    kind: "k",
    status: "s",
    title: "n",
    locations: [{ path: "p", line: 1 }],
    content: [
      {
        type: "content",
        content: {
          type: "text",
          text: "c".repeat(ACP_ACTIVITY_UPDATE_MAX_BYTES - 10),
        },
      },
    ],
    _meta: {
      terminal_output: { terminal_id: "i", data: "terminal data" },
      terminal_exit: { signal: "signal" },
    },
    rawInput: "input",
    rawOutput: "output",
  });
  assert.equal(result.contentCut, undefined);
  assert.equal(result.activityCut, true);
  assert.equal(result.terminalOutput?.data, "\n\na");
  assert.equal(result.terminalOutput?.originalBytes, 13);
  assert.deepEqual(result.terminalExit, { signal: "" });
  assert.equal(result.rawInput, undefined);
  assert.equal(result.rawOutput, undefined);
  const retained = [
    result.messageId!,
    result.toolCallId!,
    result.toolKind!,
    result.status!,
    result.title!,
    result.locations![0]!.path,
    result.content![0]!.type === "content" ? result.content![0]!.text : "",
    result.terminalOutput.terminalId!,
    result.terminalOutput.data,
  ];
  assert.equal(
    retained.reduce(
      (bytes, value) => bytes + Buffer.byteLength(value, "utf8"),
      0,
    ),
    ACP_ACTIVITY_UPDATE_MAX_BYTES,
  );
});

void test("retains terminal head and tail with original byte count only on truncation", () => {
  const data = `HEAD${"😀".repeat(ACP_ACTIVITY_UPDATE_MAX_BYTES)}TAIL`;
  const result = tool({ _meta: { terminal_output: { data } } });
  assert.equal(result.activityCut, true);
  assert.equal(result.contentCut, undefined);
  assert.equal(
    result.terminalOutput?.originalBytes,
    Buffer.byteLength(data, "utf8"),
  );
  assert.ok(result.terminalOutput?.data.startsWith("HEAD"));
  assert.ok(result.terminalOutput?.data.endsWith("TAIL"));
  assert.ok(result.terminalOutput?.data.includes("\n\n"));
  assert.doesNotMatch(result.terminalOutput.data, /�/u);
  assert.ok(
    Buffer.byteLength(result.terminalOutput.data, "utf8") <=
      ACP_ACTIVITY_UPDATE_MAX_BYTES,
  );
  assert.deepEqual(
    tool({ _meta: { terminal_output: { data: "small" } } }).terminalOutput,
    { data: "small" },
  );
});

void test("normalizes optional fields, nulls, and JSON input without retaining raw objects", () => {
  const rawInput = { nested: [1, true, null, "text"], invalid: Number.NaN };
  const content = [
    { type: "diff", path: "file", oldText: null, newText: "new" },
    { type: "terminal", terminalId: "term" },
    { type: "image" },
  ];
  const result = tool({
    toolCallId: "tool",
    title: 8,
    kind: false,
    status: null,
    locations: [
      { path: "file", line: -1 },
      { path: "other", line: 2 },
      { path: 9 },
    ],
    content,
    rawInput,
    rawOutput: null,
    _meta: {
      terminal_exit: { terminal_id: "term", exit_code: 0, signal: null },
    },
  });
  assert.deepEqual(result, {
    sessionId: "session",
    kind: "tool_call_update",
    toolCallId: "tool",
    locations: [{ path: "file" }, { path: "other", line: 2 }],
    content: [
      { type: "diff", path: "file", oldText: null, newText: "new" },
      { type: "terminal", terminalId: "term" },
    ],
    rawInput: { nested: [1, true, null, "text"] },
    rawOutput: null,
    terminalExit: { terminalId: "term", exitCode: 0, signal: null },
  });
  rawInput.nested.push("changed");
  content[0]!.path = "changed";
  assert.deepEqual(result.rawInput, { nested: [1, true, null, "text"] });
  assert.deepEqual(result.content?.[0], {
    type: "diff",
    path: "file",
    oldText: null,
    newText: "new",
  });
  assert.deepEqual(
    tool({
      content: false,
      locations: false,
      rawInput: Number.POSITIVE_INFINITY,
      _meta: {
        terminal_output: { data: false },
        terminal_exit: { exit_code: 1.5, signal: false },
      },
    }),
    { sessionId: "session", kind: "tool_call_update", terminalExit: {} },
  );
});

void test("preserves collection/depth/key bounds and independent cut flags", () => {
  const content = Array.from({ length: 33 }, () => ({
    type: "content",
    content: { type: "text", text: "small" },
  }));
  const result = tool({ content });
  assert.equal(result.content?.length, 32);
  assert.equal(result.contentCut, true);
  assert.equal(result.activityCut, undefined);
  const raw = tool({
    rawInput: Array.from({ length: 33 }, (_, index) => index),
    rawOutput: { a: { b: { c: { d: { e: "too deep" } } } } },
  });
  assert.equal((raw.rawInput as readonly number[]).length, 32);
  assert.deepEqual(raw.rawOutput, { a: { b: { c: { d: {} } } } });
  assert.equal(raw.activityCut, true);
  assert.equal(raw.contentCut, undefined);
  const keyed = tool({ rawInput: { ["x".repeat(129)]: "value" } });
  assert.deepEqual(keyed.rawInput, { ["x".repeat(128)]: "value" });
  assert.equal(keyed.activityCut, true);
  const large = tool({
    content: [
      {
        type: "diff",
        path: "file",
        newText: "x".repeat(ACP_ACTIVITY_UPDATE_MAX_BYTES),
      },
    ],
  });
  assert.equal(large.contentCut, true);
  assert.equal(large.activityCut, true);
});
