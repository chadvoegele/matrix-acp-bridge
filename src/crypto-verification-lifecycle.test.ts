import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureCryptoDatabaseDirectory, openCryptoStateStore } from "./crypto-state.js";
import { CryptoVerificationLifecycle } from "./main.js";
import type { DaemonProcessLike } from "./main.js";
import type { BridgeConfig, LoadedConfiguration, StateLockLike } from "./config.js";
import type { DiagnosticSink, FatalError } from "./diagnostics.js";
import type { Unsubscribe } from "./cancellation.js";
import type {
  CryptoSasCallbacks,
  CryptoSasVerifier,
  CryptoVerificationRequestHandle,
  CryptoVerificationRequestPhase,
  MatrixCryptoVerificationAdapter,
  MatrixClientAdapter,
  MatrixIdentity,
  MatrixSyncBatch,
  MatrixSyncStateChange,
  MatrixSyncStartOptions,
} from "./matrix-client.js";
import type { CryptoDeviceKeyFingerprints } from "./crypto-contracts.js";
import type { OperatorTty, OperatorTtyFactory } from "./operator-tty.js";
import type { RenderedMatrixPart } from "./response-rendering.js";

const ROOM = "!room:example.org";
const IDENTITY = {
  homeserver: "https://matrix.example.org",
  userId: "@bridge:example.org",
  deviceId: "BRIDGE01",
} as const;
const KEYS: CryptoDeviceKeyFingerprints = {
  ed25519Fingerprint: "ed25519-public",
  curve25519Fingerprint: "curve25519-public",
};

const SILENT_DIAGNOSTICS = {
  emit() { /* hermetic test sink */ },
  debug() { /* hermetic test sink */ },
  info() { /* hermetic test sink */ },
  warn() { /* hermetic test sink */ },
  error() { /* hermetic test sink */ },
} as const;

const CONFIG_BASE: Omit<BridgeConfig, "stateDir"> = {
  matrix: {
    ...IDENTITY,
    accessTokenFile: "/unused/token",
    allowedRooms: [ROOM],
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
    startupTimeoutSeconds: 10,
    maxCatchupAgeSeconds: 900,
    maxCatchupEventsPerRoom: 4,
  },
};

class Lock implements StateLockLike {
  readonly lockPath: string;
  released = false;

  constructor(stateDir: string) {
    this.lockPath = join(stateDir, ".lock");
  }

  async release(): Promise<void> {
    this.released = true;
  }
}

class Tty implements OperatorTty {
  readonly paths: string[];
  readonly pending: boolean;

  constructor(paths: string[], pending = false) {
    this.paths = paths;
    this.pending = pending;
  }

  async write(): Promise<void> {
    // The lifecycle test only checks that this is an independent terminal.
  }

  async readLine(): Promise<string | undefined> {
    if (this.pending) {
      return new Promise<string | undefined>(() => {});
    }
    return "yes";
  }

  async close(): Promise<void> {
    // no-op
  }
}

class Verifier implements CryptoSasVerifier {
  readonly show = new Set<(sas: CryptoSasCallbacks) => void>();
  readonly cancelled = new Set<() => void>();
  resolve: (() => void) | undefined;
  reject: ((error: Error) => void) | undefined;

  onShowSas(listener: (sas: CryptoSasCallbacks) => void): Unsubscribe {
    this.show.add(listener);
    return () => this.show.delete(listener);
  }

  onCancel(listener: () => void): Unsubscribe {
    this.cancelled.add(listener);
    return () => this.cancelled.delete(listener);
  }

  async verify(): Promise<void> {
    const done = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    const sas: CryptoSasCallbacks = {
      emoji: [["😀", "grinning face"]],
      decimal: [1, 2, 3],
      confirm: async () => this.resolve?.(),
      mismatch: () => this.reject?.(new Error("mismatch")),
      cancel: () => this.reject?.(new Error("cancelled")),
    };
    for (const listener of this.show) {
      listener(sas);
    }
    await done;
  }

  cancel(): void {
    for (const listener of this.cancelled) {
      listener();
    }
    this.reject?.(new Error("cancelled"));
  }
}

class Request implements CryptoVerificationRequestHandle {
  readonly userId = IDENTITY.userId;
  readonly deviceId = "TRUSTED01";
  readonly initiatedByMe = true;
  readonly phase: CryptoVerificationRequestPhase = "ready";
  readonly accepting = false;
  readonly chosenMethod = undefined;
  readonly verifier: CryptoSasVerifier | undefined;
  readonly startVerifier: Verifier;

  constructor(verifier: Verifier) {
    this.startVerifier = verifier;
  }

  async accept(): Promise<void> {
    // outgoing requests do not need accept
  }

  supportsMethod(_method: string): boolean {
    return true;
  }

  onChange(_listener: () => void): Unsubscribe {
    return () => {};
  }

  async startVerification(): Promise<CryptoSasVerifier> {
    return this.startVerifier;
  }

  async cancel(): Promise<void> {
    this.startVerifier.cancel();
  }
}

class Crypto implements MatrixCryptoVerificationAdapter {
  readonly request: Request;
  readonly refreshAction: () => Promise<boolean>;

  constructor(request: Request, refreshAction: () => Promise<boolean> = async () => true) {
    this.request = request;
    this.refreshAction = refreshAction;
  }

  async initialize(): Promise<void> {
    // lifecycle calls this through MatrixClientAdapter.
  }

  async getDeviceKeyFingerprints(): Promise<CryptoDeviceKeyFingerprints> {
    return KEYS;
  }

  async close(): Promise<void> {
    // no-op
  }

  async refreshDeviceKeys(): Promise<boolean> {
    return this.refreshAction();
  }

  onVerificationRequest(_listener: (request: CryptoVerificationRequestHandle) => void): Unsubscribe {
    return () => {};
  }

  async requestDeviceVerification(): Promise<CryptoVerificationRequestHandle> {
    return this.request;
  }
}

class Matrix implements MatrixClientAdapter {
  readonly crypto: Crypto;
  readonly fatal = new Set<(error: FatalError) => void>();
  startOptions: MatrixSyncStartOptions | undefined;
  started = false;
  stopped = false;
  initialized = false;

  constructor(crypto: Crypto) {
    this.crypto = crypto;
  }

  async whoAmI(): Promise<MatrixIdentity> {
    return { userId: IDENTITY.userId, deviceId: IDENTITY.deviceId };
  }

  async initializeCrypto(): Promise<void> {
    this.initialized = true;
  }

  async getDeviceKeyFingerprints(): Promise<CryptoDeviceKeyFingerprints> {
    return KEYS;
  }

  getCryptoVerificationAdapter(): MatrixCryptoVerificationAdapter {
    return this.crypto;
  }

  onFatalError(listener: (error: FatalError) => void): Unsubscribe {
    this.fatal.add(listener);
    return () => this.fatal.delete(listener);
  }

  onSyncState(_listener: (change: MatrixSyncStateChange) => void): Unsubscribe {
    return () => {};
  }

  onSyncBatch(_listener: (batch: MatrixSyncBatch) => void | Promise<void>): Unsubscribe {
    return () => {};
  }

  async start(options?: MatrixSyncStartOptions): Promise<void> {
    this.startOptions = options;
    this.started = true;
  }

  stopIntake(): void {
    // no-op
  }

  async sendMessage(_part: RenderedMatrixPart): Promise<void> {
    // no-op
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

class Process implements DaemonProcessLike {
  readonly listeners = new Map<string, () => void>();
  readonly exits: number[] = [];

  on(event: "SIGINT" | "SIGTERM", listener: () => void): void {
    this.listeners.set(event, listener);
  }

  off(event: "SIGINT" | "SIGTERM", listener: () => void): void {
    if (this.listeners.get(event) === listener) {
      this.listeners.delete(event);
    }
  }

  exit(code?: number): never {
    this.exits.push(code ?? 0);
    throw new Error("test process exit");
  }
}

async function state(): Promise<{ readonly stateDir: string; readonly lock: Lock; readonly cleanup: () => Promise<void> }> {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-verification-lifecycle-"));
  await ensureCryptoDatabaseDirectory(stateDir);
  const store = await openCryptoStateStore({ stateDir, identity: IDENTITY });
  await store.recordBootstrap(KEYS);
  const lock = new Lock(stateDir);
  return { stateDir, lock, cleanup: () => rm(stateDir, { recursive: true, force: true }) };
}

function loaded(stateDir: string, lock: Lock): LoadedConfiguration {
  return { config: { stateDir, ...CONFIG_BASE }, accessToken: "token", stateLock: lock };
}

void test("verification lifecycle starts Matrix intake closed, never constructs ACP, and completes cleanly", async () => {
  const fixture = await state();
  try {
    const verifier = new Verifier();
    const matrix = new Matrix(new Crypto(new Request(verifier)));
    const tty = new Tty([]);
    let acpCreated = false;
    const ttyFactory: OperatorTtyFactory = {
      open: async (path) => {
        tty.paths.push(path ?? "");
        return tty;
      },
    };
    const result = await new CryptoVerificationLifecycle({
      loadedConfiguration: loaded(fixture.stateDir, fixture.lock),
      targetDeviceId: "TRUSTED01",
      dependencies: {
        installSignals: false,
        diagnostics: SILENT_DIAGNOSTICS,
        operatorTtyFactory: ttyFactory,
        createMatrixClient: () => matrix,
        createAcpClient: () => {
          acpCreated = true;
          throw new Error("ACP must not be created for crypto verification");
        },
      },
    }).run();
    assert.equal(result, 0);
    assert.equal(acpCreated, false);
    assert.deepEqual(matrix.startOptions, { intakeEnabled: false });
    assert.equal(matrix.initialized, true);
    assert.equal(matrix.stopped, true);
    assert.equal(fixture.lock.released, true);
    assert.deepEqual(tty.paths, ["/dev/tty"]);
    const manifest = JSON.parse(await readFile(join(fixture.stateDir, "crypto-state.json"), "utf8")) as {
      readonly sasVerified: boolean;
    };
    assert.equal(manifest.sasVerified, true);
  } finally {
    await fixture.cleanup();
  }
});

void test("verification rejects missing established crypto state before Rust initialization", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-verification-missing-crypto-"));
  try {
    const lock = new Lock(stateDir);
    let matrixCreated = false;
    const result = await new CryptoVerificationLifecycle({
      loadedConfiguration: loaded(stateDir, lock),
      targetDeviceId: "TRUSTED01",
      dependencies: {
        installSignals: false,
        diagnostics: SILENT_DIAGNOSTICS,
        createMatrixClient: () => {
          matrixCreated = true;
          throw new Error("Matrix must not be created for missing crypto state");
        },
      },
    }).run();

    assert.equal(result, 1);
    assert.equal(matrixCreated, false);
    assert.equal(lock.released, true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("verification failure diagnostics emit only the safe reason enum", async () => {
  const fixture = await state();
  const records: Array<{
    readonly event: string;
    readonly fields: Readonly<Record<string, string | number | boolean | null>>;
  }> = [];
  const diagnostics: DiagnosticSink = {
    emit(_level, event, fields = {}) {
      records.push({ event, fields });
    },
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  try {
    const matrix = new Matrix(new Crypto(
      new Request(new Verifier()),
      async () => {
        throw new Error("raw SDK failure with private identity text");
      },
    ));
    const result = await new CryptoVerificationLifecycle({
      loadedConfiguration: loaded(fixture.stateDir, fixture.lock),
      targetDeviceId: "TRUSTED01",
      dependencies: {
        installSignals: false,
        diagnostics,
        operatorTtyFactory: { open: async () => new Tty([]) },
        createMatrixClient: () => matrix,
      },
    }).run();

    assert.equal(result, 1);
    const failure = records.find((record) => record.event === "crypto-verification-failed");
    assert.deepEqual(failure?.fields, { reason: "protocol" });
    assert.equal(JSON.stringify(records).includes("raw SDK failure"), false);
  } finally {
    await fixture.cleanup();
  }
});

void test("first signal cancels verification and second signal uses the conventional exit code", async () => {
  const fixture = await state();
  try {
    const verifier = new Verifier();
    const matrix = new Matrix(new Crypto(new Request(verifier)));
    const processLike = new Process();
    const lifecycle = new CryptoVerificationLifecycle({
      loadedConfiguration: loaded(fixture.stateDir, fixture.lock),
      targetDeviceId: "TRUSTED01",
      dependencies: {
        process: processLike,
        diagnostics: SILENT_DIAGNOSTICS,
        operatorTtyFactory: { open: async () => new Tty([], true) },
        createMatrixClient: () => matrix,
      },
    });
    const pending = lifecycle.run();
    for (let attempt = 0; attempt < 20 && verifier.show.size === 0; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    lifecycle.receiveSignal("SIGTERM");
    lifecycle.receiveSignal("SIGTERM");
    assert.deepEqual(processLike.exits, [143]);
    assert.equal(await pending, 1);
    assert.equal(fixture.lock.released, true);
  } finally {
    await fixture.cleanup();
  }
});
