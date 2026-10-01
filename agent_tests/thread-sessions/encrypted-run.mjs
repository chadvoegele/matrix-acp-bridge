#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { childExit, runSender, startBridgePair, stopBridgePair } from "../e2e-support/acp.mjs";
import { ThreadSessionMonitor } from "../e2e-support/thread-sessions.mjs";
import { defaultEnvironmentPath, readEnvironment, testDir } from "./encrypted-lib.mjs";

const environmentPath = process.argv[2] ?? process.env.THREAD_ENCRYPTED_ENVIRONMENT_FILE ?? defaultEnvironmentPath;
const environment = await readEnvironment(environmentPath);
const marker = randomBytes(6).toString("hex").toUpperCase();
const monitor = new ThreadSessionMonitor(join(environment.bridge.stateDir, "e2e-session-ids.json"));
let pair;

async function exchange(prompt, expected, threadRootEventId) {
  const args = ["--prompt", prompt, "--expect", expected, "--expect-thread"];
  if (threadRootEventId !== undefined) args.push("--thread-root", threadRootEventId);
  return runSender({ environmentPath, senderPath: join(testDir, "encrypted-sender.mjs"), args });
}

try {
  pair = await startBridgePair(environment, {
    onOutbound(message) {
      monitor.inspect(message, "outbound");
    },
    onInbound(message) {
      monitor.inspect(message, "inbound");
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
  assert.equal(monitor.promptCount, 2, "expected two ACP prompts");
  assert.equal(monitor.promptSessions.size, 2, "expected both encrypted prompts to reach ACP");
  assert.equal(
    monitor.promptSessions.get(followupPrompt),
    monitor.promptSessions.get(firstPrompt),
    "encrypted follow-up changed its ACP session",
  );
  assert.equal(monitor.sessionIds.size, 1, "encrypted follow-up created another ACP session");
  await stopBridgePair(pair);
  pair = undefined;
  process.stdout.write("Encrypted thread-session E2E passed with authenticated decrypted thread relations.\n");
} finally {
  try {
    if (pair !== undefined) await stopBridgePair(pair);
  } finally {
    if (pair !== undefined) {
      pair.bridge.kill("SIGTERM");
      pair.acp.kill("SIGTERM");
      await Promise.allSettled([childExit(pair.bridge, "bridge"), childExit(pair.acp, "ACP proxy", [0, 143])]);
    }
    await monitor.flushSessionIds();
  }
}
