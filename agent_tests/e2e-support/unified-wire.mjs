#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

import { startBridgePair, stopBridgePair, waitFor } from "./acp.mjs";
import { ThreadSessionMonitor } from "./thread-sessions.mjs";
import { assertUnifiedStream, effectiveContent } from "./unified-observations.mjs";
import { installLiveDecryptionFailureHandler } from "../test_encrypted_message/decryption-failure-gate.mjs";
import { createAdapter as createEncryptedAdapter } from "../test_encrypted_message/lib.mjs";
import { readEnvironment, readToken } from "../test_unencrypted_message/lib.mjs";
import { createMatrixClientAdapter } from "../../dist/matrix-client.js";
import { renderMatrixText } from "../../dist/matrix-text-rendering.js";

const encrypted = process.env.E2E_UNIFIED_TRANSPORT === "encrypted";
const threadMode = process.env.E2E_UNIFIED_RESPONSE_MODE === "thread";
const environment = await readEnvironment(process.argv[2]);
const token = await readToken(environment.sender.tokenFile);
const adapter = encrypted
  ? await createEncryptedAdapter(environment, "sender")
  : createMatrixClientAdapter(
      {
        homeserver: environment.homeserver,
        userId: environment.sender.userId,
        deviceId: environment.sender.deviceId,
        allowedRooms: [environment.roomId],
        allowedSenders: [environment.bridge.userId],
        encryption: "disabled",
      },
      token,
    );
const monitor = new ThreadSessionMonitor(join(environment.bridge.stateDir, "e2e-session-ids.json"));
const events = new Map();
const roots = new Map();
const pendingPrompts = new Map();
const completedSessions = new Set();
const unsolicitedSessions = new Set();
const messageIds = new Map();
let fatal;
let pair;

adapter.onFatalError(() => {
  fatal = new Error("unified sender failed");
});
const beginLiveExchange = installLiveDecryptionFailureHandler(adapter, (error) => {
  fatal = error;
});
adapter.onSyncBatch((batch) => {
  if (batch.phase === "initial") return;
  for (const room of batch.rooms) {
    for (const event of room.timeline) {
      if (event.sender === environment.bridge.userId && event.eventId) events.set(event.eventId, event);
    }
  }
});

async function awaitCondition(predicate, label) {
  await waitFor(
    () => {
      if (fatal) throw fatal;
      return predicate();
    },
    label,
    90_000,
    pair,
  );
}

async function sendPrompt(prompt, rootEventId) {
  const id = await adapter.sendHtmlMessage({
    roomId: environment.roomId,
    transactionId: `unified_${randomBytes(16).toString("hex")}`,
    ...renderMatrixText(prompt),
    ...(rootEventId ? { threadRootEventId: rootEventId, threadInReplyToEventId: rootEventId } : {}),
  });
  roots.set(prompt, rootEventId ?? id);
  return id;
}

async function runStream() {
  const marker = randomBytes(6).toString("hex").toUpperCase();
  const prompt = `UNIFIED_STREAM_${marker}`;
  const start = events.size;
  const promptId = await sendPrompt(prompt);
  const input = await readWireEvent(promptId);
  assert(Number.isFinite(input.origin_server_ts), "prompt server timestamp missing");
  assert.equal(input.type, encrypted ? "m.room.encrypted" : "m.room.message", "wrong prompt wire transport");
  await awaitCondition(
    () => [...events.values()].some((event) => effectiveContent(event)?.body === `UNIFIED_DONE_${marker}`),
    "unified final text",
  );
  await pause(1500);
  if (fatal) throw fatal;
  const observed = [...events.values()]
    .slice(start)
    .filter((event) => Number.isFinite(event.originServerTs) && event.originServerTs >= input.origin_server_ts);
  assertUnifiedStream(observed, marker, roots.get(prompt), threadMode);
  assert(unsolicitedSessions.has(monitor.promptSessions.get(prompt)), "no post-response ACP output observed");
  return { marker, prompt, observed };
}

async function readWireEvent(eventId) {
  const response = await fetch(
    `${environment.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(environment.roomId)}/event/${encodeURIComponent(eventId)}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  assert.equal(response.status, 200, "wire event lookup failed");
  return response.json();
}

async function assertWire(eventsToCheck) {
  for (const event of eventsToCheck) {
    assert.equal(event.isEncrypted, encrypted);
    if (encrypted) assert.equal(event.isDecrypted, true);
    const wire = await readWireEvent(event.eventId);
    assert.equal(wire.type, encrypted ? "m.room.encrypted" : "m.room.message", "wrong Matrix wire transport");
  }
}

try {
  pair = await startBridgePair(environment, {
    onPair: (value) => {
      pair = value;
    },
    onOutbound: (frame) => {
      monitor.inspect(frame, "outbound");
      if (frame.method === "session/prompt") {
        pendingPrompts.set(frame.id, frame.params.sessionId);
        completedSessions.delete(frame.params.sessionId);
      }
    },
    onInbound: (frame) => {
      monitor.inspect(frame, "inbound");
      const sessionId = pendingPrompts.get(frame.id);
      if (sessionId !== undefined) {
        pendingPrompts.delete(frame.id);
        if (frame.result?.stopReason !== "end_turn") fatal = new Error("scripted ACP prompt failed");
        completedSessions.add(sessionId);
      }
      if (frame.method === "session/update" && completedSessions.has(frame.params?.sessionId))
        unsolicitedSessions.add(frame.params.sessionId);
      if (frame.params?.update?.sessionUpdate === "agent_message_chunk") {
        const { sessionId, update } = frame.params;
        const previous = messageIds.get(sessionId) ?? { current: undefined, seen: new Set() };
        if (previous.current !== update.messageId && previous.seen.has(update.messageId))
          fatal = new Error("scripted ACP reused a retired assistant ID");
        previous.current = update.messageId;
        previous.seen.add(update.messageId);
        messageIds.set(sessionId, previous);
      }
    },
  });
  await adapter.validateIdentity();
  await adapter.start();
  beginLiveExchange();
  const first = await runStream();
  const second = await runStream();
  if (threadMode) assert.notEqual(monitor.promptSessions.get(first.prompt), monitor.promptSessions.get(second.prompt));
  else assert.equal(monitor.promptSessions.get(first.prompt), monitor.promptSessions.get(second.prompt));
  assert.equal(monitor.promptCount, 2, "background updates submitted another prompt");
  await assertWire([...first.observed, ...second.observed]);

  const resetMarker = randomBytes(6).toString("hex").toUpperCase();
  const resetPrompt = `UNIFIED_RESET_${resetMarker}`;
  await sendPrompt(resetPrompt);
  await awaitCondition(
    () => [...events.values()].some((event) => effectiveContent(event)?.body === `RESET_READY_${resetMarker}`),
    "reset probe ready",
  );
  await sendPrompt("/reset", threadMode ? roots.get(resetPrompt) : undefined);
  await awaitCondition(
    () => [...events.values()].some((event) => effectiveContent(event)?.body === "Agent session reset."),
    "reset completion",
  );
  await pause(5000);
  if (fatal) throw fatal;
  assert(
    ![...events.values()].some((event) => effectiveContent(event)?.body?.includes(`STALE_${resetMarker}`)),
    "retired session published late text",
  );
  assert(
    ![...events.values()].some((event) => {
      const body = effectiveContent(event)?.body ?? "";
      return body.includes(`unified-${resetMarker}-unfinished`) && body.includes("[completed]");
    }),
    "retired tool published a successful terminal update",
  );
  assert(pair.bridgeDiagnostics().includes("agent-activity-abandoned"), "reset did not report incomplete activity");
  assert.equal(monitor.promptCount, 3, "reset reached ACP as a user prompt");
  const shutdownMarker = randomBytes(6).toString("hex").toUpperCase();
  const shutdownPrompt = `UNIFIED_SHUTDOWN_${shutdownMarker}`;
  await sendPrompt(shutdownPrompt);
  await awaitCondition(
    () => completedSessions.has(monitor.promptSessions.get(shutdownPrompt)),
    "shutdown probe buffered",
  );
  await stopBridgePair(pair);
  assert(pair.bridgeDiagnostics().includes("agent-text-abandoned"), "buffered shutdown loss was not observable");
  pair = undefined;
  await pause(1100);
  assert(
    ![...events.values()].some((event) => effectiveContent(event)?.body?.includes(`SHUTDOWN_READY_${shutdownMarker}`)),
    "buffered shutdown callback published after retirement",
  );
  process.stdout.write(
    `Unified scripted ACP ${encrypted ? "encrypted" : "plaintext"} ${threadMode ? "thread" : "room"}: 2 streams, stale-session reset and buffered shutdown passed.\n`,
  );
} finally {
  await adapter.stop();
  await adapter.closeCrypto();
  if (pair) await stopBridgePair(pair);
  await monitor.flushSessionIds();
}

// Matrix SDK can retain idle handles after all clients and stores are closed.
process.exit(0);
