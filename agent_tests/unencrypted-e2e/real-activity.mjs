#!/usr/bin/env node
// Optional pi-acp smoke test. A completed run requires every observation.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

import {
  runSender,
  startBridgePair,
  stopBridgePair,
  waitFor,
} from "../e2e-support/acp.mjs";
import {
  defaultEnvironmentPath,
  readEnvironment,
  readToken,
  testDir,
} from "./lib.mjs";

const environmentPath = process.argv[2] ?? defaultEnvironmentPath;
const environment = await readEnvironment(environmentPath);
const scratchDirectory = process.env.E2E_REAL_SCRATCH_DIR;
const cleanupCommand = JSON.parse(
  process.env.E2E_REAL_SCRATCH_CLEANUP_COMMAND ?? "null",
);
if (
  typeof scratchDirectory !== "string" ||
  !scratchDirectory.startsWith("/") ||
  !Array.isArray(cleanupCommand) ||
  cleanupCommand.length === 0 ||
  !cleanupCommand.every((part) => typeof part === "string" && part.length > 0)
) {
  throw new Error(
    "real activity test requires an absolute scratch directory and a JSON cleanup command",
  );
}
const path = resolve(
  scratchDirectory,
  `matrix-acp-activity-${randomBytes(12).toString("hex")}.txt`,
);
const first = "alpha\nbeta\n";
const second = "alpha\ngamma\n";
const prompt =
  `Use tools in this order on only ${path}: write exact text ${JSON.stringify(first)}; ` +
  `read the file; edit beta to gamma; use bash to run cat -- ${path}; ` +
  "then briefly confirm completion. Do not inspect other files or run other commands.";
const frames = [];
let promptId;
let finished = false;
let pair;
const token = await readToken(environment.sender.tokenFile);
const request = async (path_) => {
  const response = await fetch(
    `${environment.homeserver}/_matrix/client/v3${path_}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(45_000),
    },
  );
  if (!response.ok)
    throw new Error(
      `Matrix real activity request failed: HTTP ${response.status}`,
    );
  return response.json();
};
const sync = (since, timeout) =>
  request(
    `/sync?${new URLSearchParams({
      timeout: String(timeout),
      ...(since ? { since } : {}),
    })}`,
  );

async function cleanupScratch() {
  const [program, ...arguments_] = cleanupCommand;
  await new Promise((resolvePromise, reject) => {
    const child = spawn(program, [...arguments_, path], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error("scratch cleanup failed")),
    );
  });
}

try {
  pair = await startBridgePair(environment, {
    onOutbound(frame) {
      if (frame.method === "session/prompt") promptId = frame.id;
    },
    onInbound(frame) {
      if (frame.method === "session/update") frames.push(frame.params?.update);
      if (promptId !== undefined && frame.id === promptId) finished = true;
    },
  });
  const baseline = await sync(undefined, 0);
  let cursor = baseline.next_batch;
  const result = await runSender({
    environmentPath,
    senderPath: join(testDir, "sender.mjs"),
    args: ["--prompt", prompt, "--mode", "send-only"],
    forwardStderr: false,
  });
  if (result.event !== "prompt-sent")
    throw new Error("real activity prompt was not sent");
  await waitFor(() => finished, "real ACP turn", 180_000, pair);
  const wire = [];
  const wireDeadline = Date.now() + 10_000;
  while (Date.now() < wireDeadline) {
    const batch = await sync(cursor, Math.min(2000, wireDeadline - Date.now()));
    cursor = batch.next_batch;
    wire.push(
      ...(
        batch.rooms?.join?.[environment.roomId]?.timeline?.events ?? []
      ).filter(
        (event) =>
          event.sender === environment.bridge.userId &&
          event.type === "m.room.message",
      ),
    );
  }
  const tools = frames.filter((frame) => frame?.sessionUpdate === "tool_call");
  const changes = frames.filter(
    (frame) => frame?.sessionUpdate === "tool_call_update",
  );
  const find = (kind, predicate) =>
    tools.find((frame) => frame.kind === kind && predicate(frame));
  const write = find(
    "edit",
    (frame) =>
      frame.rawInput?.path === path && frame.rawInput?.content === first,
  );
  const read = find("read", (frame) => frame.rawInput?.path === path);
  const edit = find(
    "edit",
    (frame) =>
      frame.rawInput?.path === path && Array.isArray(frame.rawInput?.edits),
  );
  const bash = find("execute", (frame) =>
    frame.title?.includes(`cat -- ${path}`),
  );
  const updates = (frame) =>
    changes.filter((change) => frame && change.toolCallId === frame.toolCallId);
  const has = {
    writeInput: Boolean(write),
    writeDiff: updates(write).some(
      (change) =>
        change.status === "completed" &&
        change.content?.some(
          (item) =>
            item.type === "diff" &&
            item.path === path &&
            item.oldText === null &&
            item.newText === first,
        ),
    ),
    readInput: Boolean(read),
    readResult: updates(read).some(
      (change) =>
        change.status === "completed" &&
        change.content?.some(
          (item) => item.type === "content" && item.content?.text === first,
        ) &&
        change.rawOutput?.content?.some((item) => item.text === first),
    ),
    editInput: Boolean(edit),
    editDiff: updates(edit).some(
      (change) =>
        change.status === "completed" &&
        change.content?.some(
          (item) =>
            item.type === "diff" &&
            item.path === path &&
            item.oldText === first &&
            item.newText === second,
        ),
    ),
    bashTitle: Boolean(bash),
    terminalInfo: Boolean(
      bash?.content?.some((item) => item.type === "terminal") &&
      bash?._meta?.terminal_info?.terminal_id,
    ),
    terminalOutput: updates(bash).some((change) =>
      change._meta?.terminal_output?.data?.includes(second),
    ),
    terminalExit: updates(bash).some(
      (change) =>
        change.status === "completed" &&
        change._meta?.terminal_exit?.exit_code === 0,
    ),
    matrixActivity: wire.some((event) =>
      event.content?.formatted_body?.includes("🔧"),
    ),
    matrixEdit: wire.some(
      (event) =>
        event.content?.["m.relates_to"]?.rel_type === "m.replace" &&
        typeof event.content?.["m.new_content"]?.body === "string" &&
        typeof event.content?.["m.new_content"]?.formatted_body === "string",
    ),
  };
  const missing = Object.entries(has)
    .filter(([, present]) => !present)
    .map(([key]) => key);
  await stopBridgePair(pair);
  pair = undefined;
  if (missing.length > 0)
    throw new Error(
      `INCOMPLETE real ACP activity metadata: ${missing.join(", ")}`,
    );
  process.stdout.write("Real ACP activity metadata coverage passed.\n");
} finally {
  if (pair) {
    await stopBridgePair(pair).catch(() => {});
  }
  await cleanupScratch();
}
