import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CryptoBootstrapLifecycle,
} from "./main.js";
import type { BridgeConfig, LoadedConfiguration, StateLockLike } from "./config.js";
import type { DiagnosticSink, FatalError } from "./diagnostics.js";
import type { Unsubscribe } from "./cancellation.js";
import type { CryptoDeviceKeyFingerprints } from "./crypto-contracts.js";
import type {
  MatrixClientAdapter,
  MatrixIdentity,
  MatrixSyncBatch,
  MatrixSyncStateChange,
  MatrixSyncStartOptions,
} from "./matrix-client.js";
import type { RenderedMatrixPart } from "./response-rendering.js";

const ROOM_ID = "!room:example.org";
const CONFIG_BASE: Omit<BridgeConfig, "stateDir"> = {
  matrix: {
    homeserver: "https://matrix.example.org",
    userId: "@bridge:example.org",
    deviceId: "BOOTSTRAP-DEVICE",
    accessTokenFile: "/unused/token",
    allowedRooms: [ROOM_ID],
    allowedSenders: ["@alice:example.org"],
    encryption: "required",
  },
  acp: { cwd: "/unused" },
  limits: {
    maxInputBytes: 16_384,
    maxOutputBytes: 256,
    maxMatrixMessageBytes: 128,
    maxQueuedTurnsPerRoom: 2,
    maxConcurrentPrompts: 1,
    maxTurnSeconds: 10,
    shutdownGraceSeconds: 1,
    startupTimeoutSeconds: 5,
    maxCatchupAgeSeconds: 900,
    maxCatchupEventsPerRoom: 4,
  },
};

const DIAGNOSTICS: DiagnosticSink = {
  emit() { /* hermetic test sink */ },
  debug() { /* hermetic test sink */ },
  info() { /* hermetic test sink */ },
  warn() { /* hermetic test sink */ },
  error() { /* hermetic test sink */ },
};

class TestLock implements StateLockLike {
  readonly lockPath: string;
  released = false;

  constructor(stateDir: string) {
    this.lockPath = join(stateDir, ".lock");
  }

  async release(): Promise<void> {
    this.released = true;
  }
}

class TestMatrix implements MatrixClientAdapter {
  readonly fatalListeners = new Set<(error: FatalError) => void>();
  readonly log: string[] = [];
  readonly fingerprints: CryptoDeviceKeyFingerprints;
  readonly identity: MatrixIdentity;
  readonly initializeError: unknown;
  readonly keysError: unknown;
  readonly whoamiError: unknown;
  initializeCalls = 0;
  startCalls = 0;
  stopCalls = 0;
  closeCryptoCalls = 0;
  startOptions: MatrixSyncStartOptions | undefined;

  constructor(options: {
    readonly fingerprints?: CryptoDeviceKeyFingerprints;
    readonly identity?: MatrixIdentity;
    readonly initializeError?: unknown;
    readonly keysError?: unknown;
    readonly whoamiError?: unknown;
  } = {}) {
    this.fingerprints = options.fingerprints ?? {
      ed25519Fingerprint: "ed25519-public",
      curve25519Fingerprint: "curve25519-public",
    };
    this.identity = options.identity ?? {
      userId: CONFIG_BASE.matrix.userId,
      deviceId: CONFIG_BASE.matrix.deviceId,
    };
    this.initializeError = options.initializeError;
    this.keysError = options.keysError;
    this.whoamiError = options.whoamiError;
  }

  async initializeCrypto(): Promise<void> {
    this.log.push("crypto.initialize");
    this.initializeCalls += 1;
    if (this.initializeError !== undefined) {
      throw this.initializeError;
    }
  }

  async getDeviceKeyFingerprints(): Promise<CryptoDeviceKeyFingerprints> {
    this.log.push("crypto.keys");
    if (this.keysError !== undefined) {
      throw this.keysError;
    }
    return this.fingerprints;
  }

  async whoAmI(): Promise<MatrixIdentity> {
    this.log.push("matrix.whoami");
    if (this.whoamiError !== undefined) {
      throw this.whoamiError;
    }
    return this.identity;
  }

  onFatalError(listener: (error: FatalError) => void): Unsubscribe {
    this.fatalListeners.add(listener);
    return () => this.fatalListeners.delete(listener);
  }

  onSyncState(_listener: (change: MatrixSyncStateChange) => void): Unsubscribe {
    return () => {};
  }

  onSyncBatch(_listener: (batch: MatrixSyncBatch) => void | Promise<void>): Unsubscribe {
    return () => {};
  }

  async start(options?: MatrixSyncStartOptions): Promise<void> {
    this.log.push("matrix.start");
    this.startCalls += 1;
    this.startOptions = options;
  }

  stopIntake(): void {
    this.log.push("matrix.stopIntake");
  }

  async sendMessage(_part: RenderedMatrixPart): Promise<void> {
    // Bootstrap has no bridge or outbound messages.
  }

  async stop(): Promise<void> {
    this.log.push("matrix.stop");
    this.stopCalls += 1;
  }

  async closeCrypto(): Promise<void> {
    this.log.push("crypto.close");
    this.closeCryptoCalls += 1;
  }
}

function loaded(stateDir: string, lock: TestLock): LoadedConfiguration {
  return {
    config: { stateDir, ...CONFIG_BASE },
    accessToken: "token-is-never-persisted",
    stateLock: lock,
  };
}

async function withState(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-bootstrap-"));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

function dependencies(matrix: TestMatrix) {
  return {
    diagnostics: DIAGNOSTICS,
    installSignals: false,
    createMatrixClient: () => matrix,
  } as const;
}

void test("crypto bootstrap creates private state, publishes keys before the manifest, and uses no ACP", async () => {
  await withState(async (stateDir) => {
    const lock = new TestLock(stateDir);
    const matrix = new TestMatrix();
    const result = await new CryptoBootstrapLifecycle({
      loadedConfiguration: loaded(stateDir, lock),
      dependencies: dependencies(matrix),
    }).run();

    assert.equal(result, 0);
    assert.equal(lock.released, true);
    assert.deepEqual(matrix.log, [
      "crypto.initialize",
      "matrix.whoami",
      "matrix.start",
      "crypto.keys",
      "matrix.stop",
      "crypto.close",
    ]);
    assert.deepEqual(matrix.startOptions, { intakeEnabled: false });
    const manifest = JSON.parse(await readFile(join(stateDir, "crypto-state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(manifest.bootstrapCompleted, true);
    assert.equal(manifest.sasVerified, false);
    assert.equal("token-is-never-persisted" in manifest, false);
  });
});

void test("interrupted bootstrap resumes the established database and idempotent bootstrap does not replace keys", async () => {
  await withState(async (stateDir) => {
    const failedLock = new TestLock(stateDir);
    const failed = new TestMatrix({ keysError: new Error("sdk failure with secret material") });
    assert.equal(await new CryptoBootstrapLifecycle({
      loadedConfiguration: loaded(stateDir, failedLock),
      dependencies: dependencies(failed),
    }).run(), 1);

    const resumedLock = new TestLock(stateDir);
    const resumed = new TestMatrix();
    assert.equal(await new CryptoBootstrapLifecycle({
      loadedConfiguration: loaded(stateDir, resumedLock),
      dependencies: dependencies(resumed),
    }).run(), 0);

    const idempotentLock = new TestLock(stateDir);
    const idempotent = new TestMatrix();
    assert.equal(await new CryptoBootstrapLifecycle({
      loadedConfiguration: loaded(stateDir, idempotentLock),
      dependencies: dependencies(idempotent),
    }).run(), 0);
    assert.equal(idempotent.initializeCalls, 1);
  });
});

void test("bootstrap rejects wrong whoami, changed fingerprints, and SDK initialization failures without false completion", async () => {
  await withState(async (stateDir) => {
    const wrongIdentity = new TestMatrix({
      identity: { userId: "@wrong:example.org", deviceId: CONFIG_BASE.matrix.deviceId },
    });
    assert.equal(await new CryptoBootstrapLifecycle({
      loadedConfiguration: loaded(stateDir, new TestLock(stateDir)),
      dependencies: dependencies(wrongIdentity),
    }).run(), 1);

    const first = new TestMatrix();
    assert.equal(await new CryptoBootstrapLifecycle({
      loadedConfiguration: loaded(stateDir, new TestLock(stateDir)),
      dependencies: dependencies(first),
    }).run(), 0);

    const changed = new TestMatrix({
      fingerprints: { ed25519Fingerprint: "replacement", curve25519Fingerprint: "curve25519-public" },
    });
    assert.equal(await new CryptoBootstrapLifecycle({
      loadedConfiguration: loaded(stateDir, new TestLock(stateDir)),
      dependencies: dependencies(changed),
    }).run(), 1);
    assert.equal(changed.stopCalls, 1);

    const sdkFailureState = await mkdtemp(join(tmpdir(), "matrix-acp-bootstrap-sdk-"));
    try {
      const sdkFailure = new TestMatrix({ initializeError: new Error("private SDK error") });
      assert.equal(await new CryptoBootstrapLifecycle({
        loadedConfiguration: loaded(sdkFailureState, new TestLock(sdkFailureState)),
        dependencies: dependencies(sdkFailure),
      }).run(), 1);
      await assert.rejects(readFile(join(sdkFailureState, "crypto-state.json")));
    } finally {
      await rm(sdkFailureState, { recursive: true, force: true });
    }
  });
});
