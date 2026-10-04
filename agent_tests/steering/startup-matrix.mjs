#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createMatrixClientAdapter } from "../../dist/matrix-client.js";
import { renderMatrixText } from "../../dist/matrix-text-rendering.js";
import { startBridgePair, stopBridgePair, waitFor } from "../e2e-support/acp.mjs";
import { readEnvironment, readToken, writePrivateFile } from "../e2e-support/common.mjs";
import {
  assertSteeringBaseline,
  assertSteeringHealthy,
  selectEventsSinceInput,
} from "../e2e-support/steering-observations.mjs";

// The caller must hold the shared live lock and retain each state's session IDs
// for cleanup. This probe intentionally separates sending while stopped from
// startup, so initialized recovery cannot be confused with fresh suppression.
const [environmentPath, operation, evidencePath, inputPath] = process.argv.slice(2);
assert.ok(environmentPath && evidencePath);
assert.ok(["fresh", "quiet", "send", "catchup", "reset"].includes(operation));
const environment = await readEnvironment(environmentPath);
const frames = [];
const events = [];
let phase = "startup";
let pair;
let sent;
const resetInputs = [];
let summary;
let failure;
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
  if (operation === "reset") {
    const config = await readFile(environment.bridge.configFile, "utf8");
    assert.match(config, /^response_mode = "room"$/mu);
    assert.match(config, /^default_message_delivery = "steer"$/mu);
  }
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
    if (operation === "reset") {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
      assertSteeringBaseline(frames);
      const send = async (body) => {
        const eventId = await sender.sendHtmlMessage({
          roomId: environment.roomId,
          transactionId: `probe_${randomBytes(12).toString("hex")}`,
          ...renderMatrixText(body),
        });
        await waitFor(() => events.some((event) => event.eventId === eventId), "reset input observation", 30_000, pair);
        const event = events.find((event) => event.eventId === eventId);
        assert.equal(event.sender, environment.sender.userId);
        assert.equal(event.content.body, body);
        resetInputs.push(event);
        return event;
      };
      const complete = async (event) => {
        const snapshot = await state();
        return snapshot.completedEventIds[environment.roomId]?.includes(event.eventId);
      };
      const response = (request) =>
        frames.find(({ direction, frame }) => direction === "in" && frame.id === request.frame.id);
      const suffix = randomBytes(8).toString("hex");
      phase = "pending prompt before reset";
      const active = await send(
        `/prompt reset-active-${suffix}: Use bash to run exactly sleep 12, then reply briefly. Do not inspect files or run other tools.`,
      );
      await waitFor(
        () => frames.some(({ frame }) => frame.params?.update?.sessionUpdate === "tool_call"),
        "reset probe real tool start",
        120_000,
        pair,
      );
      assert.equal(requests("session/prompt").length, 1);
      assert.equal(response(requests("session/prompt")[0]), undefined);
      phase = "steering acknowledgement before reset";
      const injected = await send(`/steer reset-injected-${suffix}: Reply briefly after the tool finishes.`);
      await waitFor(
        () => requests("_session/steering").some((request) => response(request)?.frame.result?.outcome === "injected"),
        "reset probe injection acknowledgement",
        30_000,
        pair,
      );
      await waitFor(() => complete(injected), "reset probe injected durability", 30_000, pair);
      assert.equal(await complete(active), false);
      assert.equal(response(requests("session/prompt")[0]), undefined);
      phase = "queued reset barrier";
      await send("/reset");
      const payload = `reset-after-${suffix}: Reply briefly without tools.`;
      await send(payload);
      assert.equal(requests("session/prompt").length, 1);
      assert.equal(requests("_session/steering").length, 1);
      await waitFor(
        async () => {
          const completed = await Promise.all(resetInputs.map((event) => complete(event)));
          return completed.every(Boolean);
        },
        "reset probe all durable completions",
        120_000,
        pair,
      );
      await waitFor(
        () =>
          selectEventsSinceInput(events, resetInputs[0]).some(
            (event) => event.sender === environment.bridge.userId && event.content?.body === "Agent session reset.",
          ),
        "reset acknowledgement",
        30_000,
        pair,
      );
      const scenarioEvents = selectEventsSinceInput(events, resetInputs[0]);
      assert.equal(
        scenarioEvents.filter(
          (event) => event.sender === environment.bridge.userId && event.content?.body === "Agent session reset.",
        ).length,
        1,
      );
      const prompts = requests("session/prompt");
      assert.equal(prompts.length, 2);
      assert.ok(response(prompts[0])?.frame.result);
      assert.ok(response(prompts[1])?.frame.result);
      assert.notEqual(prompts[0].frame.params.sessionId, prompts[1].frame.params.sessionId);
      assert.equal(prompts[1].frame.params.prompt.map((part) => part.text ?? "").join(""), payload);
      assert.equal(requests("_session/steering").length, 1);
      assert.equal(requests("_session/steering")[0].frame.params.sessionId, prompts[0].frame.params.sessionId);
      assert.equal(requests("_session/steering")[0].frame.params._meta.steering.idleBehavior, "promptRequired");
      assert.equal(requests("session/new").length, 1);
      assert.equal(
        scenarioEvents.filter(
          (event) =>
            event.sender === environment.bridge.userId &&
            event.content?.body === "No running turn; message queued as a prompt.",
        ).length,
        0,
        "default-selected input behind reset stays silent",
      );
    }
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
    if (operation !== "catchup" && operation !== "reset") assertSteeringBaseline(frames);
    const snapshot = await state();
    assert.equal(snapshot.initialized, true);
    assertSteeringHealthy(frames, events, environment.bridge.userId);
  }
  summary = {
    result: "passed",
    operation,
    prompts: requests("session/prompt").length,
    sessions: requests("session/new").length,
    ...(operation === "reset" ? { sent: resetInputs.length, steering: requests("_session/steering").length } : {}),
  };
} catch (error) {
  failure = {
    message: error.message,
    stack: error.stack,
    actual: error.actual,
    expected: error.expected,
    operator: error.operator,
  };
  summary = { result: "failed", operation, errorClass: error.name };
  process.exitCode = 1;
} finally {
  await writePrivateFile(
    evidencePath,
    JSON.stringify({
      phase,
      frames,
      events,
      sent,
      resetInputs,
      summary,
      failure,
      stateBefore,
      stateAfter: await snapshot(),
    }),
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
      resetInputs,
      summary,
      failure,
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
