#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  runSender as runSenderProcess,
  startBridgePair,
  stopBridgePair,
} from "../e2e-support/acp.mjs";
import { defaultEnvironmentPath, readEnvironment, testDir, writePrivateFile } from "./lib.mjs";

const environmentPath = process.argv[2] ?? defaultEnvironmentPath;
const environment = await readEnvironment(environmentPath);
const sessionIdsPath = join(environment.bridge.stateDir, "e2e-session-ids.json");
const runId = randomBytes(6).toString("hex").toUpperCase();
const initialPrompt = `Reply with exactly: RESET_E2E_BEFORE_${runId}`;
const initialResponse = `RESET_E2E_BEFORE_${runId}`;
const followupPrompt = `Reply with exactly: RESET_E2E_AFTER_${runId}`;
const followupResponse = `RESET_E2E_AFTER_${runId}`;

function startObserver() {
  const observed = {
    newRequests: 0,
    loadRequests: 0,
    deleteRequests: 0,
    prompts: [],
    newSessionIds: [],
    loadSessionSupported: false,
  };
  const pending = new Map();
  const outbound = (message) => {
    if (message?.method === "initialize") pending.set(message.id, "initialize");
    if (message?.method === "session/new") {
      observed.newRequests += 1;
      pending.set(message.id, "session/new");
    }
    if (message?.method === "session/load") observed.loadRequests += 1;
    if (message?.method === "session/delete") observed.deleteRequests += 1;
    if (message?.method === "session/prompt") {
      observed.prompts.push({
        sessionId: message.params?.sessionId,
        text: message.params?.prompt?.find?.((part) => part?.type === "text")?.text,
      });
    }
  };
  const inbound = (message) => {
    const method = pending.get(message?.id);
    if (method === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) return;
    if (method === "initialize") {
      observed.loadSessionSupported = message.result?.agentCapabilities?.loadSession === true;
    } else if (method === "session/new" && typeof message.result?.sessionId === "string") {
      observed.newSessionIds.push(message.result.sessionId);
    }
  };
  return { observed, outbound, inbound };
}

async function persistObservedSessionIds(observed) {
  const sessionIds = [...new Set(observed.newSessionIds)];
  if (sessionIds.length > 0) {
    await writePrivateFile(sessionIdsPath, `${JSON.stringify(sessionIds, null, 2)}\n`);
  }
}

async function startPair() {
  const observer = startObserver();
  const pair = await startBridgePair(environment, {
    onOutbound: observer.outbound,
    onInbound: observer.inbound,
  });
  return { ...pair, observed: observer.observed };
}

async function stopPair(pair) {
  await stopBridgePair(pair);
}

async function runSender(prompt, expected) {
  const result = await runSenderProcess({
    environmentPath,
    senderPath: join(testDir, "sender.mjs"),
    args: ["--prompt", prompt, "--expect", expected],
    forwardStderr: false,
  });
  if (result.event !== "exchange-complete" || result.responseCount !== 1 ||
      result.promptWireType !== "m.room.message" || result.responseWireType !== "m.room.message") {
    throw new Error("sender did not report a valid plaintext exchange");
  }
}

async function assertBridgeState(observed, expectedSessionId) {
  if (!observed.loadSessionSupported) return;
  const state = JSON.parse(await readFile(join(environment.bridge.stateDir, "bridge-state.json"), "utf8"));
  if (state.sessions?.[environment.roomId] !== expectedSessionId) {
    throw new Error("bridge state does not map the room to the post-reset ACP session");
  }
}

async function assertResetRemovedMapping(observed) {
  if (!observed.loadSessionSupported) return;
  const state = JSON.parse(await readFile(join(environment.bridge.stateDir, "bridge-state.json"), "utf8"));
  if (state.sessions?.[environment.roomId] !== undefined) {
    throw new Error("reset did not remove the room's bridge-state mapping");
  }
}

function assertProtocol(observed) {
  const [first, second] = observed.prompts;
  const [firstNew, secondNew] = observed.newSessionIds;
  if (observed.newRequests !== 2 || observed.loadRequests !== 0 || observed.deleteRequests !== 0 ||
      observed.prompts.length !== 2 || first?.text !== initialPrompt || second?.text !== followupPrompt ||
      first?.sessionId !== firstNew || second?.sessionId !== secondNew || firstNew === secondNew ||
      typeof firstNew !== "string" || typeof secondNew !== "string" ||
      observed.prompts.some(({ text }) => text === "/reset")) {
    throw new Error("/reset ACP protocol assertions failed");
  }
}

let pair;
try {
  pair = await startPair();
  process.stdout.write("Bridge is ready; sending the initial prompt.\n");
  await runSender(initialPrompt, initialResponse);
  await persistObservedSessionIds(pair.observed);
  if (pair.observed.newSessionIds.length !== 1) {
    throw new Error("initial ACP session ID was not observed before reset");
  }

  process.stdout.write("Sending exact /reset.\n");
  await runSender("/reset", "Agent session reset.");
  await assertResetRemovedMapping(pair.observed);
  process.stdout.write("Sending the post-reset prompt.\n");
  await runSender(followupPrompt, followupResponse);
  await persistObservedSessionIds(pair.observed);

  assertProtocol(pair.observed);
  await assertBridgeState(pair.observed, pair.observed.newSessionIds[1]);
  await stopPair(pair);
  pair = undefined;
  process.stdout.write("/reset E2E test passed with two isolated ACP sessions.\n");
} catch (error) {
  if (pair !== undefined) {
    process.stderr.write(pair.bridgeDiagnostics());
    process.stderr.write(pair.acpDiagnostics());
  }
  throw error;
} finally {
  if (pair !== undefined) {
    await persistObservedSessionIds(pair.observed);
    pair.bridge.kill("SIGTERM");
    pair.acp.kill("SIGTERM");
  }
}
