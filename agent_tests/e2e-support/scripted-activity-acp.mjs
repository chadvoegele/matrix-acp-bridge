#!/usr/bin/env node
// Deterministic ACP peer for the opt-in Matrix activity wire test.
import { createInterface } from "node:readline";

const sessionId = "scripted-activity-session";
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
const pause = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
const update = async (value) => {
  send({ method: "session/update", params: { sessionId, update: value } });
  await pause();
};
const thought = (text, messageId) => update({ sessionUpdate: "agent_thought_chunk", messageId,
  content: { type: "text", text } });
const message = (text, messageId) => update({ sessionUpdate: "agent_message_chunk", messageId,
  content: { type: "text", text } });
const tool = (toolCallId, title, kind, rawInput) => update({ sessionUpdate: "tool_call",
  toolCallId, title, kind, status: "pending", rawInput });
const change = (toolCallId, fields) => update({ sessionUpdate: "tool_call_update", toolCallId, ...fields });

async function scenario(marker) {
  await thought("**A live thought**", "opening");
  await thought("\n\n", "opening");
  await message("I will show activity before the tools.", "before");
  await tool("read", "read", "read", { path: "/tmp/activity-example.txt" });
  await change("read", { status: "in_progress" });
  await tool("write", "write", "edit", { path: "/tmp/activity-example.txt", content: "alpha\nbeta\n" });
  await change("write", { status: "in_progress" });
  await change("write", { status: "completed", content: [{ type: "diff", path: "/tmp/activity-example.txt",
    oldText: null, newText: "alpha\nbeta\n" }] });
  await tool("edit", "edit", "edit", { path: "/tmp/activity-example.txt",
    edits: [{ oldText: "beta", newText: "gamma" }] });
  await change("edit", { status: "in_progress", locations: [{ path: "/tmp/activity-example.txt", line: 2 }] });
  await change("edit", { status: "completed", content: [{ type: "diff", path: "/tmp/activity-example.txt",
    oldText: "alpha\nbeta\n", newText: "alpha\ngamma\n" }] });
  await tool("execute", `printf '${"command".repeat(300)}'`, "execute", {});
  await change("execute", { status: "in_progress", _meta: { terminal_output: {
    terminal_id: "terminal-1", data: "FIRST_OUTPUT\n" } } });
  await change("execute", { status: "in_progress", _meta: { terminal_output: {
    terminal_id: "terminal-1", data: `${"middle-output\n".repeat(900)}LAST_OUTPUT\n` } } });
  await change("execute", { status: "completed", _meta: { terminal_exit: {
    terminal_id: "terminal-1", exit_code: 0, signal: null } } });
  for (let index = 5; index <= 10; index += 1) await thought(`batch thought ${index}`, `batch-${index}`);
  await thought("batch thought 11", "batch-11");
  // The wire runners assert this update targets an original archived batch.
  await change("read", { status: "completed", content: [{ type: "content",
    content: { type: "text", text: "READ_RESULT_ONCE\n" } }],
  rawOutput: { content: [{ type: "text", text: "READ_RESULT_ONCE\n" }] } });
  await message(`SCRIPTED_ACP_DONE_${marker}`, "after");
}

for await (const line of createInterface({ input: process.stdin })) {
  let frame;
  try { frame = JSON.parse(line); } catch { continue; }
  switch (frame.method) {
    case "initialize": {
      send({ id: frame.id, result: { protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { delete: {} } } } });
      break;
    }
    case "session/new": {
      send({ id: frame.id, result: { sessionId } });
      break;
    }
    case "session/delete": {
      send({ id: frame.id, result: {} });
      break;
    }
    case "session/prompt": {
      const prompt = frame.params?.prompt?.find?.((part) => part.type === "text")?.text ?? "";
      const marker = /^ACTIVITY_WIRE_([A-F0-9]{12})$/u.exec(prompt)?.[1];
      if (!marker) { send({ id: frame.id, error: { code: -32_602, message: "invalid test prompt" } }); break; }
      await scenario(marker);
      send({ id: frame.id, result: { stopReason: "end_turn" } });
      break;
    }
    default: { break; }
  }
}
