#!/usr/bin/env node
import { randomBytes } from "node:crypto";

import { installLiveDecryptionFailureHandler } from "./decryption-failure-gate.mjs";
import { createAdapter, readEnvironment, readToken } from "./lib.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || process.argv[index + 1] === undefined) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

const environment = await readEnvironment(argument("--environment"));
const prompt = argument("--prompt");
const expected = argument("--expect");
const adapter = await createAdapter(environment, "sender");
const token = await readToken(environment.sender.tokenFile);
const timeoutMs = 180_000;
let promptEvent;
const responseEvents = [];
let resolveExchange;
let rejectExchange;
const exchange = new Promise((resolve, reject) => {
  resolveExchange = resolve;
  rejectExchange = reject;
});
const timer = setTimeout(() => rejectExchange(new Error("encrypted exchange timed out")), timeoutMs);

adapter.onFatalError(() => rejectExchange(new Error("Matrix sender reported a fatal error")));
const beginLiveExchange = installLiveDecryptionFailureHandler(adapter, rejectExchange);
adapter.onSyncBatch((batch) => {
  // Initial history is not part of this exchange. Inspect only the normalized
  // timelines from later live batches.
  if (batch.phase === "initial") return;
  for (const room of batch.rooms) {
    for (const event of room.timeline) {
      const body = typeof event.content?.body === "string" ? event.content.body : undefined;
      if (event.sender === environment.sender.userId && body === prompt) promptEvent = event;
      if (promptEvent !== undefined && event.sender === environment.bridge.userId && body === expected) {
        responseEvents.push(event);
      }
      if (promptEvent !== undefined && responseEvents.length > 0) resolveExchange();
    }
  }
});

async function rawEventType(eventId) {
  const room = encodeURIComponent(environment.roomId);
  const event = encodeURIComponent(eventId);
  const response = await fetch(`${environment.homeserver}/_matrix/client/v3/rooms/${room}/event/${event}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.type !== "string") throw new Error(`event lookup failed: HTTP ${response.status}`);
  return body.type;
}

function assertEncrypted(event, label) {
  if (event?.eventId === undefined || event.isEncrypted !== true || event.isDecrypted !== true || event.isPlaintext === true) {
    throw new Error(`${label} was not an authenticated decrypted encrypted event`);
  }
}

try {
  await adapter.start();
  beginLiveExchange();
  promptEvent = undefined;
  responseEvents.length = 0;
  process.stderr.write("Sender is ready; sending encrypted prompt.\n");
  await adapter.sendMessage({
    roomId: environment.roomId,
    inboundEventId: `$mabe2e_${randomBytes(8).toString("hex")}`,
    responseKind: "agent",
    partNumber: 1,
    partCount: 1,
    transactionId: `mabe2e_${randomBytes(16).toString("hex")}`,
    content: { msgtype: "m.text", body: prompt },
  });
  process.stderr.write("Encrypted prompt sent; waiting for response.\n");
  await exchange;
  process.stderr.write("Encrypted response received.\n");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  clearTimeout(timer);
  if (responseEvents.length !== 1) throw new Error(`expected one response, received ${responseEvents.length}`);
  const responseEvent = responseEvents[0];
  assertEncrypted(promptEvent, "prompt");
  assertEncrypted(responseEvent, "response");
  const [promptWireType, responseWireType] = await Promise.all([
    rawEventType(promptEvent.eventId),
    rawEventType(responseEvent.eventId),
  ]);
  if (promptWireType !== "m.room.encrypted" || responseWireType !== "m.room.encrypted") {
    throw new Error("prompt or response was plaintext on the wire");
  }
  process.stdout.write(`${JSON.stringify({
    event: "exchange-complete",
    promptEventId: promptEvent.eventId,
    responseEventId: responseEvent.eventId,
    promptWireType,
    responseWireType,
    responseCount: responseEvents.length,
  })}\n`);
} finally {
  clearTimeout(timer);
  await adapter.stop().catch(() => {});
  await adapter.closeCrypto().catch(() => {});
}
