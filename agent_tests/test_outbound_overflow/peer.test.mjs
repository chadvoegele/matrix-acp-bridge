import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("overflow peer produces finite distinct identities in one session and fresh output in another", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("peer.mjs", import.meta.url))]);
  const frames = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => frames.push(JSON.parse(line)));
  const send = (method, parameters) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: parameters })}\n`);
  const exit = once(child, "close");
  send("test/overflow", { sessionId: "first", marker: "BURST", count: 24 });
  send("test/fresh", { sessionId: "second", marker: "FRESH" });
  child.stdin.end();
  const [code] = await exit;
  assert.equal(code, 0);
  assert.equal(frames.length, 26);
  const burst = frames.slice(0, 25);
  assert.equal(new Set(burst.map((frame) => frame.params.update.messageId)).size, 25);
  assert(burst.every((frame) => frame.params.sessionId === "first"));
  assert.equal(frames.at(-1).params.sessionId, "second");
  assert.equal(frames.at(-1).params.update.content.text, "FRESH");
});
