import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeClock } from "./test-support/fake-clock.js";
import { BridgeCoordinator } from "./bridge.js";
import {
  DaemonLifecycle,
  parseCommandLine,
  validateCommandForConfig,
  type DaemonBridge,
  type DaemonDependencies,
} from "./main.js";
import type { BridgeConfig } from "./config.js";
import type { CancellationSignal, Unsubscribe } from "./cancellation.js";
import type { DiagnosticSink, FatalError } from "./diagnostics.js";
import type {
  AcpClient,
  AcpInitializeOptions,
  AcpOutcome,
  AcpSession,
  AcpSessionOptions,
  AcpUpdate,
} from "./acp-client.js";
import type {
  InboundMatrixEvent,
  MatrixClientAdapter,
  MatrixIdentity,
  MatrixSyncBatch,
  MatrixSyncStateChange,
} from "./matrix-client.js";
import type { RenderedMatrixPart } from "./response-rendering.js";
import type { LoadedConfiguration, StateLockLike } from "./config.js";
import { ensureCryptoDatabaseDirectory, openCryptoStateStore } from "./crypto-state.js";

const ROOM_ID = "!room:example.org";
const USER_ID = "@bridge:example.org";
const DEFAULT_STATE_DIR = await mkdtemp(join(tmpdir(), "matrix-acp-lifecycle-default-"));

const CONFIG: BridgeConfig = {
  stateDir: DEFAULT_STATE_DIR,
  matrix: {
    homeserver: "https://matrix.example.org",
    userId: USER_ID,
    deviceId: "BRIDGEDEVICE",
    accessTokenFile: "/private/state/token",
    allowedRooms: [ROOM_ID],
    allowedSenders: ["@alice:example.org"],
    encryption: "disabled",
  },
  acp: { cwd: "/private/workspace" },
  limits: {
    maxInputBytes: 16_384,
    maxOutputBytes: 256,
    maxMatrixMessageBytes: 128,
    maxQueuedTurnsPerRoom: 2,
    maxConcurrentPrompts: 1,
    maxTurnSeconds: 10,
    shutdownGraceSeconds: 1,
    startupTimeoutSeconds: 1,
    initialSyncTimelineLimit: 100,
    maxCatchupAgeSeconds: 900,
    maxCatchupEventsPerRoom: 4,
  },
};

test.after(async () => {
  await rm(DEFAULT_STATE_DIR, { recursive: true, force: true });
});

const CRYPTO_KEYS = {
  ed25519Fingerprint: "ed25519-public",
  curve25519Fingerprint: "curve25519-public",
} as const;

const SILENT_DIAGNOSTICS: DiagnosticSink = {
  emit() { /* test sink */ },
  debug() { /* test sink */ },
  info() { /* test sink */ },
  warn() { /* test sink */ },
  error() { /* test sink */ },
};

class FakeStateLock implements StateLockLike {
  readonly lockPath = `${CONFIG.stateDir}/.lock`;
  released = false;
  releaseCalls = 0;

  async release(): Promise<void> {
    this.releaseCalls += 1;
    this.released = true;
  }
}

class FakeAcp implements AcpClient {
  readonly updates = new Set<(update: AcpUpdate) => void>();
  readonly fatalListeners = new Set<(error: FatalError) => void>();
  initializeCalls = 0;
  closeCalls = 0;
  readonly initializeAction: () => Promise<void>;
  readonly log: string[];

  constructor(log: string[], initializeAction: () => Promise<void> = async () => {}) {
    this.log = log;
    this.initializeAction = initializeAction;
  }

  async initialize(_options: AcpInitializeOptions): Promise<{ readonly protocolVersion: 1 }> {
    this.initializeCalls += 1;
    this.log.push("acp.initialize");
    await this.initializeAction();
    return { protocolVersion: 1 };
  }

  async createSession(_options: AcpSessionOptions): Promise<AcpSession> {
    return { sessionId: "session-1" };
  }

  async prompt(
    _sessionId: string,
    _text: string,
    _cancellation: CancellationSignal,
  ): Promise<AcpOutcome> {
    return { kind: "turn", stopReason: "end_turn" };
  }

  async cancel(_sessionId: string): Promise<void> {
    // no-op
  }

  onUpdate(listener: (update: AcpUpdate) => void): Unsubscribe {
    this.updates.add(listener);
    return () => this.updates.delete(listener);
  }

  onFatalError(listener: (error: FatalError) => void): Unsubscribe {
    this.fatalListeners.add(listener);
    return () => this.fatalListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.log.push("acp.close");
  }
}

class FakeMatrix implements MatrixClientAdapter {
  readonly fatalListeners = new Set<(error: FatalError) => void>();
  readonly syncListeners = new Set<(change: MatrixSyncStateChange) => void>();
  readonly syncBatchListeners = new Set<(batch: MatrixSyncBatch) => void | Promise<void>>();
  whoamiCalls = 0;
  startCalls = 0;
  syncBatchSubscriptionCalls = 0;
  stopCalls = 0;
  cryptoInitializeCalls = 0;
  cryptoKeyCalls = 0;
  cryptoCloseCalls = 0;
  readonly log: string[];
  readonly startAction: () => Promise<void>;
  readonly identity: MatrixIdentity = { userId: USER_ID, deviceId: "BRIDGEDEVICE" };

  constructor(log: string[], startAction?: () => Promise<void>) {
    this.log = log;
    this.startAction = startAction ?? (async () => {
      for (const listener of this.syncListeners) {
        listener({ state: "PREPARED", previousState: null });
      }
      for (const listener of this.syncBatchListeners) {
        await listener({ nextBatch: "test-start-cursor", phase: "initial", rooms: [] });
      }
    });
  }

  async whoAmI(): Promise<MatrixIdentity> {
    this.whoamiCalls += 1;
    this.log.push("matrix.whoami");
    return this.identity;
  }

  async initializeCrypto(): Promise<void> {
    this.cryptoInitializeCalls += 1;
    this.log.push("crypto.initialize");
  }

  async getDeviceKeyFingerprints(): Promise<typeof CRYPTO_KEYS> {
    this.cryptoKeyCalls += 1;
    this.log.push("crypto.keys");
    return CRYPTO_KEYS;
  }

  onSyncState(listener: (change: MatrixSyncStateChange) => void): Unsubscribe {
    this.syncListeners.add(listener);
    return () => this.syncListeners.delete(listener);
  }

  onSyncBatch(listener: (batch: MatrixSyncBatch) => void | Promise<void>): Unsubscribe {
    this.syncBatchSubscriptionCalls += 1;
    this.syncBatchListeners.add(listener);
    return () => this.syncBatchListeners.delete(listener);
  }

  onFatalError(listener: (error: FatalError) => void): Unsubscribe {
    this.fatalListeners.add(listener);
    return () => this.fatalListeners.delete(listener);
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    this.log.push("matrix.start");
    await this.startAction();
  }

  stopIntake(): void {
    this.log.push("matrix.stopIntake");
  }

  async sendMessage(_part: RenderedMatrixPart): Promise<void> {
    // no-op
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.log.push("matrix.stop");
  }

  async closeCrypto(): Promise<void> {
    this.cryptoCloseCalls += 1;
    this.log.push("crypto.close");
  }
}

class FakeBridge implements DaemonBridge {
  readonly fatalListeners = new Set<(error: FatalError) => void>();
  readonly log: string[];
  readonly acp: FakeAcp;
  readonly matrix: FakeMatrix;
  readonly initializeAction: () => Promise<void>;
  readonly stopAction: (() => Promise<void>) | undefined;
  intakeOpen = false;
  dispatchOpen = false;
  stopCalls = 0;

  constructor(
    log: string[],
    acp: FakeAcp,
    matrix: FakeMatrix,
    options: {
      readonly initializeAction?: () => Promise<void>;
      readonly stopAction?: () => Promise<void>;
    } = {},
  ) {
    this.log = log;
    this.acp = acp;
    this.matrix = matrix;
    this.initializeAction = options.initializeAction ?? (async () => {});
    this.stopAction = options.stopAction;
  }

  beginStartup(): void {
    this.log.push("bridge.beginStartup");
  }

  async initializeAcp(): Promise<void> {
    this.log.push("bridge.initializeAcp");
    await this.initializeAction();
  }

  openIntake(): void {
    this.intakeOpen = true;
    this.log.push("bridge.openIntake");
  }

  enableDispatch(): void {
    assert.equal(this.intakeOpen, true);
    this.dispatchOpen = true;
    this.log.push("bridge.enableDispatch");
  }

  async handleTimelineEvent(_event: InboundMatrixEvent): Promise<void> {
    // The lifecycle fake receives startup batches through its sync listener.
  }

  onFatalError(listener: (error: FatalError) => void): Unsubscribe {
    this.fatalListeners.add(listener);
    return () => this.fatalListeners.delete(listener);
  }

  emitFatal(error: FatalError): void {
    for (const listener of this.fatalListeners) {
      listener(error);
    }
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.log.push("bridge.stop");
    if (this.stopAction !== undefined) {
      await this.stopAction();
      return;
    }
    await this.matrix.stop();
    await this.acp.close();
  }
}

interface Rig {
  readonly lifecycle: DaemonLifecycle;
  readonly clock: FakeClock;
  readonly lock: FakeStateLock;
  readonly acp: FakeAcp;
  readonly matrix: FakeMatrix;
  readonly bridge: FakeBridge;
  readonly log: string[];
}

function loadedConfiguration(lock: FakeStateLock, config: BridgeConfig = CONFIG): LoadedConfiguration {
  return { config, accessToken: "secret-token", stateLock: lock };
}

async function withRequiredCryptoState(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-required-lifecycle-"));
  try {
    await ensureCryptoDatabaseDirectory(stateDir);
    const store = await openCryptoStateStore({
      stateDir,
      identity: {
        homeserver: CONFIG.matrix.homeserver,
        userId: CONFIG.matrix.userId,
        deviceId: CONFIG.matrix.deviceId,
      },
    });
    await store.recordBootstrap(CRYPTO_KEYS);
    await store.recordSasVerification(CRYPTO_KEYS);
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

function makeRig(options: {
  readonly acp?: FakeAcp;
  readonly matrix?: FakeMatrix;
  readonly bridge?: FakeBridge;
  readonly initializeAction?: () => Promise<void>;
  readonly stopAction?: () => Promise<void>;
  readonly dependencies?: Partial<DaemonDependencies>;
} = {}): Rig {
  const log: string[] = [];
  const clock = new FakeClock();
  const lock = new FakeStateLock();
  const acp = options.acp ?? new FakeAcp(log);
  const matrix = options.matrix ?? new FakeMatrix(log);
  const bridge = options.bridge ?? new FakeBridge(log, acp, matrix, {
    ...(options.initializeAction === undefined ? {} : { initializeAction: options.initializeAction }),
    ...(options.stopAction === undefined ? {} : { stopAction: options.stopAction }),
  });
  const dependencies: DaemonDependencies = {
    clock,
    diagnostics: SILENT_DIAGNOSTICS,
    installSignals: false,
    createAcpClient: () => acp,
    createMatrixClient: () => matrix,
    createBridge: () => bridge,
    ...options.dependencies,
  };
  const lifecycle = new DaemonLifecycle({
    loadedConfiguration: loadedConfiguration(lock),
    dependencies,
  });
  return { lifecycle, clock, lock, acp, matrix, bridge, log };
}

async function waitForReady(rig: Rig): Promise<void> {
  // Required-mode startup performs private-state I/O before opening the gate.
  // A bounded setImmediate loop can exhaust before those callbacks run when
  // the complete test suite is concurrent on a slower Node.js runner.
  const deadline = Date.now() + 5000;
  while (!rig.bridge.dispatchOpen && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(rig.bridge.dispatchOpen, true);
}

void test("parses exactly --config and rejects extra or alternate arguments", () => {
  assert.deepEqual(parseCommandLine(["--config", "bridge.toml"]), {
    configPath: "bridge.toml",
  });
  for (const args of [
    [],
    ["--config"],
    ["--config", "bridge.toml", "extra"],
    ["--config=bridge.toml"],
    ["--config", "--help"],
  ]) {
    assert.throws(() => parseCommandLine(args), /config|Usage/u);
  }
});

void test("parses the exact crypto bootstrap and verification command forms", () => {
  assert.deepEqual(parseCommandLine(["--config", "bridge.toml", "crypto", "bootstrap"]), {
    configPath: "bridge.toml",
    command: { kind: "bootstrap" },
  });
  assert.deepEqual(
    parseCommandLine(["--config", "bridge.toml", "crypto", "verify", "--device", "TRUSTED01"]),
    {
      configPath: "bridge.toml",
      command: { kind: "verify", deviceId: "TRUSTED01" },
    },
  );

  for (const args of [
    ["--config", "bridge.toml", "crypto"],
    ["--config", "bridge.toml", "crypto", "verify"],
    ["--config", "bridge.toml", "crypto", "verify", "--device"],
    ["--config", "bridge.toml", "crypto", "verify", "TRUSTED01", "--device"],
    ["--config", "bridge.toml", "crypto", "bootstrap", "extra"],
    ["--config", "bridge.toml", "crypto", "verify", "--device", "BRIDGE DEVICE"],
    ["--config", "bridge.toml", "crypto", "verify", "--device", "TRUSTED01", "extra"],
  ] as const) {
    assert.throws(() => parseCommandLine(args), /config|Usage/u);
  }
});

void test("crypto commands require required mode and a different verification device", () => {
  assert.throws(
    () => validateCommandForConfig({ kind: "bootstrap" }, CONFIG),
    /require matrix\.encryption = "required"/u,
  );
  const requiredConfig: BridgeConfig = {
    ...CONFIG,
    matrix: { ...CONFIG.matrix, encryption: "required" },
  };
  validateCommandForConfig({ kind: "bootstrap" }, requiredConfig);
  validateCommandForConfig({ kind: "verify", deviceId: "TRUSTED01" }, requiredConfig);
  assert.throws(
    () => validateCommandForConfig({ kind: "verify", deviceId: requiredConfig.matrix.deviceId }, requiredConfig),
    /differ from the bridge device/u,
  );
});

void test("runs startup in order, opens intake at PREPARED, and gates dispatch until ready", async () => {
  const rig = makeRig();
  const run = rig.lifecycle.run();

  // The fake Matrix start emits PREPARED synchronously during its startup
  // operation, so dispatch cannot open before Matrix start finishes.
  await waitForReady(rig);
  assert.deepEqual(rig.log, [
    "matrix.whoami",
    "acp.initialize",
    "bridge.beginStartup",
    "matrix.start",
    "bridge.openIntake",
    "bridge.enableDispatch",
  ]);
  assert.equal(rig.bridge.dispatchOpen, true);

  rig.lifecycle.receiveSignal("SIGTERM");
  assert.equal(await run, 0);
  assert.equal(rig.lock.released, true);
  assert.deepEqual(rig.log.slice(-4), ["bridge.stop", "matrix.stop", "acp.close", "crypto.close"]);
});

void test("daemon composition subscribes to sync batches", async () => {
  const log: string[] = [];
  const lock = new FakeStateLock();
  const acp = new FakeAcp(log);
  const matrix = new FakeMatrix(log);
  let bridge: BridgeCoordinator | undefined;
  const lifecycle = new DaemonLifecycle({
    loadedConfiguration: loadedConfiguration(lock),
    dependencies: {
      diagnostics: SILENT_DIAGNOSTICS,
      installSignals: false,
      createAcpClient: () => acp,
      createMatrixClient: () => matrix,
      createBridge: (context) => {
        bridge = new BridgeCoordinator({
          config: context.config,
          acp: context.acp,
          matrix: context.matrix,
          diagnostics: context.diagnostics,
          clock: context.clock,
          stateStore: context.stateStore,
          loadSession: context.loadSession,
          intakeOpen: false,
          dispatchOpen: false,
        });
        return bridge;
      },
    },
  });

  const run = lifecycle.run();
  while (matrix.startCalls === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(bridge);
  assert.equal(matrix.syncBatchSubscriptionCalls, 1);

  lifecycle.receiveSignal("SIGTERM");
  assert.equal(await run, 0);
});

void test("required startup restores crypto before ACP and does not open gates until Matrix is prepared", async () => {
  await withRequiredCryptoState(async (stateDir) => {
    const config: BridgeConfig = {
      ...CONFIG,
      stateDir,
      matrix: { ...CONFIG.matrix, encryption: "required" },
    };
    const log: string[] = [];
    const lock = new FakeStateLock();
    const acp = new FakeAcp(log);
    const matrix = new FakeMatrix(log);
    const bridge = new FakeBridge(log, acp, matrix);
    const lifecycle = new DaemonLifecycle({
      loadedConfiguration: loadedConfiguration(lock, config),
      dependencies: {
        diagnostics: SILENT_DIAGNOSTICS,
        installSignals: false,
        createAcpClient: () => acp,
        createMatrixClient: () => matrix,
        createBridge: () => bridge,
      },
    });

    const run = lifecycle.run();
    await waitForReady({ lifecycle, clock: new FakeClock(), lock, acp, matrix, bridge, log });

    assert.deepEqual(log.slice(0, 8), [
      "crypto.initialize",
      "matrix.whoami",
      "crypto.keys",
      "acp.initialize",
      "bridge.beginStartup",
      "matrix.start",
      "bridge.openIntake",
      "bridge.enableDispatch",
    ]);
    assert.equal(matrix.cryptoInitializeCalls, 1);
    assert.equal(matrix.cryptoKeyCalls, 1);
    assert.equal(bridge.intakeOpen, true);
    assert.equal(bridge.dispatchOpen, true);

    lifecycle.receiveSignal("SIGTERM");
    assert.equal(await run, 0);
    assert.equal(matrix.cryptoCloseCalls, 1);
    assert.equal(lock.releaseCalls, 1);
  });
});

void test("required startup rejects missing crypto state before Rust initialization or ACP construction", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-missing-crypto-"));
  try {
    const lock = new FakeStateLock();
    const matrix = new FakeMatrix([]);
    let acpCreated = false;
    const lifecycle = new DaemonLifecycle({
      loadedConfiguration: loadedConfiguration(lock, {
        ...CONFIG,
        stateDir,
        matrix: { ...CONFIG.matrix, encryption: "required" },
      }),
      dependencies: {
        diagnostics: SILENT_DIAGNOSTICS,
        installSignals: false,
        createMatrixClient: () => matrix,
        createAcpClient: () => {
          acpCreated = true;
          throw new Error("ACP must not be constructed");
        },
      },
    });

    assert.equal(await lifecycle.run(), 1);
    assert.equal(matrix.cryptoInitializeCalls, 0);
    assert.equal(acpCreated, false);
    assert.equal(matrix.stopCalls, 1);
    assert.equal(matrix.cryptoCloseCalls, 1);
    assert.equal(lock.releaseCalls, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("startup timeout stops already-created resources and returns exit code 1", async () => {
  let resolveInitialize: (() => void) | undefined;
  const initialize = new Promise<void>((resolve) => {
    resolveInitialize = resolve;
  });
  const rig = makeRig({
    acp: new FakeAcp([], () => initialize),
  });
  const run = rig.lifecycle.run();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  rig.clock.advanceBy(1000);

  assert.equal(await run, 1);
  assert.equal(rig.matrix.whoamiCalls, 1);
  assert.equal(rig.acp.closeCalls, 1);
  assert.equal(rig.lock.released, true);
  resolveInitialize?.();
});

void test("cleans up resources in reverse order for each partial startup failure", async () => {
  const stages = ["acp", "matrix", "bridge", "initialize", "whoami", "start"] as const;
  for (const stage of stages) {
    const log: string[] = [];
    const lock = new FakeStateLock();
    const acp = new FakeAcp(log, stage === "initialize"
      ? async () => { throw new Error("failure"); }
      : async () => {});
    const matrix = new FakeMatrix(log);
    const bridge = new FakeBridge(log, acp, matrix);
    const lifecycle = new DaemonLifecycle({
      loadedConfiguration: loadedConfiguration(lock),
      dependencies: {
        diagnostics: SILENT_DIAGNOSTICS,
        installSignals: false,
        createAcpClient: () => {
          if (stage === "acp") {
            throw new Error("failure");
          }
          return acp;
        },
        createMatrixClient: () => {
          if (stage === "matrix") {
            throw new Error("failure");
          }
          return matrix;
        },
        createBridge: () => {
          if (stage === "bridge") {
            throw new Error("failure");
          }
          return bridge;
        },
      },
    });
    if (stage === "whoami") {
      matrix.whoAmI = async () => {
        throw new Error("failure");
      };
    }
    if (stage === "start") {
      matrix.start = async () => {
        throw new Error("failure");
      };
    }

    assert.equal(await lifecycle.run(), 1, stage);
    assert.equal(lock.released, true, stage);
    assert.equal(log.includes("acp.close"), !["acp", "matrix", "whoami"].includes(stage), stage);
    assert.equal(log.includes("matrix.stop"), stage !== "matrix", stage);
  }
});

void test("a first signal exits normally, while a second signal uses the conventional code", async () => {
  const rig = makeRig();
  const exitCodes: number[] = [];
  const lifecycle = new DaemonLifecycle({
    loadedConfiguration: loadedConfiguration(rig.lock),
    dependencies: {
      clock: rig.clock,
      diagnostics: SILENT_DIAGNOSTICS,
      installSignals: false,
      createAcpClient: () => rig.acp,
      createMatrixClient: () => rig.matrix,
      createBridge: () => rig.bridge,
      exit: (code) => {
        exitCodes.push(code);
      },
    },
  });
  const run = lifecycle.run();
  await waitForReady({
    lifecycle,
    clock: rig.clock,
    lock: rig.lock,
    acp: rig.acp,
    matrix: rig.matrix,
    bridge: rig.bridge,
    log: [],
  });
  lifecycle.receiveSignal("SIGTERM");
  lifecycle.receiveSignal("SIGTERM");

  assert.equal(await run, 0);
  assert.deepEqual(exitCodes, [143]);
});

void test("fatal Matrix/runtime state exits 1 and still releases the lock", async () => {
  const rig = makeRig();
  const run = rig.lifecycle.run();
  await waitForReady(rig);
  rig.bridge.emitFatal({ code: "matrix_invariant", message: "room invariant failed" });

  assert.equal(await run, 1);
  assert.equal(rig.bridge.stopCalls, 1);
  assert.equal(rig.lock.released, true);
});

void test("a shutdown grace deadline force-closes adapters and returns exit code 1", async () => {
  const rig = makeRig({ stopAction: () => new Promise<void>(() => {}) });
  const run = rig.lifecycle.run();
  await waitForReady(rig);
  rig.lifecycle.receiveSignal("SIGINT");
  rig.clock.advanceBy(1000);

  assert.equal(await run, 1);
  assert.equal(rig.matrix.stopCalls, 1);
  assert.equal(rig.acp.closeCalls, 1);
  assert.equal(rig.matrix.cryptoCloseCalls, 1);
  assert.equal(rig.lock.released, true);
});
