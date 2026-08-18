#!/usr/bin/env node
import { randomBytes } from "node:crypto";

import { readEnvironment, readToken } from "./lib.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || process.argv[index + 1] === undefined) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function optionalArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const environment = await readEnvironment(argument("--environment"));
const prompt = argument("--prompt");
const mode = optionalArgument("--mode") ?? "exchange";
if (!["exchange", "send-only", "watch"].includes(mode)) throw new Error(`unsupported sender mode: ${mode}`);
const expected = mode === "send-only" ? undefined : argument("--expect");
const token = await readToken(environment.sender.tokenFile);
const roomPath = encodeURIComponent(environment.roomId);

async function matrixRequest(path, options = {}) {
  const response = await fetch(`${environment.homeserver}/_matrix/client/v3${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    signal: options.signal ?? AbortSignal.timeout(35_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Matrix request failed: HTTP ${response.status}`);
  return body;
}

async function sync(since, timeout = 0) {
  const query = new URLSearchParams({ timeout: String(timeout) });
  if (since !== undefined) query.set("since", since);
  return matrixRequest(`/sync?${query}`, { signal: AbortSignal.timeout(timeout + 15_000) });
}

function roomEvents(result) {
  const events = result.rooms?.join?.[environment.roomId]?.timeline?.events;
  return Array.isArray(events) ? events : [];
}

async function rawEvent(eventId) {
  return matrixRequest(`/rooms/${roomPath}/event/${encodeURIComponent(eventId)}`);
}

let cursor;
let promptEventId;
if (mode === "watch") {
  cursor = argument("--since");
  promptEventId = argument("--prompt-event-id");
} else {
  const initialSync = await sync(undefined, 0);
  cursor = initialSync.next_batch;
  if (typeof cursor !== "string") throw new Error("initial Matrix sync did not return next_batch");
  const transactionId = `mab_plain_${randomBytes(16).toString("hex")}`;
  process.stderr.write("Sender is ready; sending plaintext prompt.\n");
  const sent = await matrixRequest(
    `/rooms/${roomPath}/send/m.room.message/${transactionId}`,
    { method: "PUT", body: JSON.stringify({ msgtype: "m.text", body: prompt }) },
  );
  if (typeof sent.event_id !== "string") throw new Error("Matrix send did not return an event ID");
  promptEventId = sent.event_id;
  if (mode === "send-only") {
    const promptEvent = await rawEvent(promptEventId);
    if (promptEvent.type !== "m.room.message" || promptEvent.content?.msgtype !== "m.text" ||
        promptEvent.content.body !== prompt) {
      throw new Error("prompt was not a plaintext m.room.message event");
    }
    process.stdout.write(`${JSON.stringify({
      event: "prompt-sent",
      promptEventId,
      promptWireType: promptEvent.type,
      syncCursor: cursor,
    })}\n`);
    process.exit(0);
  }
}

const responseEvents = [];
const deadline = Date.now() + 180_000;
while (Date.now() < deadline && responseEvents.length === 0) {
  const result = await sync(cursor, Math.min(30_000, deadline - Date.now()));
  if (typeof result.next_batch !== "string") throw new Error("Matrix sync did not return next_batch");
  cursor = result.next_batch;
  for (const event of roomEvents(result)) {
    if (event?.type === "m.room.message" && event.sender === environment.bridge.userId &&
        event.content?.msgtype === "m.text" && event.content.body === expected) responseEvents.push(event);
  }
}
if (responseEvents.length === 0) throw new Error("plaintext exchange timed out");

// Give an accidental duplicate response time to arrive.
const finalSync = await sync(cursor, 2000);
for (const event of roomEvents(finalSync)) {
  if (event?.type === "m.room.message" && event.sender === environment.bridge.userId &&
      event.content?.msgtype === "m.text" && event.content.body === expected) responseEvents.push(event);
}
if (responseEvents.length !== 1) throw new Error(`expected one response, received ${responseEvents.length}`);

const [promptEvent, responseEvent] = await Promise.all([
  rawEvent(promptEventId),
  rawEvent(responseEvents[0].event_id),
]);
for (const [label, event, body] of [
  ["prompt", promptEvent, prompt],
  ["response", responseEvent, expected],
]) {
  if (event.type !== "m.room.message" || event.content?.msgtype !== "m.text" || event.content.body !== body) {
    throw new Error(`${label} was not a plaintext m.room.message event`);
  }
}
process.stdout.write(`${JSON.stringify({
  event: "exchange-complete",
  promptEventId,
  responseEventId: responseEvents[0].event_id,
  promptWireType: promptEvent.type,
  responseWireType: responseEvent.type,
  responseCount: responseEvents.length,
})}\n`);
