#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  runSender as runSenderProcess,
  startBridgePair,
  stopBridgePair,
} from "../e2e-support/acp.mjs";
import { defaultEnvironmentPath, readEnvironment, testDir } from "./lib.mjs";

const environmentPath = process.argv[2] ?? defaultEnvironmentPath;
const environment = await readEnvironment(environmentPath);
const runId = randomBytes(6).toString("hex").toUpperCase();
const firstExpected = `ENCRYPTED_E2E_OK_${runId}`;
const firstPrompt = `Reply with exactly: ${firstExpected}`;
const secondExpected = `ENCRYPTED_E2E_OK_OK_${runId}`;
const secondPrompt = `Reply with exactly: ${secondExpected}`;

async function startPair(expectedPrompt, suppressedPrompt) {
  const counter = { total: 0, matching: 0, suppressed: 0 };
  const pair = await startBridgePair(environment, {
    onOutbound(message) {
      if (message?.method !== "session/prompt") return;
      counter.total += 1;
      const prompt = message.params?.prompt;
      if (Array.isArray(prompt) && prompt.some((part) => part?.type === "text" && part.text === expectedPrompt)) {
        counter.matching += 1;
      }
      if (suppressedPrompt !== undefined && Array.isArray(prompt) && prompt.some((part) => part?.type === "text" && part.text === suppressedPrompt)) {
        counter.suppressed += 1;
      }
    },
  });
  return { ...pair, counter };
}

async function stopPair(pair) {
  await stopBridgePair(pair);
  if (/persistence.*error|ENOENT.*snapshot/iu.test(pair.bridgeDiagnostics())) {
    throw new Error("bridge reported a crypto persistence error");
  }
  if (pair.counter.matching !== 1) {
    process.stderr.write(pair.bridgeDiagnostics());
    throw new Error(
      `expected one matching ACP prompt, observed ${pair.counter.matching} (${pair.counter.total} total)`,
    );
  }
}

async function runSender(prompt, expected) {
  const result = await runSenderProcess({
    environmentPath,
    senderPath: join(testDir, "sender.mjs"),
    args: ["--prompt", prompt, "--expect", expected],
  });
  if (result.event !== "exchange-complete" || result.responseCount !== 1 ||
      result.promptWireType !== "m.room.encrypted" || result.responseWireType !== "m.room.encrypted") {
    throw new Error("sender did not report a valid encrypted exchange");
  }
  return result;
}

async function fingerprints() {
  const manifest = JSON.parse(await readFile(join(environment.bridge.stateDir, "crypto-state.json"), "utf8"));
  if (manifest.bootstrapCompleted !== true || manifest.sasVerified !== true) {
    throw new Error("bridge crypto manifest is not bootstrapped and SAS verified");
  }
  return [manifest.ed25519Fingerprint, manifest.curve25519Fingerprint];
}

async function bridgeState() {
  return JSON.parse(await readFile(join(environment.bridge.stateDir, "bridge-state.json"), "utf8"));
}

function assertSchemaV12State(state, label) {
  if (state.initialized !== true || Object.hasOwn(state, "cursor") || Object.hasOwn(state, "pendingBatches")) {
    throw new Error(`${label} bridge state is not schema-v12 completed-ID state`);
  }
  const ids = state.completedEventIds?.[environment.roomId];
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length > 100) {
    throw new Error(`${label} completed-ID ledger is missing, duplicate, or unbounded`);
  }
  return ids;
}

async function assertNoTemporarySnapshot() {
  const temporary = join(environment.bridge.stateDir, "matrix-crypto", ".indexeddb.snapshot.tmp");
  try {
    await stat(temporary);
    throw new Error("temporary IndexedDB snapshot remains after shutdown");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

// Each invocation starts a new delivery test while preserving the established
// crypto identity. This prevents messages from an interrupted prior test run
// from being submitted as bounded catch-up work.
await rm(join(environment.bridge.stateDir, "bridge-state.json"), { force: true });
const originalFingerprints = await fingerprints();
let pair;
try {
  process.stdout.write("Starting first encrypted exchange...\n");
  pair = await startPair(firstPrompt);
  process.stdout.write("Bridge is ready; starting sender...\n");
  const first = await runSender(firstPrompt, firstExpected);
  if (pair.counter.matching !== 1 || pair.counter.suppressed !== 0) {
    throw new Error(`first encrypted prompt count was matching=${pair.counter.matching}, suppressed=${pair.counter.suppressed}`);
  }
  const firstState = await bridgeState();
  assertSchemaV12State(firstState, "first");
  if (!firstState.completedEventIds[environment.roomId].includes(first.promptEventId)) {
    throw new Error("first encrypted prompt was not recorded as completed");
  }
  await stopPair(pair);
  pair = undefined;
  await assertNoTemporarySnapshot();

  process.stdout.write("Starting post-restart encrypted exchange...\n");
  pair = await startPair(secondPrompt, firstPrompt);
  process.stdout.write("Restarted bridge is ready; starting sender...\n");
  if (pair.counter.suppressed !== 0) {
    throw new Error(`completed encrypted prompt was replayed ${pair.counter.suppressed} time(s) after restart`);
  }
  const restoredFingerprints = await fingerprints();
  if (JSON.stringify(restoredFingerprints) !== JSON.stringify(originalFingerprints)) {
    throw new Error("bridge device fingerprints changed after restart");
  }
  const second = await runSender(secondPrompt, secondExpected);
  if (pair.counter.matching !== 1 || pair.counter.suppressed !== 0) {
    throw new Error(`second encrypted prompt count was matching=${pair.counter.matching}, suppressed=${pair.counter.suppressed}`);
  }
  const secondState = await bridgeState();
  const completedIds = assertSchemaV12State(secondState, "second");
  if (!completedIds.includes(second.promptEventId)) {
    throw new Error("second encrypted prompt was not recorded as completed");
  }
  await stopPair(pair);
  pair = undefined;
  await assertNoTemporarySnapshot();

  process.stdout.write("Encrypted E2E test passed twice with persistent device keys.\n");
} finally {
  if (pair !== undefined) {
    pair.bridge.kill("SIGTERM");
    pair.acp.kill("SIGTERM");
  }
}
