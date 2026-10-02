#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createMatrixClientAdapter } from "../../dist/matrix-client.js";
import { startBridgePair, stopBridgePair, waitFor } from "../e2e-support/acp.mjs";
import { readEnvironment, readToken, writePrivateFile } from "../e2e-support/common.mjs";
import { assertSteeringBaseline, assertSteeringHealthy } from "../e2e-support/steering-observations.mjs";

// The caller must hold the shared live lock and retain each state's session IDs
// for cleanup. This probe intentionally separates sending while stopped from
// startup, so initialized recovery cannot be confused with fresh suppression.
const [environmentPath, operation, evidencePath, inputPath] = process.argv.slice(2);
assert.ok(environmentPath && evidencePath);
assert.ok(["fresh", "quiet", "send", "catchup"].includes(operation));
const environment = await readEnvironment(environmentPath);
const frames = [];
const events = [];
let phase = "startup";
let pair;
let sent;
let summary;
const statePath = resolve(environment.bridge.stateDir, "bridge-state.json");
const state = async () => JSON.parse(await readFile(statePath, "utf8"));

async function snapshot() {
  try {
    return await state();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const stateBefore = await snapshot();
const requests = (method) => frames.filter(({ direction, frame }) => direction === "out" && frame.method === method);
const sender = createMatrixClientAdapter(
  {
    homeserver: environment.homeserver,
    userId: environment.sender.userId,
    deviceId: environment.sender.deviceId,
    accessTokenFile: environment.sender.tokenFile,
    allowedRooms: [environment.roomId],
    allowedSenders: [environment.bridge.userId, environment.sender.userId],
    encryption: "disabled",
    responseMode: "room",
  },
  await readToken(environment.sender.tokenFile),
);
sender.onSyncBatch((batch) => {
  if (batch.phase !== "initial") events.push(...batch.rooms.flatMap((room) => room.timeline));
});
try {
  if (operation === "fresh") {
    await assert.rejects(readFile(statePath), { code: "ENOENT" });
  } else if (operation !== "send") {
    const snapshot = await state();
    assert.equal(snapshot.initialized, true, "recovery requires initialized state");
  }
  await sender.validateIdentity();
  await sender.start();
  if (operation === "send") {
    const body = `startup-${randomBytes(8).toString("hex")}: Reply briefly with STARTUP_OK. Do not run tools.`;
    await sender.sendMessage({
      roomId: environment.roomId,
      inboundEventId: `$probe_${randomBytes(8).toString("hex")}`,
      responseKind: "agent",
      partNumber: 1,
      partCount: 1,
      transactionId: `probe_${randomBytes(12).toString("hex")}`,
      content: { msgtype: "m.text", body },
    });
    const deadline = Date.now() + 30_000;
    while (!events.some((event) => event.content.body === body) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    sent = events.find((event) => event.content.body === body);
    assert.ok(sent, "stopped-bridge input observed");
    await writePrivateFile(inputPath, JSON.stringify(sent));
  } else {
    pair = await startBridgePair(environment, {
      onPair: (started) => {
        pair = started;
      },
      onOutbound: (frame) => frames.push({ direction: "out", frame, phase, time: Date.now() }),
      onInbound: (frame) => frames.push({ direction: "in", frame, phase, time: Date.now() }),
    });
    if (operation === "catchup") {
      const input = JSON.parse(await readFile(inputPath, "utf8"));
      await waitFor(
        async () => {
          const snapshot = await state();
          return snapshot.completedEventIds[environment.roomId]?.includes(input.eventId);
        },
        "catch-up durable completion",
        120_000,
        pair,
      );
      const prompts = requests("session/prompt");
      assert.equal(prompts.length, 1, "only the controlled unseen input is recovered");
      assert.equal(prompts[0].frame.params.prompt.map((part) => part.text ?? "").join(""), input.content.body);
      assert.ok(
        frames.some(({ direction, frame }) => direction === "in" && frame.id === prompts[0].frame.id && frame.result),
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
    if (operation !== "catchup") assertSteeringBaseline(frames);
    const snapshot = await state();
    assert.equal(snapshot.initialized, true);
    assertSteeringHealthy(frames, events, environment.bridge.userId);
  }
  summary = {
    result: "passed",
    operation,
    prompts: requests("session/prompt").length,
    sessions: requests("session/new").length,
  };
} catch (error) {
  summary = { result: "failed", operation, errorClass: error.name };
  process.exitCode = 1;
} finally {
  await writePrivateFile(
    evidencePath,
    JSON.stringify({ phase, frames, events, sent, summary, stateBefore, stateAfter: await snapshot() }),
  );
  phase = "shutdown";
  try {
    if (pair) await stopBridgePair(pair);
  } catch (error) {
    summary = { result: "failed", operation, phase, errorClass: error.name };
    process.exitCode = 1;
  }
  await sender.stop();
  await writePrivateFile(
    evidencePath,
    JSON.stringify({
      phase,
      frames,
      events,
      sent,
      summary,
      stateBefore,
      stateAfter: await snapshot(),
      bridgeDiagnostics: pair?.bridgeDiagnostics(),
      acpDiagnostics: pair?.acpDiagnostics(),
    }),
  );
}
try {
  assertSteeringHealthy(frames, events, environment.bridge.userId);
} catch {
  summary = { result: "failed", operation, phase: "final health audit" };
  process.exitCode = 1;
}
console.log(JSON.stringify(summary));
process.exit(process.exitCode ?? 0);
