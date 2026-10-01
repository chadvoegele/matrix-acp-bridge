import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { createAcpClient } from "../../dist/acp-client.js";
import { BridgeCoordinator } from "../../dist/bridge.js";
import { openBridgeStateStore } from "../../dist/bridge-state.js";
import { InMemorySessionStore } from "../../dist/session-store.js";

// Opt-in real Pi/ACP check. Matrix sends are modeled; no homeserver is contacted.
const build = process.argv[2];
if (process.argv.length !== 3 || !build)
  throw new Error("Usage: node agent_tests/steering/real-agent-probe.mjs <pi-acp dist/index.js>");
const scratch = resolve("node_modules/.steering-verification");
await mkdir(scratch, { recursive: true });
const stateDir = await mkdtemp(resolve(scratch, "probe-"));
const workspace = resolve(stateDir, "workspace");
await mkdir(workspace, { mode: 0o700 });
const child = spawn(process.execPath, [resolve(build)], {
  cwd: workspace,
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
});
// Upstream diagnostics may contain private data. Never forward their contents.
let stderrBytes = 0;
child.stderr.on("data", (data) => {
  stderrBytes += data.length;
});
const silent = { emit() {}, debug() {}, info() {}, warn() {}, error() {} };
const noop = () => {};
const acp = createAcpClient({
  input: child.stdout,
  output: child.stdin,
  cwd: workspace,
  permissionHandler: async () => "allow_once",
  diagnostics: silent,
});
const killProbe = () => {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* The probe may have already exited. */
  }
};
let bridge;
let stateStore;
let phase = "initialize";
const deadline = setTimeout(() => {
  console.log(JSON.stringify({ phase, result: "blocked", reason: "45-second deadline" }));
  process.exitCode = 1;
  killProbe();
}, 45_000);
try {
  const initialized = await acp.initialize({
    protocolVersion: 1,
    capabilities: { filesystem: false, terminal: false },
  });
  assert.equal(initialized.agentCapabilities?.steering, true);
  console.log(JSON.stringify({ phase, steering: true }));
  phase = "session/new";
  const session = await acp.createSession({ cwd: workspace, mcpServers: [] });
  console.log(JSON.stringify({ phase, result: "created" }));
  phase = "idle steering";
  const idle = await acp.steer(session.sessionId, "idle contract probe", 10_000);
  assert.deepEqual(idle, { kind: "steering", outcome: "promptRequired", reason: "noRunningTurn" });
  console.log(JSON.stringify({ phase, result: idle }));

  const sessionStore = new InMemorySessionStore();
  sessionStore.setConversationRecord({ kind: "room", roomId: "!probe:local", sessionId: session.sessionId });
  const config = {
    stateDir,
    matrix: {
      homeserver: "https://unused.invalid",
      userId: "@bridge:local",
      deviceId: "PROBE",
      accessTokenFile: resolve(stateDir, "unused-token"),
      allowedRooms: ["!probe:local"],
      allowedSenders: ["@operator:local"],
      encryption: "disabled",
      responseMode: "room",
      defaultMessageDelivery: "steer",
    },
    acp: { cwd: workspace },
    limits: {
      maxInputBytes: 16_384,
      maxOutputBytes: 16_384,
      maxMatrixMessageBytes: 32_768,
      maxActivityEventsPerMessage: 10,
      maxQueuedTurnsPerConversation: 4,
      maxConcurrentPrompts: 1,
      maxTurnSeconds: 30,
      shutdownGraceSeconds: 2,
      startupTimeoutSeconds: 10,
      initialSyncTimelineLimit: 100,
      maxCatchupAgeSeconds: 900,
      maxCatchupEventsPerRoom: 4,
    },
  };
  stateStore = await openBridgeStateStore({ stateDir, identity: config.matrix });
  await stateStore.establishInitialBaseline([]);
  await stateStore.setSessionMapping("!probe:local", session.sessionId);
  const notices = [];
  bridge = new BridgeCoordinator({
    config,
    acp,
    sessionStore,
    stateStore,
    loadSession: true,
    steering: true,
    matrix: {
      onFatalError: () => noop,
      stopIntake() {},
      async stop() {},
      async sendMessage(part) {
        notices.push(part.responseKind);
      },
    },
  });
  const event = (eventId, body) => ({
    eventId,
    roomId: "!probe:local",
    sender: "@operator:local",
    type: "m.room.message",
    content: { msgtype: "m.text", body },
    isLive: true,
    isPlaintext: true,
    isEncrypted: false,
    isDecrypted: true,
    isRedacted: false,
  });
  const complete = (eventId) => async () => {
    await stateStore.markEventCompleted("!probe:local", eventId);
  };
  let toolStarted;
  const tool = new Promise((resolveTool) => {
    toolStarted = resolveTool;
  });
  acp.onUpdate((update) => {
    if (update.kind === "tool_call") toolStarted();
  });
  phase = "tracked idle fallback";
  const first = bridge.handleTimelineEvent(
    event(
      "$probe-first",
      "/steer Use bash to run exactly sleep 10; then reply with done. Do not inspect any files or invoke other tools.",
    ),
    complete("$probe-first"),
  );
  await Promise.race([tool, first]);
  assert.equal(bridge.unresolvedPromptCount, 1);
  assert.deepEqual(notices, ["steering_idle"]);
  console.log(JSON.stringify({ phase, unresolvedPrompts: 1, notices }));
  phase = "active steering";
  await bridge.handleTimelineEvent(
    event("$probe-steer", "/steer After sleep ends, reply with acknowledged."),
    complete("$probe-steer"),
  );
  assert.equal(bridge.fatalError, undefined);
  assert.equal(bridge.unresolvedPromptCount, 1);
  assert.deepEqual(notices, ["steering_idle"]);
  const disk = await openBridgeStateStore({ stateDir, identity: config.matrix });
  assert.equal(disk.isEventCompleted("!probe:local", "$probe-steer"), true);
  assert.equal(disk.isEventCompleted("!probe:local", "$probe-first"), false);
  console.log(JSON.stringify({ phase, durableCompletion: true, unresolvedPrompts: 1, notices }));
  await first;
  assert.equal(bridge.fatalError, undefined);
  assert.equal(bridge.unresolvedPromptCount, 0);
  assert.equal(stateStore.isEventCompleted("!probe:local", "$probe-first"), true);
  assert.deepEqual(notices, ["steering_idle", "agent"]);
  console.log(JSON.stringify({ phase: "tracked turn completion", unresolvedPrompts: 0, notices }));
} catch (error) {
  console.log(
    JSON.stringify({
      phase,
      result: "blocked",
      kind: error?.kind ?? "error",
      operation: error?.operation,
      stderrBytes,
    }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await bridge?.stop();
  await acp.close();
  killProbe();
  await stateStore?.flush();
  await rm(stateDir, { recursive: true, force: true });
}
