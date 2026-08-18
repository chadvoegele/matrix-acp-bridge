#!/usr/bin/env node
import { randomBytes } from "node:crypto";
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
const exchanges = [
  [`Reply with exactly: UNENCRYPTED_E2E_OK_${runId}`, `UNENCRYPTED_E2E_OK_${runId}`],
  [`Reply with exactly: UNENCRYPTED_E2E_OK_OK_${runId}`, `UNENCRYPTED_E2E_OK_OK_${runId}`],
];

async function startPair(expectedPrompt) {
  const counter = { total: 0, matching: 0 };
  const pair = await startBridgePair(environment, {
    onOutbound(message) {
      if (message?.method !== "session/prompt") return;
      counter.total += 1;
      if (message.params?.prompt?.some?.(
        (part) => part?.type === "text" && part.text === expectedPrompt,
      )) counter.matching += 1;
    },
  });
  counter.total = 0;
  counter.matching = 0;
  return { ...pair, counter };
}

async function stopPair(pair) {
  await stopBridgePair(pair);
  if (pair.counter.matching !== 1) {
    process.stderr.write(pair.bridgeDiagnostics());
    throw new Error(`expected one matching ACP prompt, observed ${pair.counter.matching} (${pair.counter.total} total)`);
  }
}

async function runSender(prompt, expected) {
  const result = await runSenderProcess({
    environmentPath,
    senderPath: join(testDir, "sender.mjs"),
    args: ["--prompt", prompt, "--expect", expected],
  });
  if (result.event !== "exchange-complete" || result.responseCount !== 1 ||
      result.promptWireType !== "m.room.message" || result.responseWireType !== "m.room.message") {
    throw new Error("sender did not report a valid plaintext exchange");
  }
}

let pair;
try {
  for (const [index, [prompt, expected]] of exchanges.entries()) {
    process.stdout.write(`Starting ${index === 0 ? "first" : "post-restart"} plaintext exchange...\n`);
    pair = await startPair(prompt);
    process.stdout.write("Bridge is ready; starting sender...\n");
    await runSender(prompt, expected);
    await stopPair(pair);
    pair = undefined;
  }
  process.stdout.write("Unencrypted E2E test passed twice across a bridge restart.\n");
} finally {
  if (pair !== undefined) {
    pair.bridge.kill("SIGTERM");
    pair.acp.kill("SIGTERM");
  }
}
