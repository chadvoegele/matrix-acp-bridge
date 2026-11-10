#!/usr/bin/env node
// Scripted ACP -> production bridge -> real SDK -> designated Matrix room -> observer.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { startBridgePair, stopBridgePair, waitFor, parseDiagnostics } from "../e2e-support/acp.mjs";
import { ThreadSessionMonitor, assertThreadResponse } from "../e2e-support/thread-sessions.mjs";
import { getEffectiveContent } from "../e2e-support/unified-observations.mjs";
import { installLiveDecryptionFailureHandler } from "../test_encrypted_message/decryption-failure-gate.mjs";
import { createAdapter as createEncryptedAdapter } from "../test_encrypted_message/lib.mjs";
import { readEnvironment, readToken } from "../test_unencrypted_message/lib.mjs";
import { createMatrixClientAdapter } from "../../dist/matrix-client.js";
import { renderMatrixText } from "../../dist/matrix-text-rendering.js";

const environment = await readEnvironment(process.argv[2]);
const encrypted = environment.transport === "encrypted";
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
const absentBodies = [];
let pair;
let fatal;
let cancellations = 0;
let initializations = 0;
const report = {
  transport: environment.transport,
  setup: "pending",
  function: "pending",
  cleanup: "external ownership-aware wrapper",
  bursts: [],
};
adapter.onFatalError(() => {
  fatal = new Error("observer fatal");
});
const begin = installLiveDecryptionFailureHandler(adapter, (error) => {
  fatal = error;
});
adapter.onSyncBatch((batch) => {
  if (batch.phase === "initial") return;
  for (const room of batch.rooms)
    for (const event of room.timeline)
      if (event.sender === environment.bridge.userId && event.eventId) events.set(event.eventId, event);
});
const body = (event) => getEffectiveContent(event)?.body;
const find = (value) => [...events.values()].filter((event) => body(event) === value);
const diagnostics = () => parseDiagnostics(pair.bridgeDiagnostics());

async function until(predicate, label) {
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

function command(method, parameters) {
  pair.acp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: parameters })}\n`);
}

async function wire(event) {
  const response = await fetch(
    `${environment.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(environment.roomId)}/event/${encodeURIComponent(event.eventId)}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  assert.equal(response.status, 200);
  const content = await response.json();
  assert.equal(content.type, encrypted ? "m.room.encrypted" : "m.room.message");
  assert.equal(event.isEncrypted, encrypted);
  if (encrypted) assert.equal(event.isDecrypted, true);
}

async function fresh(sessionId, root, marker) {
  command("test/fresh", { sessionId, marker });
  await until(() => find(marker).length === 1, "fresh output");
  assertThreadResponse(getEffectiveContent(find(marker)[0]), root, root);
}

try {
  // Change only the generated private test configuration, never production source/config.
  const config = await readFile(environment.bridge.configFile, "utf8");
  await writeFile(
    environment.bridge.configFile,
    config
      .replace("[limits]", "[limits]\nmax_activity_events_per_message = 1")
      .replace(/max_queued_turns_per_conversation\s*=\s*\d+/u, "max_queued_turns_per_conversation = 1"),
    { mode: 0o600 },
  );
  const effective = await readFile(environment.bridge.configFile, "utf8");
  assert.match(effective, /max_activity_events_per_message = 1/u);
  assert.match(effective, /max_queued_turns_per_conversation = 1/u);
  pair = await startBridgePair(environment, {
    onPair: (value) => {
      pair = value;
    },
    onOutbound: (frame) => {
      monitor.inspect(frame, "outbound");
      if (frame.method === "session/cancel") cancellations++;
      if (frame.method === "initialize") initializations++;
    },
    onInbound: (frame) => monitor.inspect(frame, "inbound"),
  });
  await adapter.validateIdentity();
  await adapter.start();
  begin();
  report.setup = "passed";
  const threads = [];
  for (let index = 0; index < 2; index++) {
    const prompt = `OVERFLOW_${randomBytes(6).toString("hex")}`;
    const root = await adapter.sendHtmlMessage({
      roomId: environment.roomId,
      transactionId: randomBytes(16).toString("hex"),
      ...renderMatrixText(prompt),
    });
    await until(() => find(`BASE_${prompt}`).length === 1, "baseline output");
    assertThreadResponse(getEffectiveContent(find(`BASE_${prompt}`)[0]), root, root);
    threads.push({ root, sessionId: monitor.promptSessions.get(prompt) });
  }
  assert.notEqual(threads[0].sessionId, threads[1].sessionId);
  const notice = "Agent output exceeded capacity. Dropping messages to Matrix until capacity is available.";
  for (let burst = 0; burst < 2; burst++) {
    const marker = `BURST_${randomBytes(6).toString("hex")}`;
    const before = diagnostics().filter((entry) => JSON.stringify(entry).includes("agent-output-recovered")).length;
    command("test/overflow", { sessionId: threads[0].sessionId, marker, count: 24 });
    await until(
      () =>
        diagnostics().filter((entry) => JSON.stringify(entry).includes("agent-output-recovered")).length > before ||
        (burst === 1 && find(`${marker}_SENTINEL`).length > 0),
      "capacity drain",
    );
    await until(() => find(notice).length === 1, "capacity notice");
    await pause(2500);
    const delivered = Array.from({ length: 24 }, (_, index) => index).filter(
      (index) => find(`${marker}_${index}`).length > 0,
    );
    assert(
      delivered.length > 0 && delivered.length < 24,
      "burst must drain accepted output and shed distinct identities",
    );
    assert(delivered.includes(0), "first accepted output did not drain");
    for (const index of delivered) {
      assert.equal(find(`${marker}_${index}`).length, 1);
      assertThreadResponse(getEffectiveContent(find(`${marker}_${index}`)[0]), threads[0].root, threads[0].root);
    }
    for (let index = 0; index < 24; index++) {
      if (!delivered.includes(index)) absentBodies.push(`${marker}_${index}`);
    }
    await fresh(threads[0].sessionId, threads[0].root, `RECOVER_${marker}`);
    await fresh(threads[1].sessionId, threads[1].root, `OTHER_${marker}`);
    report.bursts.push({
      identities: 24,
      delivered: delivered.length,
      absent: 24 - delivered.length,
      absentIndices: Array.from({ length: 24 }, (_, index) => index).filter((index) => !delivered.includes(index)),
      observationMs: 2500,
    });
  }
  await pause(2500);
  assert.equal(find(notice).length, 1, "notice cooldown not respected");
  assert(
    absentBodies.every((value) => find(value).length === 0),
    "dropped identity appeared later",
  );
  assertThreadResponse(getEffectiveContent(find(notice)[0]), threads[0].root, threads[0].root);
  for (const event of events.values()) {
    const content = getEffectiveContent(event);
    assert(
      !content?.["m.relates_to"] || threads.some(({ root }) => content["m.relates_to"].event_id === root),
      "unexpected thread/edit target",
    );
    await wire(event);
  }
  assert.equal(cancellations, 0);
  assert.equal(initializations, 1);
  assert.equal(monitor.sessionIds.size, 2);
  assert.equal(monitor.promptCount, 2);
  assert(diagnostics().some((entry) => JSON.stringify(entry).includes("agent-output-dropping")));
  assert.equal(pair.bridge.exitCode, null);
  assert.equal(pair.acp.exitCode, null);
  report.function = "passed";
  report.events = events.size;
  report.notices = find(notice).length;
  report.cancellations = cancellations;
  report.initializations = initializations;
  report.maximumPending = 2;
  report.finalAbsentRecheck = absentBodies.length;
} catch (error) {
  report.function = report.setup === "passed" ? "failed" : "skipped";
  report.error = error.message;
  throw error;
} finally {
  await adapter.stop();
  await adapter.closeCrypto();
  if (pair) {
    await writeFile(process.env.E2E_OVERFLOW_REPORT + ".diagnostics", pair.bridgeDiagnostics(), { mode: 0o600 });
    await stopBridgePair(pair);
  }
  await monitor.flushSessionIds();
  await writeFile(process.env.E2E_OVERFLOW_REPORT, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}
process.exit(0);
