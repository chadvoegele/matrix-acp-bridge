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
  assert.equal(renderAcpActivity(model.events[0]!).formattedBody, "<p>💭 Plan</p>\n<p>💭 next</p>");
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

void test("one streamed thought retains paragraph breaks and unbolds heading-like paragraphs", () => {
  const model = new AcpActivityModel();
  model.accept({ sessionId: "session", kind: "agent_thought_chunk", text: "**First heading**" });
  model.accept({ sessionId: "session", kind: "agent_thought_chunk", text: "\n\n" });
  model.accept({ sessionId: "session", kind: "agent_thought_chunk", text: "**Second heading**" });
  assert.equal(model.events.length, 1);
  const rendered = renderAcpActivity(model.events[0]!);
  assert.equal(rendered.body, "💭 First heading\n\n💭 Second heading");
  assert.equal(rendered.formattedBody, "<p>💭 First heading</p>\n<p>💭 Second heading</p>");
  const single = new AcpActivityModel();
  single.accept({ sessionId: "session", kind: "agent_thought_chunk", text: "**First heading**\n\n**Second <heading>**" });
  assert.equal(renderAcpActivity(single.events[0]!).formattedBody,
    "<p>💭 First heading</p>\n<p>💭 Second &lt;heading&gt;</p>");
});

void test("mcpScript shows bounded source like an Execute command alongside its result", () => {
  const model = new AcpActivityModel();
  const source = "const tag = '<sample>';\nreturn { answer: 5 };";
  model.accept(tool({ title: "mcpScript", toolKind: "other", rawInput: { code: source } }));
  const pending = renderAcpActivity(firstTool(model));
  assert.match(pending.body, /MCP Script\(const tag = '<sample>'; return \{ answer: 5 \};\)/);
  assert.match(pending.body, /Script:\nconst tag = '<sample>';\nreturn \{ answer: 5 \};/);
  assert.match(pending.formattedBody, /<details><summary>.*MCP Script\(/);
  assert.match(pending.formattedBody, /<pre><code>const tag = &#39;&lt;sample&gt;&#39;;&#10;return/);
  model.accept(update({ status: "in_progress" }));
  assert.match(renderAcpActivity(firstTool(model)).formattedBody, /#000000.*MCP Script\(/);
  model.accept(update({ status: "completed", content: [{ type: "content", text: "{\"answer\":5}" }] }));
  const completed = renderAcpActivity(firstTool(model));
  assert.match(completed.formattedBody, /<pre><code>const tag = &#39;&lt;sample&gt;&#39;;&#10;return/);
  assert.match(completed.formattedBody, /<\/details>\n<blockquote><pre><code>\{&quot;answer&quot;:5\}<\/code><\/pre><\/blockquote>$/);
  assert.match(completed.body, /Script:\nconst tag = '<sample>';\nreturn \{ answer: 5 \};\n\{"answer":5\}/);

  const long = new AcpActivityModel();
  long.accept(tool({ title: "mcpScript", toolKind: "other", rawInput: { code: "return 'x';\n".repeat(1000) } }));
  const bounded = renderAcpActivity(firstTool(long), 4096);
  assert.match(bounded.body, /MCP Script\(.*\(truncated\)/);
  assert.ok(Buffer.byteLength(bounded.formattedBody, "utf8") <= 4096);
});

void test("short and long tool results indent the entire result outside escaped code", () => {
  const model = new AcpActivityModel();
  model.accept(tool({ rawInput: { path: "/tmp/example" } }));
  model.accept(update({ status: "completed", content: [{ type: "content", text: "<&\nsecond" }] }));
  const short = renderAcpActivity(firstTool(model));
  assert.match(short.formattedBody, /Read\(\/tmp\/example\).*<\/p>\n<blockquote><pre><code>&lt;&amp;&#10;second<\/code><\/pre><\/blockquote>$/s);
  assert.equal(short.body, "[completed] 🔧 Read(/tmp/example)\n<&\nsecond");
  assert.doesNotMatch(short.formattedBody, /Result · completed|→/);

  model.accept(update({ content: [{ type: "content", text: "<&\nsecond\nthird\nfourth" }] }));
  const long = renderAcpActivity(firstTool(model));
  assert.match(long.formattedBody, /<\/p>\n<blockquote><details><summary><code>&lt;&amp;&#10;second&#10;third<\/code><\/summary><pre><code>&lt;&amp;&#10;second&#10;third&#10;fourth<\/code><\/pre><\/details><\/blockquote>$/);
  assert.equal(long.body, "[completed] 🔧 Read(/tmp/example)\n<&\nsecond\nthird");
  assert.doesNotMatch(long.formattedBody, /Result · completed|→/);
});

void test("mcpScript keeps source disclosure separate from an indented long result", () => {
  const model = new AcpActivityModel();
  model.accept(tool({ title: "mcpScript", toolKind: "other", rawInput: { code: "return '<source>';" } }));
  model.accept(update({ status: "completed", content: [{ type: "content", text: "<result>\n2\n3\n4" }] }));
  const rendered = renderAcpActivity(firstTool(model));
  assert.match(rendered.formattedBody, /<details><summary>.*MCP Script\(return &#39;&lt;source&gt;&#39;;\).*<\/summary><pre><code>return &#39;&lt;source&gt;&#39;;<\/code><\/pre><\/details>\n<blockquote><details><summary><code>&lt;result&gt;&#10;2&#10;3<\/code><\/summary><pre><code>&lt;result&gt;&#10;2&#10;3&#10;4<\/code><\/pre><\/details><\/blockquote>$/s);
  assert.equal(rendered.body, "[completed] 🔧 MCP Script(return '<source>';)\nScript:\nreturn '<source>';\n<result>\n2\n3");
  const budgeted = renderAcpActivity(firstTool(model), 512);
  assert.ok(Buffer.byteLength(budgeted.formattedBody, "utf8") <= 512);
  assert.match(budgeted.formattedBody, /<blockquote><details>/);
  assert.match(budgeted.body, /Script:\nreturn '<source>';\n<result>/);
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
  assert.match(renderedEdit.body, /-1 2\n-2 3\n-3 5$/);
  assert.match(renderedEdit.formattedBody, /<details><summary>/);
  assert.match(renderedEdit.formattedBody, /#C00000">7<\/span>/);
  assert.match(renderedEdit.formattedBody, /#008000">11<\/span>/);
  assert.doesNotMatch(renderedEdit.body, /99|@@/);
  assert.match(renderedEdit.formattedBody, /#C00000">-<\/span>/);
});

void test("MCP search and named calls use ACP input rather than inventing a tool from result text", () => {
  const search = new AcpActivityModel();
  search.accept(tool({ title: "mcp", toolKind: "other", rawInput: { search: "example tools" } }));
  search.accept(update({ status: "completed", content: [{ type: "content", text: "example (36 tools):\n- example_store" }] }));
  const renderedSearch = renderAcpActivity(firstTool(search));
  assert.match(renderedSearch.body, /MCP\(search\)/);
  assert.doesNotMatch(renderedSearch.body, /MCP\(example_store\)/);

  const invocation = new AcpActivityModel();
  invocation.accept(tool({ title: "mcp", toolKind: "other", rawInput: { call: { server: "example", tool: "example_recall", arguments: { query: "private" } } } }));
  const renderedCall = renderAcpActivity(firstTool(invocation));
  assert.match(renderedCall.body, /MCP\(example_recall\)/);
  assert.doesNotMatch(renderedCall.body, /private/);
  assert.match(renderedCall.formattedBody, /MCP\(example_recall\)/);

  const description = new AcpActivityModel();
  description.accept(tool({ title: "mcp", toolKind: "other", rawInput: { describe: "example_recall" } }));
  assert.match(renderAcpActivity(firstTool(description)).body, /MCP\(example_recall\)/);

  const server = new AcpActivityModel();
  server.accept(tool({ title: "mcp__example", toolKind: "other", rawInput: { tool: "list", args: {} } }));
  assert.match(renderAcpActivity(firstTool(server)).body, /MCP\(example\/list\)/);

  const unknown = new AcpActivityModel();
  unknown.accept(tool({ title: "mcp", toolKind: "other", rawInput: { call: { arguments: { query: "private" } } } }));
  assert.match(renderAcpActivity(firstTool(unknown)).body, /🔧 MCP$/);
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
  assert.match(rendered.formattedBody, /TAIL<\/code><\/pre>/);
  assert.equal(firstTool(model).terminalSmall, "");

  const exact = new AcpActivityModel();
  exact.accept(tool({ rawInput: { path: "file" } }));
  exact.accept(update({ content: [{ type: "content", text: "a".repeat(256) }] }));
  assert.doesNotMatch(renderAcpActivity(firstTool(exact)).formattedBody, /<details>/);
  exact.accept(update({ content: [{ type: "content", text: "a".repeat(257) }] }));
  assert.match(renderAcpActivity(firstTool(exact)).formattedBody, /<details><summary><code>/);
  assert.doesNotMatch(renderAcpActivity(firstTool(exact)).body, /truncated/);
  exact.accept(update({ content: [{ type: "content", text: "a".repeat(8193) }] }));
  assert.match(renderAcpActivity(firstTool(exact)).body, /\(truncated\)$/);
});

void test("previews use at most three lines, retaining the newest terminal lines", () => {
  const read = new AcpActivityModel();
  read.accept(tool());
  read.accept(update({ content: [{ type: "content", text: "one\ntwo\nthree\nfour" }] }));
  const renderedRead = renderAcpActivity(firstTool(read));
  assert.match(renderedRead.body, /one\ntwo\nthree$/);
  assert.doesNotMatch(renderedRead.body, /four/);
  assert.match(renderedRead.formattedBody, /four<\/code><\/pre>/);

  const terminal = new AcpActivityModel();
  terminal.accept(tool({ title: "run", toolKind: "execute" }));
  terminal.accept(update({ terminalOutput: { data: "one\ntwo\nthree\nfour\nfive\n" } }));
  const renderedTerminal = renderAcpActivity(firstTool(terminal));
  assert.match(renderedTerminal.body, /three\nfour\nfive\n$/);
  assert.doesNotMatch(renderedTerminal.body, /one/);
  assert.match(renderedTerminal.formattedBody, /one&#10;two&#10;three/);
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
  read.accept(update({ content: [{ type: "content", text: `${"a".repeat(255)}😀` }] }));
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
  assert.equal(Buffer.byteLength(event.terminalHead, "utf8"), 6142);
  assert.equal(Buffer.byteLength(event.terminalTail, "utf8"), 2048);
  model.accept(update({ terminalOutput: { data: "LATEST\n" } }));
  assert.match(renderAcpActivity(event).body, /LATEST\n \(truncated\)$/);
  assert.ok(renderAcpActivity(event).formattedBody.length < 35_000);
});

void test("terminal head and tail fit together without clipping the final bytes", () => {
  const model = new AcpActivityModel();
  model.accept(tool({ title: "run", toolKind: "execute" }));
  model.accept(update({ terminalOutput: { data: `FIRST_OUTPUT${"x".repeat(12_000)}LAST_OUTPUT`, originalBytes: 12_023 } }));
  const event = firstTool(model);
  const rendered = renderAcpActivity(event);
  assert.equal(event.terminalBytes, 12_023);
  assert.match(rendered.formattedBody, /FIRST_OUTPUT/);
  assert.match(rendered.formattedBody, /LAST_OUTPUT<\/code><\/pre>/);
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
