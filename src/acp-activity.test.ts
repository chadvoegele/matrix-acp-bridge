import assert from "node:assert/strict";
import { test } from "node:test";

import type { AcpToolCallUpdate } from "./acp-client.js";
import { AcpActivityModel, renderAcpActivity } from "./acp-activity.js";

function tool(overrides: Partial<AcpToolCallUpdate> = {}): AcpToolCallUpdate {
  return { sessionId: "session", kind: "tool_call", toolCallId: "call", title: "read", toolKind: "read", status: "pending", ...overrides };
}
function update(overrides: Partial<AcpToolCallUpdate> = {}): AcpToolCallUpdate {
  return { sessionId: "session", kind: "tool_call_update", toolCallId: "call", ...overrides };
}
function firstTool(model: AcpActivityModel) {
  const event = model.events[0];
  assert.ok(event && event.type === "tool");
  return event;
}

void test("thought runs ignore spacing, use IDs, and close at agent-message and tool boundaries", () => {
  const model = new AcpActivityModel();
  model.accept({ sessionId: "session", kind: "agent_thought_chunk", text: "**Plan**" });
  model.accept({ sessionId: "session", kind: "agent_thought_chunk", text: "\n\n" });
  model.accept({ sessionId: "session", kind: "agent_thought_chunk", text: " next" });
  assert.equal(model.events.length, 1);
  assert.equal(renderAcpActivity(model.events[0]!).formattedBody, "<p>💭 **Plan** next</p>");
  model.accept({ sessionId: "session", kind: "agent_message_chunk", text: "Hi" });
  model.accept({ sessionId: "session", kind: "agent_thought_chunk", text: "second", messageId: "a" });
  model.accept(tool());
  model.accept({ sessionId: "session", kind: "agent_thought_chunk", text: "third", messageId: "b" });
  model.accept({ sessionId: "session", kind: "agent_thought_chunk", text: "!", messageId: "a" });
  assert.equal(model.events.length, 4);
  assert.equal(renderAcpActivity(model.events[1]!).body, "💭 second!");
  model.close();
  assert.equal(model.accept({ sessionId: "session", kind: "agent_thought_chunk", text: "late" }), undefined);
  assert.equal(model.events.length, 4);
});

void test("read status progresses with one rail, content takes priority over rawOutput", () => {
  const model = new AcpActivityModel();
  model.accept(tool({ rawInput: { path: "/tmp/a" } }));
  const event = firstTool(model);
  assert.match(renderAcpActivity(event).formattedBody, /#808080.*Read\(\/tmp\/a\)/);
  model.accept(update({ status: "in_progress" }));
  assert.match(renderAcpActivity(event).formattedBody, /#000000.*Read\(\/tmp\/a\)/);
  model.accept(update({ status: "completed", content: [{ type: "content", text: "alpha\nbeta\n" }], rawOutput: { content: [{ type: "text", text: "DUPLICATE" }] } }));
  const rendered = renderAcpActivity(event);
  assert.match(rendered.formattedBody, /#008000.*Read\(\/tmp\/a\)/);
  assert.match(rendered.formattedBody, /<pre><code>alpha&#10;beta&#10;<\/code><\/pre>/);
  assert.doesNotMatch(rendered.body, /DUPLICATE/);
  assert.equal((rendered.formattedBody.match(/┃/g) ?? []).length, 1);
  assert.match(rendered.body, /^\[completed\]/);
  model.accept(update({ status: "failed", content: [{ type: "content", text: "Permission denied" }] }));
  assert.match(renderAcpActivity(event).formattedBody, /#C00000.*Permission denied/s);
});

void test("write and edit show returned full-file text with colored absolute line gutters", () => {
  const write = new AcpActivityModel();
  write.accept(tool({ title: "write", toolKind: "edit", rawInput: { path: "/tmp/a", content: "ignored" } }));
  write.accept(update({ status: "completed", content: [{ type: "diff", path: "/tmp/a", oldText: null, newText: "alpha\nbeta\n" }] }));
  const renderedWrite = renderAcpActivity(firstTool(write));
  assert.match(renderedWrite.body, /Write\(\/tmp\/a\).*\+1 alpha\n\+2 beta/s);
  assert.doesNotMatch(renderedWrite.body, /ignored/);
  assert.match(renderedWrite.formattedBody, /#008000">\+<\/span><span data-mx-color="#000000">1 <\/span>/);

  const edit = new AcpActivityModel();
  edit.accept(tool({ title: "edit", toolKind: "edit", rawInput: { path: "/tmp/a", edits: [{ oldText: "7", newText: "11" }] } }));
  edit.accept(update({ status: "in_progress", locations: [{ path: "/tmp/a", line: 99 }] }));
  edit.accept(update({ status: "completed", content: [{ type: "diff", path: "/tmp/a", oldText: "2\n3\n5\n7\n", newText: "2\n3\n5\n11\n" }] }));
  const renderedEdit = renderAcpActivity(firstTool(edit));
  assert.match(renderedEdit.body, /-1 2\n-2 3\n-3 5\n-4 7\n\n\+1 2\n\+2 3\n\+3 5\n\+4 11/);
  assert.doesNotMatch(renderedEdit.body, /99|@@/);
  assert.match(renderedEdit.formattedBody, /#C00000">-<\/span>/);
});

void test("terminal output streams a bounded recent tail and keeps status", () => {
  const model = new AcpActivityModel();
  model.accept(tool({ title: "cat -- file", toolKind: "execute", content: [{ type: "terminal", terminalId: "term" }] }));
  const event = firstTool(model);
  model.accept(update({ status: "in_progress", terminalOutput: { data: "alpha\n" } }));
  assert.match(renderAcpActivity(event).body, /\[running\].*alpha/s);
  model.accept(update({ terminalOutput: { data: "beta\n" } }));
  model.accept(update({ status: "completed", terminalExit: { exitCode: 0 } }));
  assert.match(renderAcpActivity(event).body, /alpha\nbeta\n/);
  assert.equal(event.terminalBytes, 11);
  assert.equal(model.events.length, 1);
  model.accept(update({ status: "failed" }));
  assert.match(renderAcpActivity(event).formattedBody, /#C00000/);
});

void test("long command and output have separate clickable summaries, exact caps, and escaped fallback", () => {
  const model = new AcpActivityModel();
  model.accept(tool({ title: `echo ${"<&😀".repeat(600)}`, toolKind: "execute" }));
  model.accept(update({ terminalOutput: { data: "&<script>\u001B[31m" + "x".repeat(9000) + "TAIL" } }));
  const rendered = renderAcpActivity(firstTool(model));
  assert.equal((rendered.formattedBody.match(/<details>/g) ?? []).length, 2);
  assert.match(rendered.formattedBody, /<summary>.*Execute\(echo/s);
  assert.match(rendered.formattedBody, /&amp;&lt;script&gt;/);
  assert.doesNotMatch(rendered.formattedBody, /<script>/);
  assert.equal(rendered.formattedBody.includes("\u001B"), false);
  assert.match(rendered.body, /TAIL \(truncated\)$/);
  assert.ok(Buffer.byteLength(firstTool(model).terminalHead, "utf8") <= 6144);
  assert.ok(Buffer.byteLength(firstTool(model).terminalTail, "utf8") <= 2048);
  assert.equal(firstTool(model).terminalSmall, "");

  const exact = new AcpActivityModel();
  exact.accept(tool({ rawInput: { path: "file" } }));
  exact.accept(update({ content: [{ type: "content", text: "a".repeat(1024) }] }));
  assert.doesNotMatch(renderAcpActivity(firstTool(exact)).formattedBody, /<details>/);
  exact.accept(update({ content: [{ type: "content", text: "a".repeat(1025) }] }));
  assert.match(renderAcpActivity(firstTool(exact)).formattedBody, /<details><summary><code>/);
  assert.doesNotMatch(renderAcpActivity(firstTool(exact)).body, /truncated/);
  exact.accept(update({ content: [{ type: "content", text: "a".repeat(8193) }] }));
  assert.match(renderAcpActivity(firstTool(exact)).body, /\(truncated\)$/);
});

void test("unknown shapes and malformed updates keep a safe readable fallback", () => {
  const model = new AcpActivityModel();
  assert.equal(model.accept(update({ toolCallId: "missing", status: "completed" })), undefined);
  model.accept(tool({ title: "<bad & title>", toolKind: "other", rawInput: { path: "ignored" } }));
  const rendered = renderAcpActivity(firstTool(model));
  assert.match(rendered.body, /Tool\(<bad & title>\)/);
  assert.match(rendered.formattedBody, /Tool\(&lt;bad &amp; title&gt;\)/);
  assert.doesNotMatch(rendered.formattedBody, /rawInput|ignored/);
  model.accept(update({ rawOutput: { content: [{ type: "text", text: "<fallback>" }] } }));
  assert.match(renderAcpActivity(firstTool(model)).formattedBody, /&lt;fallback&gt;/);
});

void test("Unicode command cutoffs and UTF-8 output boundaries are exact", () => {
  const model = new AcpActivityModel();
  model.accept(tool({ title: "😀".repeat(160), toolKind: "execute" }));
  const event = firstTool(model);
  assert.doesNotMatch(renderAcpActivity(event).formattedBody, /<details>/);
  model.accept(update({ title: "😀".repeat(161) }));
  assert.match(renderAcpActivity(event).formattedBody, /<details><summary>/);
  assert.doesNotMatch(renderAcpActivity(event).body, /truncated/);
  model.accept(update({ title: "😀".repeat(512) }));
  assert.doesNotMatch(renderAcpActivity(event).body, /truncated/);
  model.accept(update({ title: "😀".repeat(513) }));
  assert.match(renderAcpActivity(event).body, /truncated/);

  const read = new AcpActivityModel();
  read.accept(tool());
  read.accept(update({ content: [{ type: "content", text: `${"a".repeat(1023)}😀` }] }));
  const rendered = renderAcpActivity(firstTool(read));
  assert.match(rendered.formattedBody, /<details><summary><code>/);
  assert.doesNotMatch(rendered.body, /�/);
  assert.match(rendered.formattedBody, /😀<\/code><\/pre>/);
});

void test("streamed short lines and a large first chunk remain bounded", () => {
  const model = new AcpActivityModel();
  model.accept(tool({ title: "run", toolKind: "execute" }));
  const event = firstTool(model);
  model.accept(update({ terminalOutput: { data: "x\n".repeat(50_000) } }));
  assert.equal(event.terminalSmall, "");
  assert.equal(Buffer.byteLength(event.terminalHead, "utf8"), 6144);
  assert.equal(Buffer.byteLength(event.terminalTail, "utf8"), 2048);
  model.accept(update({ terminalOutput: { data: "LATEST\n" } }));
  assert.match(renderAcpActivity(event).body, /LATEST\n \(truncated\)$/);
  assert.ok(renderAcpActivity(event).formattedBody.length < 35_000);
});

void test("pathological short diff lines fit the HTML message limit by shrinking detail first", () => {
  const model = new AcpActivityModel();
  model.accept(tool({ title: "write", toolKind: "edit", rawInput: { path: "file", content: "" } }));
  model.accept(update({ status: "completed", content: [{ type: "diff", path: "file", oldText: null, newText: "x\n".repeat(20_000) }] }));
  const rendered = renderAcpActivity(firstTool(model));
  assert.ok(Buffer.byteLength(rendered.formattedBody, "utf8") <= 32_768);
  assert.match(rendered.formattedBody, /<summary>.*\(truncated\)/s);
  const tiny = renderAcpActivity(firstTool(model), 2048);
  assert.ok(Buffer.byteLength(tiny.formattedBody, "utf8") <= 2048);
  assert.match(tiny.body, /truncated/);
});
