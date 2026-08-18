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

async function startPair(expectedPrompt) {
  const counter = { total: 0, matching: 0 };
  const pair = await startBridgePair(environment, {
    onOutbound(message) {
      if (message?.method !== "session/prompt") return;
      counter.total += 1;
      const prompt = message.params?.prompt;
      if (Array.isArray(prompt) && prompt.some((part) => part?.type === "text" && part.text === expectedPrompt)) {
        counter.matching += 1;
      }
    },
  });
  // Catch-up is complete at startup-ready. Count only the live prompt this
  // test sends after readiness, not best-effort replay from an interrupted
  // earlier invocation.
  counter.total = 0;
  counter.matching = 0;
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
}

async function fingerprints() {
  const manifest = JSON.parse(await readFile(join(environment.bridge.stateDir, "crypto-state.json"), "utf8"));
  if (manifest.bootstrapCompleted !== true || manifest.sasVerified !== true) {
    throw new Error("bridge crypto manifest is not bootstrapped and SAS verified");
  }
  return [manifest.ed25519Fingerprint, manifest.curve25519Fingerprint];
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
  await runSender(firstPrompt, firstExpected);
  await stopPair(pair);
  pair = undefined;
  await assertNoTemporarySnapshot();

  process.stdout.write("Starting post-restart encrypted exchange...\n");
  pair = await startPair(secondPrompt);
  process.stdout.write("Restarted bridge is ready; starting sender...\n");
  const restoredFingerprints = await fingerprints();
  if (JSON.stringify(restoredFingerprints) !== JSON.stringify(originalFingerprints)) {
    throw new Error("bridge device fingerprints changed after restart");
  }
  await runSender(secondPrompt, secondExpected);
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
