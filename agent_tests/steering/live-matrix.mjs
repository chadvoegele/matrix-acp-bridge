#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createMatrixClientAdapter } from "../../dist/matrix-client.js";
import { startBridgePair, stopBridgePair, waitFor } from "../e2e-support/acp.mjs";
import { readEnvironment, readToken, writePrivateFile } from "../e2e-support/common.mjs";
import {
  assertSteeringBaseline,
  assertSteeringHealthy,
  assertSteeringDeviceBaseline,
} from "../e2e-support/steering-observations.mjs";
import { cryptoPaths } from "../encrypted-e2e/lib.mjs";

// Opt-in: use only environments provisioned for the documented test rooms.
const [environmentPath, transport = "plaintext", responseMode = "room"] = process.argv.slice(2);
assert.ok(environmentPath, "Usage: live-matrix.mjs <environment.json> <plaintext|encrypted> <room|thread>");
assert.ok(["plaintext", "encrypted"].includes(transport));
assert.ok(["room", "thread"].includes(responseMode));
const environment = await readEnvironment(environmentPath);
const evidencePath = resolve(process.env.STEERING_EVIDENCE_FILE ?? "node_modules/.live-steering/evidence.json");
// State replacement alone does not reset the homeserver's device sync baseline.
// Refuse accidental mode/state transitions before any live account operation.
const deviceBaselinePath = resolve(dirname(environment.bridge.tokenFile), "steering-device-baseline.json");
const deviceBaseline = {
  version: 1,
  homeserver: environment.homeserver,
  userId: environment.bridge.userId,
  deviceId: environment.bridge.deviceId,
  stateDir: resolve(environment.bridge.stateDir),
  responseMode,
};
let previousDeviceBaseline = null;
try {
  previousDeviceBaseline = JSON.parse(await readFile(deviceBaselinePath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
assertSteeringDeviceBaseline(previousDeviceBaseline, deviceBaseline);
await writePrivateFile(deviceBaselinePath, JSON.stringify(deviceBaseline));
const config = await readFile(environment.bridge.configFile, "utf8");
await writePrivateFile(
  environment.bridge.configFile,
  config
    .replaceAll(/^default_message_delivery = .*\n/gmu, "")
    .replace(/response_mode = "(?:room|thread)"/u, `response_mode = "${responseMode}"`)
    .replace("[matrix]", '[matrix]\ndefault_message_delivery = "steer"'),
);
const sender = createMatrixClientAdapter(
  {
    homeserver: environment.homeserver,
    userId: environment.sender.userId,
    deviceId: environment.sender.deviceId,
    accessTokenFile: environment.sender.tokenFile,
    allowedRooms: [environment.roomId],
    allowedSenders: [environment.bridge.userId],
    encryption: transport === "encrypted" ? "required" : "disabled",
    responseMode: "room",
  },
  await readToken(environment.sender.tokenFile),
);
const statePath = resolve(environment.bridge.stateDir, "bridge-state.json");

async function snapshot() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const stateBefore = await snapshot();
const frames = [];
const events = [];
const sent = [];
let pair;
let successSummary;
let failure;
let phase = "startup";
const pending = new Map();
const completed = [];
const activeText = new Map();
const agentOutputs = [];
const suffix = randomBytes(6).toString("hex");
const check = async (predicate, label, timeout = 180_000) => {
  await waitFor(predicate, label, timeout, pair);
};

function outbound(frame) {
  frames.push({ direction: "out", frame, phase, time: Date.now() });
  if (frame.method) console.log(JSON.stringify({ rpc: frame.method }));
  if (frame.method === "session/prompt" || frame.method === "_session/steering") pending.set(frame.id, frame);
  if (frame.method === "session/prompt") activeText.set(frame.params.sessionId, { id: frame.id, text: "" });
}

function inbound(frame) {
  frames.push({ direction: "in", frame, phase, time: Date.now() });
  const update = frame.params?.update;
  if (
    update?.sessionUpdate === "tool_call" ||
    (update?.sessionUpdate === "agent_thought_chunk" && update.content?.text?.trim())
  ) {
    const active = activeText.get(frame.params.sessionId);
    if (active?.text.trim()) {
      agentOutputs.push({ sessionId: frame.params.sessionId, text: active.text.trim() });
      active.text = "";
    }
  }
  if (frame.params?.update?.sessionUpdate === "agent_message_chunk") {
    const active = activeText.get(frame.params.sessionId);
    if (active) active.text += frame.params.update.content?.text ?? "";
  }
  for (const [sessionId, active] of activeText) {
    if (frame.id === active.id) {
      if (active.text.trim()) agentOutputs.push({ sessionId, text: active.text.trim() });
      activeText.delete(sessionId);
    }
  }
  if (pending.has(frame.id)) {
    completed.push({ request: pending.get(frame.id), response: frame });
    console.log(
      JSON.stringify({
        rpcResult: pending.get(frame.id).method,
        outcome: frame.result?.outcome,
        errorCode: frame.error?.code,
      }),
    );
    pending.delete(frame.id);
  }
}

const requests = (method) => frames.filter(({ direction, frame }) => direction === "out" && frame.method === method);
const text = (frame) => frame.params?.prompt?.map((part) => part.text ?? "").join("");
const promptText = (label) => `${label}-${suffix}: Reply briefly with ${label}-${suffix}.`;
const slowText = (label) =>
  `${label}-${suffix}: Use bash to run exactly sleep 12, then reply briefly. Do not inspect files or run other tools.`;

async function send(body, root) {
  await sender.sendMessage({
    roomId: environment.roomId,
    inboundEventId: `$live_${randomBytes(8).toString("hex")}`,
    responseKind: "agent",
    partNumber: 1,
    partCount: 1,
    transactionId: `live_${randomBytes(12).toString("hex")}`,
    content: { msgtype: "m.text", body },
    ...(root ? { threadRootEventId: root, threadInReplyToEventId: root } : {}),
  });
  await check(
    () => events.some((event) => event.sender === environment.sender.userId && event.content?.body === body),
    "sent event observation",
  );
  const event = events.find((item) => item.sender === environment.sender.userId && item.content?.body === body);
  sent.push(event);
  return event.eventId;
}

async function drained(count) {
  await check(
    () => completed.filter(({ request }) => request.method === "session/prompt").length === count,
    "prompt completion",
  );
  await check(async () => {
    const state = JSON.parse(await readFile(resolve(environment.bridge.stateDir, "bridge-state.json"), "utf8"));
    return state.completedEventIds[environment.roomId]?.includes(sent.at(-1).eventId);
  }, "durable event completion");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
}

async function toolAfter(index) {
  await check(
    () => frames.slice(index).some(({ frame }) => frame.params?.update?.sessionUpdate === "tool_call"),
    "real Pi tool start",
  );
  assert.ok([...pending.values()].some((frame) => frame.method === "session/prompt"));
}

try {
  await sender.validateIdentity();
  if (transport === "encrypted") await sender.initializeCrypto(cryptoPaths(environment.sender.stateDir));
  sender.onSyncBatch((batch) => {
    if (batch.phase === "initial") return;
    for (const room of batch.rooms) if (room.roomId === environment.roomId) events.push(...room.timeline);
  });
  await sender.start();
  pair = await startBridgePair(environment, {
    onOutbound: outbound,
    onInbound: inbound,
    onPair: (started) => {
      pair = started;
    },
  });
  const initialized = frames.find(({ direction, frame }) => direction === "in" && frame.result?.agentCapabilities);
  assert.equal(initialized?.frame.result?._meta?.steering?.supported, true);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
  assertSteeringBaseline(frames);
  assertSteeringHealthy(frames, events, environment.bridge.userId);

  phase = "active steer and explicit prompt FIFO";
  let index = frames.length;
  const root = await send(`/prompt ${slowText("active")}`);
  await toolAfter(index);
  const conversation = responseMode === "thread" ? root : undefined;
  await send(`/prompt ${promptText("fifo1")}`, conversation);
  await send(`/prompt ${promptText("fifo2")}`, conversation);
  await send(`/steer ${promptText("injected")}`, conversation);
  await check(
    () =>
      completed.some(
        ({ request, response }) => request.method === "_session/steering" && response.result?.outcome === "injected",
      ),
    "injected wire result",
  );
  assert.equal(requests("session/prompt").length, 1);
  assert.ok([...pending.values()].some((frame) => frame.method === "session/prompt"));
  await check(async () => {
    const state = JSON.parse(await readFile(resolve(environment.bridge.stateDir, "bridge-state.json"), "utf8"));
    const ids = state.completedEventIds[environment.roomId];
    return ids.includes(sent.at(-1).eventId) && !ids.includes(root);
  }, "injected event durable while original prompt pending");
  await drained(3);
  assert.deepEqual(
    requests("session/prompt")
      .slice(1)
      .map(({ frame }) => text(frame)),
    [promptText("fifo1"), promptText("fifo2")],
  );

  phase = "idle steer tracked fallback";
  await send(`/steer ${promptText("idle")}`, conversation);
  await drained(4);
  assert.equal(text(requests("session/prompt")[3].frame), promptText("idle"));

  phase = "default steer first prompt then serial injection";
  index = frames.length;
  const batchRoot = await send(slowText("msg1"), conversation);
  await toolAfter(index);
  const batchConversation = responseMode === "thread" ? (conversation ?? batchRoot) : undefined;
  await send(promptText("msg2"), batchConversation);
  await send(promptText("msg3"), batchConversation);
  await check(
    () => completed.filter(({ request }) => request.method === "_session/steering").length === 3,
    "serial steering results",
  );
  assert.equal(requests("session/prompt").length, 5);
  const steering = completed.filter(({ request }) => request.method === "_session/steering");
  assert.deepEqual(
    steering.map(({ request }) => text(request)),
    [promptText("injected"), promptText("msg2"), promptText("msg3")],
  );
  for (const { request, response } of steering) {
    assert.equal(response.result.outcome, "injected");
    assert.equal(request.params.sessionId, requests("session/prompt")[0].frame.params.sessionId);
    assert.equal(request.params._meta.steering.idleBehavior, "promptRequired");
    assert.equal(response.error, undefined);
  }
  for (let position = 1; position < steering.length; position += 1) {
    const previousResult = frames.findIndex(
      ({ direction, frame }) => direction === "in" && frame.id === steering[position - 1].response.id,
    );
    const nextRequest = frames.findIndex(
      ({ direction, frame }) => direction === "out" && frame.id === steering[position].request.id,
    );
    assert.ok(previousResult < nextRequest, "steering RPCs overlapped or reordered");
  }
  await drained(5);

  if (responseMode === "thread") {
    phase = "independent top-level thread";
    await send(`/steer ${promptText("independent")}`);
    await drained(6);
    assert.equal(requests("session/new").length, 2);
    assert.notEqual(
      requests("session/prompt")[0].frame.params.sessionId,
      requests("session/prompt")[5].frame.params.sessionId,
    );
  }

  phase = "Matrix output and encrypted wire verification";
  const replies = events.filter(
    (event) =>
      event.sender === environment.bridge.userId &&
      event.content?.msgtype === "m.text" &&
      event.originServerTs >= sent[0].originServerTs,
  );
  assert.ok(replies.length > 0);
  assert.equal(
    replies.filter((event) => event.content.body === "No running turn; message queued as a prompt.").length,
    responseMode === "thread" ? 2 : 1,
  );
  for (const output of agentOutputs) {
    assert.ok(output.text.length > 0, "real agent produced no reply");
    const rootEvent =
      responseMode === "thread"
        ? sent.find((event) => {
            const payload = event.content.body.replace(/^\/(?:prompt|steer)\s+/u, "");
            const request = requests("session/prompt").find(({ frame }) => text(frame) === payload);
            return request?.frame.params.sessionId === output.sessionId;
          })
        : undefined;
    const matches = replies.filter(
      (event) =>
        event.content.body === output.text &&
        (responseMode !== "thread" || event.content["m.relates_to"]?.event_id === rootEvent.eventId),
    );
    const expectedCount = agentOutputs.filter(
      (item) => item.text === output.text && (responseMode !== "thread" || item.sessionId === output.sessionId),
    ).length;
    assert.equal(matches.length, expectedCount, "agent reply missing, duplicated, or routed to another thread");
  }
  for (const event of replies) {
    assert.ok(
      agentOutputs.some((output) => output.text === event.content.body) ||
        event.content.body === "No running turn; message queued as a prompt." ||
        /🔧|💭/u.test(event.content.formatted_body ?? ""),
      "unexpected Matrix notice or output",
    );
  }
  const promptRequests = requests("session/prompt");
  for (const request of promptRequests) {
    const result = completed.find((entry) => entry.request.id === request.frame.id);
    assert.ok(result && !result.response.error, "real prompt returned an ACP error");
  }
  assert.equal(
    replies.filter((event) =>
      /steering.*(?:injected|accepted)|(?:injected|accepted).*steering/iu.test(event.content.body),
    ).length,
    0,
  );
  for (const event of replies) {
    const relation = event.content?.["m.relates_to"];
    const content = event.content?.["m.new_content"] ?? event.content;
    if (responseMode === "thread") assert.ok(sent.some((item) => item.eventId === content["m.relates_to"]?.event_id));
    if (transport === "encrypted") assert.equal(event.isDecrypted, true);
    assert.ok(relation === undefined || typeof relation === "object");
  }
  if (transport === "encrypted") {
    const token = await readToken(environment.sender.tokenFile);
    for (const event of [...sent, ...replies]) {
      const response = await fetch(
        `${environment.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(environment.roomId)}/event/${encodeURIComponent(event.eventId)}`,
        { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
      );
      assert.equal(response.ok, true);
      const rawEvent = await response.json();
      assert.equal(rawEvent.type, "m.room.encrypted");
    }
  }
  successSummary = {
    result: "passed",
    transport,
    responseMode,
    sent: sent.length,
    replies: replies.length,
    prompts: requests("session/prompt").length,
    steering: requests("_session/steering").length,
    sessions: requests("session/new").length,
  };
} catch (error) {
  failure = {
    message: error.message,
    stack: error.stack,
    actual: error.actual,
    expected: error.expected,
    operator: error.operator,
  };
  console.log(
    JSON.stringify({
      result: "failed",
      transport,
      responseMode,
      phase,
      errorClass: error.name,
      prompts: requests("session/prompt").length,
      steering: requests("_session/steering").length,
    }),
  );
  process.exitCode = 1;
} finally {
  await writePrivateFile(
    evidencePath,
    `${JSON.stringify({ phase, frames, sent, events, failure, stateBefore, stateAfter: await snapshot() }, null, 2)}\n`,
  );
  phase = "shutdown";
  try {
    if (pair) await stopBridgePair(pair);
  } catch {
    successSummary = undefined;
    process.exitCode = 1;
    console.log(JSON.stringify({ result: "failed", phase: "shutdown" }));
  }
  console.log(JSON.stringify({ cleanup: "bridge and ACP stopped" }));
  await sender.stop().catch(() => {});
  await sender.closeCrypto().catch(() => {});
  console.log(JSON.stringify({ cleanup: "sender stopped" }));
  await writePrivateFile(
    evidencePath,
    `${JSON.stringify({ phase, frames, sent, events, failure, stateBefore, stateAfter: await snapshot(), bridgeDiagnostics: pair?.bridgeDiagnostics(), acpDiagnostics: pair?.acpDiagnostics() }, null, 2)}\n`,
  );
}

if (successSummary) {
  try {
    assertSteeringHealthy(frames, events, environment.bridge.userId);
    console.log(JSON.stringify(successSummary));
  } catch {
    console.log(JSON.stringify({ result: "failed", phase: "final health audit" }));
    process.exitCode = 1;
  }
}

// Matrix SDK background timers can outlive a stopped client. All child exits and
// crypto persistence have been awaited above before ending this test process.
process.exit(process.exitCode ?? 0);
