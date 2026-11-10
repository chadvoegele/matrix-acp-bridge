#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
const text = (sessionId, id, body) =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", messageId: id, content: { type: "text", text: body } },
    },
  });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  switch (frame.method) {
    case "initialize": {
      send({
        id: frame.id,
        result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { delete: {} } } },
      });
      break;
    }
    case "session/new": {
      send({ id: frame.id, result: { sessionId: randomUUID() } });
      break;
    }
    case "session/delete": {
      send({ id: frame.id, result: {} });
      break;
    }
    case "session/prompt": {
      const prompt = frame.params.prompt.find((part) => part.type === "text")?.text ?? "";
      text(frame.params.sessionId, randomUUID(), `BASE_${prompt}`);
      send({ id: frame.id, result: { stopReason: "end_turn" } });
      break;
    }
    case "test/overflow": {
      for (let index = 0; index < frame.params.count; index++)
        text(frame.params.sessionId, `${frame.params.marker}-${index}`, `${frame.params.marker}_${index}`);
      // A distinct sentinel forces the last burst identity to flush synchronously.
      text(frame.params.sessionId, `${frame.params.marker}-sentinel`, `${frame.params.marker}_SENTINEL`);
      break;
    }
    case "test/fresh": {
      text(frame.params.sessionId, randomUUID(), frame.params.marker);
      break;
    }
    default: {
      break;
    }
  }
}
