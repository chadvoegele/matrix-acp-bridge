// Deterministic local ACP emitter; no real agent sessions or model calls.
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  switch (frame.method) {
    case "initialize": {
      send({
        id: frame.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { delete: {} } } },
      });
      break;
    }
    case "session/new": {
      send({ id: frame.id, result: { sessionId: `outage-${randomBytes(8).toString("hex")}` } });
      break;
    }
    case "session/load":
    case "session/delete": {
      send({ id: frame.id, result: {} });
      break;
    }
    case "session/prompt": {
      const text = frame.params.prompt.find((part) => part.type === "text")?.text ?? "";
      const expected = /^Reply with exactly: (OUTAGE_[A-F0-9_]+)$/u.exec(text)?.[1] ?? "Historical test input handled";
      const sessionId = frame.params.sessionId;
      const messageId = `outage-response-${frame.id}`;
      send({
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            messageId,
            content: { type: "text", text: "Preparing outage test response." },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      send({
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: expected } },
        },
      });
      send({ id: frame.id, result: { stopReason: "end_turn" } });
      break;
    }
    default: {
      if (frame.id !== undefined) send({ id: frame.id, error: { code: -32_601, message: "unsupported test method" } });
    }
  }
}
