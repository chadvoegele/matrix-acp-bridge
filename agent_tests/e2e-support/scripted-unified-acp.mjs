#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const sessions = new Map();
const observations = new Map();

function waitForObservation(marker, stage) {
  if (process.argv.includes("--recover") && stage !== "reset") return Promise.resolve();
  return new Promise((resolve) => observations.set(`${marker}/${stage}`, resolve));
}

const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);

async function runScenario(sessionId, marker, reset, sequence) {
  const update = (value) => send({ method: "session/update", params: { sessionId, update: value } });
  const text = (value, messageId = `answer-${sequence}`) =>
    update({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: value } });
  const tool = (toolCallId) =>
    update({
      sessionUpdate: "tool_call",
      toolCallId: `${toolCallId}-${sequence}`,
      title: `unified-${marker}-${toolCallId}`,
      status: "in_progress",
    });
  if (reset) {
    tool("unfinished");
    // Intentionally deliver late frames even after session/delete to test stale routing.
    await waitForObservation(marker, "reset");
    text(`STALE_${marker}`, "stale");
    update({ sessionUpdate: "tool_call_update", toolCallId: `unfinished-${sequence}`, status: "completed" });
    return;
  }
  await waitForObservation(marker, "prefix");
  const suffixObserved = waitForObservation(marker, "suffix");
  text(" suffix**");
  await suffixObserved;
  const toolsObserved = waitForObservation(marker, "tools");
  tool("first");
  tool("second");
  await toolsObserved;
  const continuationObserved = waitForObservation(marker, "after-tool");
  text(" after tool");
  await continuationObserved;
  for (let index = 0; index < 12; index++) {
    text(`SEQUENTIAL_${marker}_${index}`, `sequential-${sequence}-${index}`);
  }
  // Both tools outlive the prompt and all the assistant identity transitions.
  update({ sessionUpdate: "tool_call_update", toolCallId: `second-${sequence}`, status: "failed" });
  update({ sessionUpdate: "tool_call_update", toolCallId: `first-${sequence}`, status: "completed" });
  text(`UNIFIED_DONE_${marker}`, `done-${sequence}`);
}

for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  switch (frame.method) {
    case "test/unifiedObserved": {
      const key = `${frame.params?.marker}/${frame.params?.stage}`;
      const resolve = observations.get(key);
      observations.delete(key);
      resolve?.();
      break;
    }
    case "initialize": {
      send({
        id: frame.id,
        result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { delete: {} } } },
      });
      break;
    }
    case "session/new": {
      const sessionId = randomUUID();
      sessions.set(sessionId, 0);
      send({ id: frame.id, result: { sessionId } });
      break;
    }
    case "session/delete": {
      sessions.delete(frame.params?.sessionId);
      send({ id: frame.id, result: {} });
      break;
    }
    case "session/prompt": {
      const prompt = frame.params?.prompt?.find?.((part) => part.type === "text")?.text ?? "";
      const match = /^UNIFIED_(STREAM|RESET|SHUTDOWN)_([A-F0-9]{12})$/u.exec(prompt);
      if (!match || !sessions.has(frame.params?.sessionId)) {
        send({ id: frame.id, error: { code: -32_602, message: "invalid unified test prompt or session" } });
        break;
      }
      const sessionId = frame.params.sessionId;
      const sequence = sessions.get(sessionId) + 1;
      sessions.set(sessionId, sequence);
      send({
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: `answer-${sequence}`,
            content: {
              type: "text",
              text: match[1] === "STREAM" ? `UNIFIED_${match[2]} **prefix` : `${match[1]}_READY_${match[2]}`,
            },
          },
        },
      });
      send({ id: frame.id, result: { stopReason: "end_turn" } });
      if (match[1] === "SHUTDOWN") break;
      // Continuations, new identities and tools arrive without a pending prompt.
      // eslint-disable-next-line unicorn/prefer-top-level-await -- intake must accept concurrent sessions and deletion while output streams.
      void runScenario(frame.params.sessionId, match[2], match[1] === "RESET", sequence).catch(() => {
        process.stderr.write("Scripted unified scenario failed.\n");
        process.exitCode = 1;
      });
      break;
    }
    default: {
      break;
    }
  }
}
