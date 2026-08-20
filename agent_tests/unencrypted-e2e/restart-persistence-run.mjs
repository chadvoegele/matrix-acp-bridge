#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  runSender as runSenderProcess,
  startBridgePair,
  stopBridgePair,
  parseDiagnostics,
  waitFor,
} from "../e2e-support/acp.mjs";
import {
  createRestartPersistenceObserver,
  describeLoadFailure,
} from "../e2e-support/restart-persistence-observer.mjs";
import { defaultEnvironmentPath, readEnvironment, testDir } from "./lib.mjs";

const environmentPath = process.argv[2] ?? defaultEnvironmentPath;
const environment = await readEnvironment(environmentPath);
const runId = randomBytes(12).toString("hex").toUpperCase();
const offlineCorrelation = randomBytes(12).toString("hex").toUpperCase();
const rememberedValue = `MATRIX_RESTART_MEMORY_${runId}`;
const acknowledgement = `MATRIX_RESTART_ACK_${runId}`;
const firstPrompt = `Remember this exact value for a later turn: ${rememberedValue}. Do not include the value in your response. Reply with exactly: ${acknowledgement}`;
const offlinePrompt = `For correlation ${offlineCorrelation}, return only the exact value I asked you to remember in the previous turn. Do not add punctuation, formatting, or explanation.`;
const statePath = join(environment.bridge.stateDir, "bridge-state.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function startPair() {
  const observer = createRestartPersistenceObserver({ statePath });
  const pair = await startBridgePair(environment, {
    onOutbound: observer.outbound,
    onInbound: observer.inbound,
  });
  return { ...pair, observer };
}

async function stopPair(pair) {
  await stopBridgePair(pair);
}

async function readState() {
  return JSON.parse(await readFile(statePath, "utf8"));
}

async function runSender(arguments_) {
  return runSenderProcess({
    environmentPath,
    senderPath: join(testDir, "sender.mjs"),
    args: arguments_,
    forwardStderr: false,
  });
}

function requests(pair, method) {
  return pair.observer.requests.filter((request) => request.method === method);
}

function promptText(request) {
  const parts = request.params?.prompt;
  return Array.isArray(parts) ? parts.find((part) => part?.type === "text")?.text : undefined;
}

function assertCleanDiagnostics(pair, requiredEvents) {
  const records = parseDiagnostics(pair.bridgeDiagnostics());
  for (const event of requiredEvents) assert(records.some((record) => record.event === event), `missing ${event} diagnostic`);
  const verified = records.findIndex((record) => record.event === "saved-sync-token-verified");
  const catchup = records.findIndex((record) => record.event === "catch-up-started");
  if (requiredEvents.includes("saved-sync-token-verified") && requiredEvents.includes("catch-up-started")) {
    assert(verified !== -1 && catchup !== -1 && verified < catchup,
      "saved-token verification must precede restart catch-up");
  }
  const failures = records.filter((record) => record.level === "error" ||
    /(?:failed|failure|protocol|lock)/u.test(String(record.event)));
  assert(failures.length === 0, `unexpected bridge diagnostics: ${failures.map((record) => record.event).join(", ")}`);
  assert(!/(?:private bridge state failure|state-checkpoint-failure|state-lock|acp[_ -]protocol)/iu.test(pair.bridgeDiagnostics()),
    "bridge stderr reported a state, lock, or ACP protocol failure");
}

let pair;
try {
  process.stdout.write("Starting initial bridge/ACP pair and memory turn...\n");
  pair = await startPair();
  assert(pair.observer.loadSession === true,
    "restart-persistence prerequisite failed: the configured ACP agent does not advertise loadSession");
  const firstExchange = await runSender(["--prompt", firstPrompt, "--expect", acknowledgement]);
  assert(firstExchange.event === "exchange-complete" && firstExchange.responseCount === 1,
    "initial exchange did not produce exactly one response");
  await waitFor(async () => {
    try {
      const state = await readState();
      return typeof state.cursor === "string" && typeof state.sessions?.[environment.roomId] === "string";
    } catch { return false; }
  }, "initial cursor and room mapping persistence", 30_000, pair);
  const firstState = await readState();
  const originalSessionId = firstState.sessions[environment.roomId];
  assert(requests(pair, "session/new").length === 1, "first run must issue exactly one session/new");
  assert(pair.observer.newSessionId === originalSessionId, "persisted room mapping does not match created ACP session");
  const firstPrompts = requests(pair, "session/prompt").filter((request) => promptText(request) === firstPrompt);
  assert(firstPrompts.length === 1, "initial prompt must reach ACP exactly once");
  assert(firstPrompts[0].params?.sessionId === originalSessionId, "initial prompt used the wrong ACP session");
  assert(pair.observer.stateAtPrompts[0]?.sessions?.[environment.roomId] === originalSessionId,
    "room mapping was not persisted before the initial prompt");
  assert(requests(pair, "session/new")[0].sequence < firstPrompts[0].sequence,
    "session/new must precede the initial prompt");
  assertCleanDiagnostics(pair, ["startup-ready", "first-cursor-established"]);
  await stopPair(pair);
  pair = undefined;

  process.stdout.write("Bridge is stopped; sending the offline Matrix event...\n");
  const offline = await runSender(["--mode", "send-only", "--prompt", offlinePrompt]);
  assert(offline.event === "prompt-sent" && offline.promptWireType === "m.room.message",
    "offline prompt was not sent as a top-level plaintext m.room.message");

  process.stdout.write("Restarting bridge/ACP pair from the saved cursor and session...\n");
  pair = await startPair();
  assert(pair.observer.loadSession === true,
    "restart-persistence prerequisite failed: the configured ACP agent no longer advertises loadSession");
  const watched = await runSender([
    "--mode", "watch", "--prompt", offlinePrompt, "--expect", rememberedValue,
    "--since", offline.syncCursor, "--prompt-event-id", offline.promptEventId,
  ]);
  assert(watched.event === "exchange-complete" && watched.responseCount === 1,
    "Matrix did not receive exactly one response to the offline event");
  assert(watched.responseWireType === "m.room.message",
    "offline response was not a top-level plaintext m.room.message");
  await waitFor(() => requests(pair, "session/prompt").some((request) => promptText(request) === offlinePrompt),
    "caught-up ACP prompt", 30_000, pair);
  await waitFor(() => pair.observer.loadOutcome !== undefined, "session/load response", 30_000, pair);
  const loads = requests(pair, "session/load");
  const news = requests(pair, "session/new");
  const caughtUp = requests(pair, "session/prompt").filter((request) => promptText(request) === offlinePrompt);
  process.stdout.write(`Restart ACP counts: session/load=${loads.length}, load-outcome=${pair.observer.loadOutcome.kind}, session/new=${news.length}, caught-up session/prompt=${caughtUp.length}.\n`);
  assert(loads.length === 1, `restart must issue exactly one session/load (observed ${loads.length})`);
  assert(loads[0].params?.sessionId === originalSessionId, "restart loaded a different ACP session");
  assert(pair.observer.loadOutcome.kind === "success", describeLoadFailure(pair.observer.loadOutcome));
  assert(news.length === 0, `restart issued ${news.length} replacement session/new request(s) after confirmed successful load`);
  assert(caughtUp.length === 1, `offline Matrix event must reach session/prompt exactly once (observed ${caughtUp.length})`);
  assert(caughtUp[0].params?.sessionId === originalSessionId, "caught-up prompt did not use the loaded session ID");
  assert(loads[0].sequence < caughtUp[0].sequence, "session/load must precede the caught-up prompt");
  await waitFor(async () => {
    const state = await readState();
    return state.cursor !== firstState.cursor;
  },
    "saved cursor advancement across restart", 30_000, pair);
  const restartState = await readState();
  assert(restartState.sessions?.[environment.roomId] === originalSessionId,
    "room mapping did not remain on the loaded ACP session");
  assertCleanDiagnostics(pair, ["saved-cursor-loaded", "saved-sync-token-verified", "catch-up-started", "catch-up-finished", "startup-ready"]);
  await stopPair(pair);
  pair = undefined;
  process.stdout.write("Restart-persistence Matrix E2E test passed.\n");
} finally {
  if (pair !== undefined) {
    await stopPair(pair).catch(() => {
      pair.bridge.kill("SIGKILL");
      pair.acp.kill("SIGKILL");
    });
  }
}
