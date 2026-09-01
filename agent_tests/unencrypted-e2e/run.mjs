#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  runSender as runSenderProcess,
  startBridgePair,
  stopBridgePair,
} from "../e2e-support/acp.mjs";
import { defaultEnvironmentPath, readEnvironment, testDir } from "./lib.mjs";

const environmentPath = process.argv[2] ?? defaultEnvironmentPath;
const environment = await readEnvironment(environmentPath);
const statePath = join(environment.bridge.stateDir, "bridge-state.json");
const runId = randomBytes(6).toString("hex").toUpperCase();
const firstExpected = `UNENCRYPTED_E2E_MARKDOWN_${runId}`;
const firstPrompt = `Reply with exactly this Markdown and nothing else: **${firstExpected}**`;
const firstFormattedBody = `<p><strong>${firstExpected}</strong></p>`;
const secondPrompt = `Reply with exactly: UNENCRYPTED_E2E_OK_OK_${runId}`;
const secondExpected = `UNENCRYPTED_E2E_OK_OK_${runId}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readState() {
  return JSON.parse(await readFile(statePath, "utf8"));
}

function assertSchemaV12State(state, label) {
  assert(state.initialized === true, `${label} state is not initialized`);
  assert(Object.hasOwn(state, "cursor") === false, `${label} state contains a legacy cursor`);
  assert(Object.hasOwn(state, "pendingBatches") === false, `${label} state contains legacy pending batches`);
  const ids = state.completedEventIds?.[environment.roomId];
  assert(Array.isArray(ids) && new Set(ids).size === ids.length,
    `${label} state has no bounded completed-event ledger`);
  assert(ids.length <= 100, `${label} completed-event ledger exceeded the initial-sync bound`);
}

async function startPair({ expectedPrompt, suppressedPrompt }) {
  const counter = { total: 0, matching: 0, suppressed: 0 };
  const pair = await startBridgePair(environment, {
    onOutbound(message) {
      if (message?.method !== "session/prompt") return;
      counter.total += 1;
      const text = message.params?.prompt?.find?.((part) => part?.type === "text")?.text;
      if (text === expectedPrompt) counter.matching += 1;
      if (suppressedPrompt !== undefined && text === suppressedPrompt) counter.suppressed += 1;
    },
  });
  return { ...pair, counter };
}

async function runSender(prompt, expected, expectedFormattedBody) {
  const args = ["--prompt", prompt, "--expect", expected];
  if (expectedFormattedBody !== undefined) args.push("--expect-formatted-body", expectedFormattedBody);
  const result = await runSenderProcess({
    environmentPath,
    senderPath: join(testDir, "sender.mjs"),
    args,
  });
  assert(result.event === "exchange-complete" && result.responseCount === 1,
    "sender did not report exactly one plaintext exchange");
  assert(result.promptWireType === "m.room.message" && result.responseWireType === "m.room.message",
    "sender did not report top-level plaintext Matrix events");
  return result;
}

let pair;
try {
  process.stdout.write("Starting first plaintext exchange after normal initial sync...\n");
  pair = await startPair({ expectedPrompt: firstPrompt });
  const first = await runSender(firstPrompt, firstExpected, firstFormattedBody);
  assert(pair.counter.matching === 1, `first prompt reached ACP ${pair.counter.matching} times`);
  assert(pair.counter.suppressed === 0, "first prompt was unexpectedly submitted during baseline startup");
  const firstState = await readState();
  assertSchemaV12State(firstState, "first");
  assert(firstState.completedEventIds[environment.roomId].includes(first.promptEventId),
    "first plaintext prompt was not recorded as completed");
  await stopBridgePair(pair);
  pair = undefined;

  process.stdout.write("Restarting and proving completed-ID suppression before the second exchange...\n");
  pair = await startPair({ expectedPrompt: secondPrompt, suppressedPrompt: firstPrompt });
  assert(pair.counter.suppressed === 0, "completed plaintext prompt was replayed to ACP after restart");
  const second = await runSender(secondPrompt, secondExpected);
  assert(pair.counter.matching === 1, `second prompt reached ACP ${pair.counter.matching} times`);
  assert(pair.counter.suppressed === 0, "completed plaintext prompt was replayed during the second exchange");
  const secondState = await readState();
  assertSchemaV12State(secondState, "second");
  assert(secondState.completedEventIds[environment.roomId].includes(second.promptEventId),
    "second plaintext prompt was not recorded as completed");
  await stopBridgePair(pair);
  pair = undefined;
  process.stdout.write("Unencrypted E2E test passed with normal initial-sync recovery and exactly-once ACP prompts.\n");
} finally {
  if (pair !== undefined) {
    pair.bridge.kill("SIGTERM");
    pair.acp.kill("SIGTERM");
  }
}
