#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";

import {
  jsonLineTap,
  parseDiagnostics,
  runSender as runSenderProcess,
  startBridgePair,
  stopBridgePair,
  waitFor,
} from "../e2e-support/acp.mjs";
import { defaultEnvironmentPath, readEnvironment, repoRoot, testDir } from "./lib.mjs";

const environmentPath = process.argv[2] ?? defaultEnvironmentPath;
const environment = await readEnvironment(environmentPath);
const runId = randomBytes(12).toString("hex").toUpperCase();
const completedReply = `MATRIX_COMPLETED_ID_FIRST_${runId}`;
const retryReply = `MATRIX_COMPLETED_ID_RETRY_${runId}`;
const completedPrompt = `Reply with exactly ${completedReply} and no other text.`;
const retryPrompt = `Reply with exactly ${retryReply} and no other text.`;
const statePath = join(environment.bridge.stateDir, "bridge-state.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function promptText(message) {
  const parts = message?.params?.prompt;
  return Array.isArray(parts) ? parts.find((part) => part?.type === "text")?.text : undefined;
}

function protocolObserver() {
  const requests = [];
  const pending = new Map();
  let loadSession;
  let sequence = 0;
  return {
    outbound(message, forwarded = true) {
      if (typeof message?.method !== "string") return;
      const request = {
        sequence: sequence++,
        method: message.method,
        params: message.params,
        forwarded,
      };
      requests.push(request);
      if (forwarded && message.id !== undefined) pending.set(message.id, request);
    },
    inbound(message) {
      const request = pending.get(message?.id);
      if (request === undefined) return;
      pending.delete(message.id);
      if (request.method === "initialize") {
        loadSession = message.result?.agentCapabilities?.loadSession === true;
      }
    },
    requests,
    get loadSession() { return loadSession; },
  };
}

function outboundGate(blockedPrompt, observer, status) {
  let pending = "";
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      let forwarded = "";
      for (const line of lines) {
        let message;
        try { message = JSON.parse(line); } catch { /* Forward malformed data unchanged. */ }
        const block = !status.blocked && message?.method === "session/prompt" &&
          promptText(message) === blockedPrompt;
        if (message !== undefined) observer.outbound(message, !block);
        if (block) status.blocked = true;
        else forwarded += `${line}\n`;
      }
      callback(null, forwarded);
    },
    flush(callback) {
      callback(null, pending);
    },
  });
}

function childExited(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", resolve);
  });
}

async function startObservedPair({ blockPrompt } = {}) {
  const observer = protocolObserver();
  if (blockPrompt === undefined) {
    const pair = await startBridgePair(environment, {
      onOutbound: observer.outbound,
      onInbound: observer.inbound,
    });
    return { ...pair, observer, gateStatus: { blocked: false } };
  }

  const [acpProgram, ...acpArguments] = environment.acpCommand;
  const acp = spawn(acpProgram, acpArguments, { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
  const bridge = spawn(
    process.execPath,
    [join(repoRoot, "dist/main.js"), "--config", environment.bridge.configFile],
    { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] },
  );
  const gateStatus = { blocked: false };
  bridge.stdout.pipe(outboundGate(blockPrompt, observer, gateStatus)).pipe(acp.stdin);
  acp.stdout.pipe(jsonLineTap(observer.inbound)).pipe(bridge.stdin);
  let bridgeDiagnostics = "";
  let acpDiagnostics = "";
  bridge.stderr.on("data", (chunk) => { bridgeDiagnostics += chunk.toString("utf8"); });
  acp.stderr.on("data", (chunk) => { acpDiagnostics += chunk.toString("utf8"); });
  const pair = {
    acp,
    bridge,
    bridgeDiagnostics: () => bridgeDiagnostics,
    acpDiagnostics: () => acpDiagnostics,
    observer,
    gateStatus,
  };
  await waitFor(() => bridgeDiagnostics.includes("startup-ready"), "bridge startup-ready", 120_000, pair);
  return pair;
}

async function crashPair(pair) {
  if (pair.bridge.exitCode === null && pair.bridge.signalCode === null) pair.bridge.kill("SIGKILL");
  await childExited(pair.bridge);
  if (pair.acp.exitCode === null && pair.acp.signalCode === null) pair.acp.kill("SIGTERM");
  await childExited(pair.acp);
}

async function readState() {
  return JSON.parse(await readFile(statePath, "utf8"));
}

function assertCurrentState(state, label) {
  assert(state.initialized === true, `${label} state is not initialized`);
  assert(Object.hasOwn(state, "cursor") === false, `${label} state contains a legacy cursor`);
  assert(Object.hasOwn(state, "pendingBatches") === false, `${label} state contains legacy pending batches`);
  const ids = state.completedEventIds?.[environment.roomId];
  assert(Array.isArray(ids) && new Set(ids).size === ids.length,
    `${label} completed-event ledger is invalid`);
  assert(ids.length <= 100, `${label} completed-event ledger is not bounded`);
  return ids;
}

async function runSender(arguments_) {
  return runSenderProcess({
    environmentPath,
    senderPath: join(testDir, "sender.mjs"),
    args: arguments_,
    forwardStderr: false,
  });
}

function matchingPrompts(pair, text, forwarded) {
  return pair.observer.requests.filter((request) => request.method === "session/prompt" &&
    promptText(request) === text && (forwarded === undefined || request.forwarded === forwarded));
}

function assertCleanDiagnostics(pair, requiredEvents) {
  const records = parseDiagnostics(pair.bridgeDiagnostics());
  for (const event of requiredEvents) {
    assert(records.some((record) => record.event === event), `missing ${event} diagnostic`);
  }
  const failures = records.filter((record) => record.level === "error" ||
    /(?:failed|failure|protocol|lock)/u.test(String(record.event)));
  assert(failures.length === 0,
    `unexpected bridge diagnostics: ${failures.map((record) => record.event).join(", ")}`);
}

let pair;
try {
  process.stdout.write("Establishing a normal initial-sync completed-ID baseline...\n");
  pair = await startObservedPair();
  assert(pair.observer.loadSession === true,
    "completed-ID recovery requires ACP loadSession support");
  const first = await runSender(["--prompt", completedPrompt, "--expect", completedReply]);
  assert(first.event === "exchange-complete" && first.responseCount === 1,
    "completed baseline prompt did not receive exactly one response");
  await waitFor(async () => {
    const state = await readState();
    const ids = state.completedEventIds?.[environment.roomId] ?? [];
    return ids.includes(first.promptEventId);
  }, "completed baseline event", 30_000, pair);
  assert(matchingPrompts(pair, completedPrompt).length === 1,
    "baseline prompt did not reach ACP exactly once");
  assertCurrentState(await readState(), "baseline");
  await stopBridgePair(pair);
  pair = undefined;

  process.stdout.write("Sending an event while the bridge is stopped...\n");
  const retry = await runSender(["--mode", "send-only", "--prompt", retryPrompt]);
  assert(retry.event === "prompt-sent" && retry.promptWireType === "m.room.message",
    "retry event was not sent as plaintext Matrix text");

  process.stdout.write("Holding the unseen event before ACP, then simulating interruption...\n");
  pair = await startObservedPair({ blockPrompt: retryPrompt });
  await waitFor(() => pair.gateStatus.blocked, "unseen event ACP gate", 120_000, pair);
  assert(matchingPrompts(pair, completedPrompt).length === 0,
    "completed initial-sync event was submitted during recovery");
  assert(matchingPrompts(pair, retryPrompt, false).length === 1,
    "unseen initial-sync event was not held before ACP");
  const heldState = await readState();
  const heldIds = assertCurrentState(heldState, "held");
  assert(heldIds.includes(first.promptEventId), "completed ID was lost before interruption");
  assert(!heldIds.includes(retry.promptEventId), "interrupted event was marked completed before ACP");
  await crashPair(pair);
  pair = undefined;

  process.stdout.write("Restarting and requiring only the incomplete event...\n");
  pair = await startObservedPair();
  const watched = await runSender([
    "--mode", "watch", "--prompt", retryPrompt, "--expect", retryReply,
    "--since", retry.syncCursor, "--prompt-event-id", retry.promptEventId,
  ]);
  assert(watched.event === "exchange-complete" && watched.responseCount === 1,
    "interrupted event did not receive exactly one response after retry");
  await waitFor(() => matchingPrompts(pair, retryPrompt).length === 1,
    "retried ACP prompt", 30_000, pair);
  assert(matchingPrompts(pair, completedPrompt).length === 0,
    "completed event was submitted to ACP again after restart");
  await waitFor(async () => {
    const state = await readState();
    const ids = state.completedEventIds?.[environment.roomId] ?? [];
    return ids.includes(retry.promptEventId);
  }, "retried event completion", 30_000, pair);
  const finalIds = assertCurrentState(await readState(), "final");
  assert(finalIds.includes(first.promptEventId), "completed event was removed from the recovery ledger too early");
  assert(finalIds.includes(retry.promptEventId), "retried event was not durably completed");
  assertCleanDiagnostics(pair, [
    "completed-event-ledger-loaded",
    "initial-sync-recovery-finished",
    "startup-ready",
  ]);
  await stopBridgePair(pair);
  pair = undefined;
  process.stdout.write("Completed-ID recovery Matrix E2E test passed with normal initial sync.\n");
} finally {
  if (pair !== undefined) {
    await stopBridgePair(pair).catch(() => {
      pair.bridge.kill("SIGKILL");
      pair.acp.kill("SIGKILL");
    });
  }
}
