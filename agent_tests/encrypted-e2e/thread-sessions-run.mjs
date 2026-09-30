#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { runSender, startBridgePair, stopBridgePair } from "../e2e-support/acp.mjs";
import { defaultEnvironmentPath, readEnvironment, testDir } from "./lib.mjs";

const environmentPath = process.argv[2] ?? defaultEnvironmentPath;
const environment = await readEnvironment(environmentPath);
const marker = randomBytes(6).toString("hex").toUpperCase();
let promptCount = 0;
let pair;

async function exchange(prompt, expected, threadRootEventId) {
  const args = ["--prompt", prompt, "--expect", expected, "--expect-thread"];
  if (threadRootEventId !== undefined) args.push("--thread-root", threadRootEventId);
  return runSender({ environmentPath, senderPath: join(testDir, "sender.mjs"), args });
}

try {
  pair = await startBridgePair(environment, {
    onOutbound(message) {
      if (message?.method === "session/prompt") promptCount += 1;
    },
  });
  process.stdout.write("Sending an encrypted top-level thread root...\n");
  const firstPrompt = `Reply with exactly: ENCRYPTED_THREAD_ROOT_${marker}`;
  const first = await exchange(firstPrompt, `ENCRYPTED_THREAD_ROOT_${marker}`);
  assert.equal(first.promptWireType, "m.room.encrypted");
  assert.equal(first.responseWireType, "m.room.encrypted");

  process.stdout.write("Sending an encrypted follow-up to the same thread...\n");
  const followupPrompt = `Reply with exactly: ENCRYPTED_THREAD_FOLLOWUP_${marker}`;
  const followup = await exchange(followupPrompt, `ENCRYPTED_THREAD_FOLLOWUP_${marker}`, first.promptEventId);
  assert.equal(followup.promptWireType, "m.room.encrypted");
  assert.equal(followup.responseWireType, "m.room.encrypted");
  assert.equal(promptCount, 2, `expected two ACP prompts, observed ${promptCount}`);
  await stopBridgePair(pair);
  pair = undefined;
  process.stdout.write("Encrypted thread-session E2E passed with authenticated decrypted thread relations.\n");
} finally {
  if (pair !== undefined) {
    pair.bridge.kill("SIGTERM");
    pair.acp.kill("SIGTERM");
  }
}
