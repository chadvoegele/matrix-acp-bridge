#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { runSender, startBridgePair, stopBridgePair, waitFor } from "../e2e-support/acp.mjs";
import { defaultEnvironmentPath, readEnvironment, testDir, writePrivateFile } from "./lib.mjs";

const environmentPath = process.argv[2] ?? defaultEnvironmentPath;
const environment = await readEnvironment(environmentPath);
const marker = randomBytes(6).toString("hex").toUpperCase();
const sessionIds = new Set();
const promptSessions = new Map();
const sessionIdsPath = join(environment.bridge.stateDir, "e2e-session-ids.json");
let persistSessionIds = Promise.resolve();
const pendingNewSessions = new Set();
const pendingInitialize = new Set();
let loadSupported = false;
let pair;

function monitor(message, direction) {
  if (direction === "outbound" && message?.method === "initialize") pendingInitialize.add(message.id);
  if (direction === "inbound" && pendingInitialize.delete(message?.id)) {
    loadSupported = message.result?.agentCapabilities?.sessionCapabilities?.loadSession === true;
  }
  if (direction === "outbound" && message?.method === "session/new") pendingNewSessions.add(message.id);
  if (direction === "inbound" && pendingNewSessions.delete(message?.id)) {
    const sessionId = message.result?.sessionId;
    if (typeof sessionId === "string") sessionIds.add(sessionId);
  }
  if (direction === "outbound" && message?.method === "session/prompt") {
    const prompt = message.params?.prompt?.find?.((part) => part?.type === "text")?.text;
    if (typeof prompt === "string" && typeof message.params?.sessionId === "string") {
      promptSessions.set(prompt, message.params.sessionId);
    }
  }
}

function startPair() {
  return startBridgePair(environment, {
    onOutbound: (message) => monitor(message, "outbound"),
    onInbound: (message) => monitor(message, "inbound"),
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
  pair = await startPair();
  const followupPrompt = `Reply with exactly: THREAD_FOLLOWUP_${marker}`;
  const followupExpected = loadSupported
    ? `THREAD_FOLLOWUP_${marker}`
    : "Unknown thread agent session. Please start a new thread.";
  const beforeFollowup = promptSessions.size;
  await exchange(followupPrompt, followupExpected, { threadRootEventId: rootOne.promptEventId });
  if (loadSupported) {
    await waitFor(() => promptSessions.has(followupPrompt), "lazy loaded thread prompt", 30_000, pair);
    assert(promptSessions.has(followupPrompt), "known thread did not resume after restart");
  } else {
    assert.equal(promptSessions.size, beforeFollowup, "no-load restart forwarded an old thread to ACP");
  }

  if (loadSupported) {
    process.stdout.write("Resetting only the first thread and checking fresh-session creation...\n");
    const resetPrompt = "/reset";
    await exchange(resetPrompt, "Agent session reset.", { threadRootEventId: rootOne.promptEventId });
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
  await exchange(unknownPrompt, "Unknown thread agent session. Please start a new thread.", {
    threadRootEventId: unknownRoot,
  });
  assert.equal(promptSessions.size, promptsBeforeUnknown, "unknown thread follow-up was sent to ACP");

  await writePrivateFile(sessionIdsPath, `${JSON.stringify([...sessionIds], null, 2)}\n`);
  await stopBridgePair(pair);
  pair = undefined;
  process.stdout.write(
    `Plaintext thread-session E2E passed (loadSession ${loadSupported ? "available" : "unavailable"}; ${sessionIds.size} ACP sessions recorded for cleanup).\n`,
  );
} finally {
  if (pair !== undefined) {
    pair.bridge.kill("SIGTERM");
    pair.acp.kill("SIGTERM");
  }
}
