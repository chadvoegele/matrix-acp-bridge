#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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
import {
  defaultEnvironmentPath,
  readEnvironment,
  readToken,
  repoRoot,
  testDir,
} from "./lib.mjs";
import {
  normalizeEarlyCursorState,
  plaintextSenderEventIds,
} from "./early-cursor-fixture.mjs";

const environmentPath = process.argv[2] ?? defaultEnvironmentPath;
const environment = await readEnvironment(environmentPath);
const runId = randomBytes(12).toString("hex").toUpperCase();
const firstReply = `MATRIX_EARLY_CURSOR_FIRST_${runId}`;
const secondReply = `MATRIX_EARLY_CURSOR_SECOND_${runId}`;
const probeReply = `MATRIX_EARLY_CURSOR_PROBE_${runId}`;
const firstPrompt = `Reply with exactly ${firstReply} and no other text.`;
const secondPrompt = `Reply with exactly ${secondReply} and no other text.`;
const probePrompt = `Reply with exactly ${probeReply} and no other text.`;
const statePath = join(environment.bridge.stateDir, "bridge-state.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function promptText(message) {
  const parts = message?.params?.prompt;
  return Array.isArray(parts)
    ? parts.find((part) => part?.type === "text")?.text
    : undefined;
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
        if (block) {
          status.blocked = true;
        } else {
          forwarded += `${line}\n`;
        }
      }
      callback(null, forwarded);
    },
    flush(callback) {
      callback(null, pending);
    },
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
  await waitFor(
    () => bridgeDiagnostics.includes("startup-ready"),
    "bridge startup-ready",
    120_000,
    pair,
  );
  return pair;
}

async function crashPair(pair) {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- helper closes over no outer state but is local to teardown
  const exited = (child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", resolve);
  });
  if (pair.bridge.exitCode === null && pair.bridge.signalCode === null) pair.bridge.kill("SIGKILL");
  await exited(pair.bridge);
  if (pair.acp.exitCode === null && pair.acp.signalCode === null) pair.acp.kill("SIGTERM");
  await exited(pair.acp);
}

async function readState() {
  return JSON.parse(await readFile(statePath, "utf8"));
}

async function configureRecoveryCapacity() {
  const config = await readFile(environment.bridge.configFile, "utf8");
  const limitsHeader = "[limits]\n";
  assert(config.includes(limitsHeader), "test bridge config has no limits section");
  const configured = config.replace(
    limitsHeader,
    `${limitsHeader}max_queued_turns_per_room = 31\nmax_catchup_events_per_room = 32\n`,
  );
  await writeFile(environment.bridge.configFile, configured, "utf8");
}

async function runSender(arguments_) {
  return runSenderProcess({
    environmentPath,
    senderPath: join(testDir, "sender.mjs"),
    args: arguments_,
    forwardStderr: false,
  });
}

async function settleInitialCursor(state) {
  const token = await readToken(environment.bridge.tokenFile);
  let cursor = state.cursor;
  let quietSince = Date.now();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const query = new URLSearchParams({ timeout: "1000", since: cursor });
    const response = await fetch(
      `${environment.homeserver}/_matrix/client/v3/sync?${query}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) throw new Error(`Matrix cursor settling failed: HTTP ${response.status}`);
    const body = await response.json();
    assert(typeof body.next_batch === "string", "Matrix cursor settling returned no cursor");
    const timeline = body.rooms?.join?.[environment.roomId]?.timeline;
    if (timeline?.limited === true) {
      throw new Error("Matrix cursor settling returned a limited timeline");
    }
    if (plaintextSenderEventIds(timeline?.events ?? [], {
      senderUserId: environment.sender.userId,
    }).length > 0) {
      quietSince = Date.now();
    }
    cursor = body.next_batch;
    if (Date.now() - quietSince >= 3000) {
      const settled = {
        ...state,
        cursor,
        committedAtMs: Date.now(),
        pendingBatches: [],
      };
      await writeFile(statePath, `${JSON.stringify(settled)}\n`, "utf8");
      return settled;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Matrix cursor did not settle after prior test traffic");
}

async function readEligibleIdsSince(earliestCursor, heldEventId) {
  const token = await readToken(environment.bridge.tokenFile);
  const query = new URLSearchParams({ timeout: "0", since: earliestCursor });
  const response = await fetch(
    `${environment.homeserver}/_matrix/client/v3/sync?${query}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error(`Matrix fixture sync failed: HTTP ${response.status}`);
  const body = await response.json();
  const timeline = body.rooms?.join?.[environment.roomId]?.timeline;
  if (timeline?.limited === true) {
    throw new Error("Matrix fixture sync returned a limited timeline from the early cursor");
  }
  const eventIds = plaintextSenderEventIds(timeline?.events ?? [], {
    senderUserId: environment.sender.userId,
  });
  assert(eventIds.includes(heldEventId), "Matrix fixture sync did not return the held event");
  return eventIds;
}

function promptRequests(pair, text, forwarded) {
  return pair.observer.requests.filter((request) =>
    request.method === "session/prompt" &&
    promptText(request) === text &&
    (forwarded === undefined || request.forwarded === forwarded));
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
  // This recovery test shares a live room. Keep the held event in the bounded
  // catch-up selection even when delayed traffic from a preceding test arrives
  // after the initial cursor was established.
  await configureRecoveryCapacity();
  process.stdout.write("Establishing the initial processed Matrix cursor...\n");
  pair = await startObservedPair();
  let initialState = await readState();
  assert(typeof initialState.cursor === "string", "initial processed cursor was not persisted");
  await stopBridgePair(pair);
  pair = undefined;
  initialState = await settleInitialCursor(initialState);

  process.stdout.write("Sending two events while the bridge is stopped...\n");
  const first = await runSender(["--mode", "send-only", "--prompt", firstPrompt]);
  const second = await runSender(["--mode", "send-only", "--prompt", secondPrompt]);
  assert(first.event === "prompt-sent" && second.event === "prompt-sent",
    "offline Matrix prompts were not sent");

  process.stdout.write("Completing the first event while holding the second before ACP...\n");
  pair = await startObservedPair({ blockPrompt: secondPrompt });
  assert(pair.observer.loadSession === true,
    "early-cursor replay test requires ACP loadSession support");
  await waitFor(() => pair.gateStatus.blocked, "second ACP prompt gate", 120_000, pair);
  const firstExchange = await runSender([
    "--mode", "watch",
    "--prompt", firstPrompt,
    "--expect", firstReply,
    "--since", first.syncCursor,
    "--prompt-event-id", first.promptEventId,
  ]);
  assert(firstExchange.event === "exchange-complete" && firstExchange.responseCount === 1,
    "first event did not receive exactly one response before the crash");

  let recoveryState;
  await waitFor(async () => {
    const state = await readState();
    for (const batch of state.pendingBatches ?? []) {
      const room = batch.rooms?.find((entry) => entry.roomId === environment.roomId);
      const firstIndex = room?.eventIds?.indexOf(first.promptEventId) ?? -1;
      const secondIndex = room?.eventIds?.indexOf(second.promptEventId) ?? -1;
      if (firstIndex === -1 && secondIndex !== -1 &&
          !room.completedEventIds?.includes(second.promptEventId)) {
        recoveryState = state;
        return true;
      }
    }
    return false;
  }, "durable unfinished second event", 30_000, pair);
  assert(recoveryState !== undefined, "unfinished recovery state was not captured");
  assert(promptRequests(pair, firstPrompt, true).length === 1,
    "first event must reach ACP exactly once before restart");
  assert(promptRequests(pair, secondPrompt, false).length === 1,
    "second event was not held before ACP");

  await crashPair(pair);
  pair = undefined;

  // Query only event IDs from the original bridge cursor. This captures the
  // full eligible sender sequence, including unrelated room traffic between
  // that cursor and the generated events, without persisting or printing any
  // event bodies.
  const orderedEventIds = await readEligibleIdsSince(initialState.cursor, second.promptEventId);
  assert(orderedEventIds.includes(first.promptEventId),
    "Matrix fixture ordering did not include the completed event");
  assert(orderedEventIds.indexOf(first.promptEventId) < orderedEventIds.indexOf(second.promptEventId),
    "Matrix fixture ordering placed the completed event after the held event");
  recoveryState = normalizeEarlyCursorState({
    state: recoveryState,
    initialCursor: initialState.cursor,
    roomId: environment.roomId,
    heldEventId: second.promptEventId,
    orderedEventIds,
    committedAtMs: Date.now(),
  });
  await writeFile(statePath, `${JSON.stringify(recoveryState)}\n`, "utf8");

  process.stdout.write("Restarting from the early cursor and requiring only unfinished work...\n");
  pair = await startObservedPair();
  let probeExchange;
  try {
    probeExchange = await runSender([
      "--prompt", probePrompt,
      "--expect", probeReply,
    ]);
  } catch (error) {
    process.stderr.write(pair.bridgeDiagnostics());
    const promptCounts = {
      first: promptRequests(pair, firstPrompt, true).length,
      second: promptRequests(pair, secondPrompt, true).length,
      probe: promptRequests(pair, probePrompt, true).length,
    };
    const failedState = await readState().catch(() => {});
    const secondLedger = failedState?.pendingBatches?.flatMap((batch, batchIndex) =>
      batch.rooms.flatMap((room, roomIndex) => {
        const eventIndex = room.eventIds.indexOf(second.promptEventId);
        return eventIndex === -1 ? [] : [{
          batchIndex,
          roomIndex,
          eventIndex,
          completedCount: room.completedEventIds.length,
        }];
      })).at(0);
    process.stderr.write(`ACP methods after restart: ${pair.observer.requests.map((request) => request.method).join(",")}\n`);
    process.stderr.write(`ACP prompt counts after restart: first=${promptCounts.first}, second=${promptCounts.second}, probe=${promptCounts.probe}; second ledger=${JSON.stringify(secondLedger)}\n`);
    throw error;
  }
  assert(probeExchange.event === "exchange-complete" && probeExchange.responseCount === 1,
    "post-restart probe did not receive exactly one response");
  assert(promptRequests(pair, firstPrompt, true).length === 0,
    "completed event was replayed to ACP from the early cursor");
  assert(promptRequests(pair, secondPrompt, true).length <= 1,
    "unfinished event reached ACP more than once after restart");
  assert(pair.observer.requests.filter((request) => request.method === "session/load").length === 1,
    "restart did not load exactly one persisted ACP session");

  await waitFor(async () => {
    const state = await readState();
    return state.cursor !== recoveryState.cursor && state.pendingBatches?.length === 0;
  }, "processed cursor advancement and ledger cleanup", 30_000, pair);
  assertCleanDiagnostics(pair, ["saved-cursor-loaded", "catch-up-started", "catch-up-finished", "startup-ready"]);

  await stopBridgePair(pair);
  pair = undefined;
  process.stdout.write("Early-cursor event replay Matrix E2E test passed.\n");
} finally {
  if (pair !== undefined) {
    await stopBridgePair(pair).catch(() => crashPair(pair));
  }
}
