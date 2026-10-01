#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { runSender, startBridgePair, stopBridgePair, waitFor } from "../e2e-support/acp.mjs";
import { ThreadSessionMonitor } from "../e2e-support/thread-sessions.mjs";
import { defaultEnvironmentPath, readEnvironment, testDir, writePrivateFile } from "./lib.mjs";

const environmentPath = process.argv[2] ?? defaultEnvironmentPath;
const environment = await readEnvironment(environmentPath);
const marker = randomBytes(6).toString("hex").toUpperCase();
const monitor = new ThreadSessionMonitor();
const { sessionIds, promptSessions } = monitor;
const sessionIdsPath = join(environment.bridge.stateDir, "e2e-session-ids.json");
let persistSessionIds = Promise.resolve();
let pair;

function startPair() {
  return startBridgePair(environment, {
    onOutbound: (message) => monitor.inspect(message, "outbound"),
    onInbound: (message) => monitor.inspect(message, "inbound"),
  });
}

async function exchange(prompt, expected, options = {}) {
  const args = ["--prompt", prompt, "--expect", expected, "--expect-thread"];
  if (options.threadRootEventId !== undefined) args.push("--thread-root", options.threadRootEventId);
  const result = await runSender({ environmentPath, senderPath: join(testDir, "sender.mjs"), args });
  persistSessionIds = persistSessionIds.then(() =>
    writePrivateFile(sessionIdsPath, `${JSON.stringify([...sessionIds], null, 2)}\n`),
  );
  await persistSessionIds;
  return result;
}

try {
  process.stdout.write("Starting two independent plaintext thread roots concurrently...\n");
  pair = await startPair();
  const rootOnePrompt = `Reply with exactly: THREAD_ROOT_ONE_${marker}`;
  const rootTwoPrompt = `Reply with exactly: THREAD_ROOT_TWO_${marker}`;
  const [rootOne, rootTwo] = await Promise.all([
    exchange(rootOnePrompt, `THREAD_ROOT_ONE_${marker}`),
    exchange(rootTwoPrompt, `THREAD_ROOT_TWO_${marker}`),
  ]);
  assert.notEqual(rootOne.promptEventId, rootTwo.promptEventId, "top-level roots shared an event ID");
  await waitFor(
    () => promptSessions.has(rootOnePrompt) && promptSessions.has(rootTwoPrompt),
    "both root ACP prompts",
    30_000,
    pair,
  );
  assert.notEqual(
    promptSessions.get(rootOnePrompt),
    promptSessions.get(rootTwoPrompt),
    "different Matrix roots shared an ACP session",
  );

  process.stdout.write("Restarting bridge and following up in the first thread...\n");
  await stopBridgePair(pair);
  const loadsBeforeRestart = monitor.loadedSessions.length;
  pair = await startPair();
  assert.equal(monitor.loadedSessions.length, loadsBeforeRestart, "restart eagerly loaded thread sessions");
  const followupPrompt = `Reply with exactly: THREAD_FOLLOWUP_${marker}`;
  const followupExpected = monitor.loadSupported
    ? `THREAD_FOLLOWUP_${marker}`
    : "Unknown thread agent session. Please start a new thread.";
  const beforeFollowup = promptSessions.size;
  await exchange(followupPrompt, followupExpected, { threadRootEventId: rootOne.promptEventId });
  if (monitor.loadSupported) {
    await waitFor(() => promptSessions.has(followupPrompt), "lazy loaded thread prompt", 30_000, pair);
    assert.equal(
      promptSessions.get(followupPrompt),
      promptSessions.get(rootOnePrompt),
      "restart changed the thread session",
    );
    assert.deepEqual(
      monitor.loadedSessions.slice(loadsBeforeRestart),
      [promptSessions.get(rootOnePrompt)],
      "restart did not lazily load only the requested thread",
    );
  } else {
    assert.equal(promptSessions.size, beforeFollowup, "no-load restart forwarded an old thread to ACP");
  }

  if (monitor.loadSupported) {
    process.stdout.write("Resetting only the first thread and checking fresh-session creation...\n");
    const resetPrompt = "/reset";
    await exchange(resetPrompt, "Agent session reset.", { threadRootEventId: rootOne.promptEventId });
    // Restart before the next prompt to exercise the durable sessionless identity.
    await stopBridgePair(pair);
    pair = await startPair();
    const otherThreadPrompt = `Reply with exactly: THREAD_UNRESET_${marker}`;
    await exchange(otherThreadPrompt, `THREAD_UNRESET_${marker}`, { threadRootEventId: rootTwo.promptEventId });
    await waitFor(() => promptSessions.has(otherThreadPrompt), "unreset thread ACP prompt", 30_000, pair);
    assert.equal(
      promptSessions.get(otherThreadPrompt),
      promptSessions.get(rootTwoPrompt),
      "resetting the first thread changed the second thread's session",
    );
    const afterResetPrompt = `Reply with exactly: THREAD_AFTER_RESET_${marker}`;
    await exchange(afterResetPrompt, `THREAD_AFTER_RESET_${marker}`, { threadRootEventId: rootOne.promptEventId });
    await waitFor(() => promptSessions.has(afterResetPrompt), "post-reset ACP prompt", 30_000, pair);
    assert.notEqual(
      promptSessions.get(afterResetPrompt),
      promptSessions.get(followupPrompt),
      "thread reset reused its previous ACP session",
    );
  }

  const unknownRoot = `$unknown-${marker.toLowerCase()}:example.org`;
  const unknownPrompt = `UNKNOWN_THREAD_${marker}`;
  const promptsBeforeUnknown = promptSessions.size;
  const sessionsBeforeUnknown = sessionIds.size;
  const loadsBeforeUnknown = monitor.loadedSessions.length;
  await exchange(unknownPrompt, "Unknown thread agent session. Please start a new thread.", {
    threadRootEventId: unknownRoot,
  });
  assert.equal(promptSessions.size, promptsBeforeUnknown, "unknown thread follow-up was sent to ACP");
  assert.equal(sessionIds.size, sessionsBeforeUnknown, "unknown thread created an ACP session");
  assert.equal(monitor.loadedSessions.length, loadsBeforeUnknown, "unknown thread loaded an ACP session");

  await writePrivateFile(sessionIdsPath, `${JSON.stringify([...sessionIds], null, 2)}\n`);
  await stopBridgePair(pair);
  pair = undefined;
  process.stdout.write(
    `Plaintext thread-session E2E passed (loadSession ${monitor.loadSupported ? "available" : "unavailable"}; ${sessionIds.size} ACP sessions recorded for cleanup).\n`,
  );
} finally {
  if (pair !== undefined) {
    pair.bridge.kill("SIGTERM");
    pair.acp.kill("SIGTERM");
  }
}
