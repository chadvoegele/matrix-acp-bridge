#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  parseDiagnostics,
  runSender as runSenderProcess,
  startBridgePair,
  stopBridgePair,
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
const rememberedValue = `MATRIX_RESTART_MEMORY_${runId}`;
const firstAcknowledgement = `MATRIX_RESTART_ACK_${runId}`;
const firstPrompt = `Remember this exact value for a later turn: ${rememberedValue}. Do not include the value in your response. Reply with exactly: ${firstAcknowledgement}`;
const offlinePrompt = `Return only the exact value I asked you to remember in the previous turn for run ${runId}.`;
const statePath = join(environment.bridge.stateDir, "bridge-state.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readState() {
  return JSON.parse(await readFile(statePath, "utf8"));
}

async function startPair() {
  const observer = createRestartPersistenceObserver({ statePath });
  const pair = await startBridgePair(environment, {
    onOutbound: observer.outbound,
    onInbound: observer.inbound,
  });
  return { ...pair, observer };
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

function assertSchemaV12State(state, label) {
  assert(state.initialized === true, `${label} state is not initialized`);
  assert(Object.hasOwn(state, "cursor") === false, `${label} state contains a legacy cursor`);
  assert(Object.hasOwn(state, "pendingBatches") === false, `${label} state contains legacy pending batches`);
  assert(state.completedEventIds !== null && typeof state.completedEventIds === "object",
    `${label} state has no completed-event ledger`);
  for (const ids of Object.values(state.completedEventIds)) {
    assert(Array.isArray(ids) && new Set(ids).size === ids.length,
      `${label} completed-event ledger is not unique`);
  }
}

function assertCleanDiagnostics(pair, requiredEvents, forbiddenEvents = []) {
  const records = parseDiagnostics(pair.bridgeDiagnostics());
  for (const event of requiredEvents) {
    assert(records.some((record) => record.event === event), `missing ${event} diagnostic`);
  }
  for (const event of forbiddenEvents) {
    assert(!records.some((record) => record.event === event), `unexpected ${event} diagnostic`);
  }
  const failures = records.filter((record) => record.level === "error" ||
    /(?:failed|failure|protocol|lock)/u.test(String(record.event)));
  assert(failures.length === 0,
    `unexpected bridge diagnostics: ${failures.map((record) => record.event).join(", ")}`);
  assert(!/(?:private bridge state failure|state-checkpoint-failure|state-lock|acp[_ -]protocol)/iu.test(pair.bridgeDiagnostics()),
    "bridge stderr reported a state, lock, or ACP protocol failure");
}

function matchingPrompts(pair, text) {
  return requests(pair, "session/prompt").filter((request) => promptText(request) === text);
}

let pair;
try {
  process.stdout.write("Starting normal initial sync and first memory turn...\n");
  pair = await startPair();
  assert(pair.observer.loadSession === true,
    "restart-persistence prerequisite failed: the configured ACP agent does not advertise loadSession");
  const firstExchange = await runSender(["--prompt", firstPrompt, "--expect", firstAcknowledgement]);
  assert(firstExchange.event === "exchange-complete" && firstExchange.responseCount === 1,
    "initial exchange did not produce exactly one response");
  await waitFor(async () => {
    try {
      const state = await readState();
      return state.initialized === true && typeof state.sessions?.[environment.roomId] === "string";
    } catch { return false; }
  }, "initial completed-ID state and room mapping", 30_000, pair);
  const firstState = await readState();
  assertSchemaV12State(firstState, "initial");
  const originalSessionId = firstState.sessions[environment.roomId];
  assert(firstState.completedEventIds[environment.roomId]?.includes(firstExchange.promptEventId),
    "the first prompt was not durably completed");
  assert(requests(pair, "session/new").length === 1, "first run must issue exactly one session/new");
  assert(pair.observer.newSessionId === originalSessionId, "persisted room mapping does not match created ACP session");
  assert(matchingPrompts(pair, firstPrompt).length === 1, "initial prompt must reach ACP exactly once");
  assertCleanDiagnostics(pair, [
    "completed-event-baseline-established",
    "startup-ready",
  ], ["completed-event-ledger-loaded"]);
  await stopBridgePair(pair);
  pair = undefined;

  process.stdout.write("Bridge is stopped; sending one offline Matrix event...\n");
  const offline = await runSender(["--mode", "send-only", "--prompt", offlinePrompt]);
  assert(offline.event === "prompt-sent" && offline.promptWireType === "m.room.message",
    "offline prompt was not sent as a top-level plaintext m.room.message");

  process.stdout.write("Restarting with normal initial sync and the completed-ID ledger...\n");
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
  await waitFor(() => matchingPrompts(pair, offlinePrompt).length === 1,
    "one caught-up ACP prompt", 30_000, pair);
  await waitFor(() => pair.observer.loadOutcome !== undefined, "session/load response", 30_000, pair);

  const loads = requests(pair, "session/load");
  const news = requests(pair, "session/new");
  const caughtUp = matchingPrompts(pair, offlinePrompt);
  const replayedCompleted = matchingPrompts(pair, firstPrompt);
  assert(loads.length === 1, `restart must issue exactly one session/load (observed ${loads.length})`);
  assert(loads[0].params?.sessionId === originalSessionId, "restart loaded a different ACP session");
  assert(pair.observer.loadOutcome.kind === "success", describeLoadFailure(pair.observer.loadOutcome));
  assert(news.length === 0, `restart issued ${news.length} replacement session/new request(s)`);
  assert(caughtUp.length === 1, `offline Matrix event must reach ACP exactly once (observed ${caughtUp.length})`);
  assert(replayedCompleted.length === 0, "completed initial-sync event was submitted to ACP again");
  assert(loads[0].sequence < caughtUp[0].sequence, "session/load must precede the caught-up prompt");

  await waitFor(async () => {
    const state = await readState();
    return state.completedEventIds?.[environment.roomId]?.includes(offline.promptEventId) === true;
  }, "offline event completion", 30_000, pair);
  const restartState = await readState();
  assertSchemaV12State(restartState, "restart");
  assert(restartState.sessions?.[environment.roomId] === originalSessionId,
    "room mapping did not remain on the loaded ACP session");
  const completedIds = restartState.completedEventIds[environment.roomId] ?? [];
  assert(completedIds.includes(firstExchange.promptEventId), "completed first ID was compacted before suppression");
  assert(completedIds.includes(offline.promptEventId), "offline ID was not retained after completion");
  assert(completedIds.length <= 100, `completed-ID ledger exceeded initial-sync bound: ${completedIds.length}`);
  assertCleanDiagnostics(pair, [
    "completed-event-ledger-loaded",
    "initial-sync-recovery-finished",
    "startup-ready",
  ]);
  await stopBridgePair(pair);
  pair = undefined;
  process.stdout.write("Restart-persistence Matrix E2E test passed with normal initial-sync recovery.\n");
} finally {
  if (pair !== undefined) {
    await stopBridgePair(pair).catch(() => {
      pair.bridge.kill("SIGKILL");
      pair.acp.kill("SIGKILL");
    });
  }
}
