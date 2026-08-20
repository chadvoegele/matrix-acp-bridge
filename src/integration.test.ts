import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TextDecoder, TextEncoder } from "node:util";

import { createAcpClient } from "./acp-client.js";
import { BridgeCoordinator } from "./bridge.js";
import type { LoadedConfiguration, StateLockLike } from "./config.js";
import { FakeClock } from "./test-support/fake-clock.js";
import {
  DaemonLifecycle,
  type DaemonExitCode,
  CryptoBootstrapLifecycle,
  CryptoVerificationLifecycle,
} from "./main.js";
import {
  createMatrixClientAdapter,
  type MatrixClientAdapterImpl,
  type MatrixSdkClientLike,
  type MatrixSdkEventLike,
  type MatrixSdkRoomLike,
} from "./matrix-client.js";
import { computeMatrixTransactionId } from "./response-rendering.js";
import type { BridgeConfig, MatrixConfig } from "./config.js";
import type { BridgeStateStore } from "./bridge-state.js";
import type { DiagnosticSink } from "./diagnostics.js";
import type { Unsubscribe } from "./cancellation.js";
import type {
  CryptoSasCallbacks,
  CryptoSasVerifier,
  CryptoVerificationRequestHandle,
  MatrixCryptoVerificationAdapter,
  MatrixSyncBatch,
} from "./matrix-client.js";
import type {
  CryptoDeviceKeyFingerprints,
  CryptoInitializationOptions,
  MatrixCryptoAdapter,
} from "./crypto-contracts.js";
import type { OperatorTty } from "./operator-tty.js";

const ROOM_ONE = "!one:example.org";
const ROOM_TWO = "!two:example.org";
const BRIDGE_USER = "@bridge:example.org";
const ALICE = "@alice:example.org";
const DEFAULT_STATE_DIR = await mkdtemp(join(tmpdir(), "matrix-acp-integration-default-"));

const SILENT_DIAGNOSTICS: DiagnosticSink = {
  emit() {
    // Integration assertions inspect protocol and adapter observations, not logs.
  },
  debug() {
    // no-op
  },
  info() {
    // no-op
  },
  warn() {
    // no-op
  },
  error() {
    // no-op
  },
};

const MATRIX_CONFIG: MatrixConfig = {
  homeserver: "https://matrix.example.org",
  userId: BRIDGE_USER,
  deviceId: "BRIDGE-DEVICE",
  accessTokenFile: "/private/state/matrix-token",
  allowedRooms: [ROOM_ONE, ROOM_TWO],
  allowedSenders: [ALICE],
  encryption: "disabled",
};

const CONFIG: BridgeConfig = {
  stateDir: DEFAULT_STATE_DIR,
  matrix: MATRIX_CONFIG,
  acp: { cwd: "/private/agent-workspace" },
  limits: {
    maxInputBytes: 16_384,
    maxOutputBytes: 262_144,
    maxMatrixMessageBytes: 32_768,
    maxQueuedTurnsPerRoom: 2,
    maxConcurrentPrompts: 2,
    maxTurnSeconds: 60,
    shutdownGraceSeconds: 1,
    startupTimeoutSeconds: 10,
    initialSyncTimelineLimit: 100,
    maxCatchupAgeSeconds: 900,
    maxCatchupEventsPerRoom: 4,
  },
};

test.after(async () => {
  await rm(DEFAULT_STATE_DIR, { recursive: true, force: true });
});

interface JsonRpcFrame {
  readonly [key: string]: unknown;
}

interface PromptCall {
  readonly index: number;
  readonly sessionId: string;
  readonly text: string;
  update(text: string, messageId: string): void;
  respond(stopReason?: string): void;
}

interface FakeAcpPeerOptions {
  readonly advertiseLoadSession?: boolean;
  readonly staleSessionIds?: readonly string[];
  readonly sessionStartAt?: number;
}

/**
 * A small ACP peer that speaks the real line-delimited wire protocol.  It is
 * deliberately below the ACP adapter boundary: tests cannot accidentally
 * bypass request serialization, response matching, or update parsing.
 */
class FakeAcpPeer {
  readonly input: ReadableStream<Uint8Array>;
  readonly output: WritableStream<Uint8Array>;
  readonly frames: JsonRpcFrame[] = [];
  readonly sessionRequests: JsonRpcFrame[] = [];
  readonly loadRequests: JsonRpcFrame[] = [];
  readonly prompts: PromptCall[] = [];
  readonly cancelRequests: string[] = [];
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();
  #inputController: ReadableStreamDefaultController<Uint8Array> | undefined;
  #inputClosed = false;
  #inputBuffer = "";
  #nextSession = 0;
  readonly #advertiseLoadSession: boolean;
  readonly #staleSessionIds: ReadonlySet<string>;

  constructor(options: FakeAcpPeerOptions = {}) {
    this.#advertiseLoadSession = options.advertiseLoadSession === true;
    this.#staleSessionIds = new Set(options.staleSessionIds ?? []);
    this.#nextSession = options.sessionStartAt ?? 0;
    this.input = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#inputController = controller;
      },
    });
    this.output = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.#inputBuffer += this.#decoder.decode(chunk, { stream: true });
        this.#consumeFrames();
      },
    });
  }

  closeInput(): void {
    if (this.#inputClosed) {
      return;
    }
    this.#inputClosed = true;
    this.#inputController?.close();
  }

  #consumeFrames(): void {
    let newline = this.#inputBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#inputBuffer.slice(0, newline);
      this.#inputBuffer = this.#inputBuffer.slice(newline + 1);
      newline = this.#inputBuffer.indexOf("\n");
      if (line.trim().length === 0) {
        continue;
      }
      const frame = JSON.parse(line) as JsonRpcFrame;
      this.frames.push(frame);
      this.#handleFrame(frame);
    }
  }

  #push(frame: JsonRpcFrame): void {
    if (this.#inputClosed) {
      return;
    }
    this.#inputController?.enqueue(
      this.#encoder.encode(`${JSON.stringify(frame)}\n`),
    );
  }

  #response(id: unknown, result: unknown): void {
    this.#push({ jsonrpc: "2.0", id, result });
  }

  #handleFrame(frame: JsonRpcFrame): void {
    const method = frame.method;
    if (typeof method !== "string") {
      return;
    }

    if (method === "initialize") {
      this.#response(frame.id, {
        protocolVersion: 1,
        ...(this.#advertiseLoadSession ? { agentCapabilities: { loadSession: true } } : {}),
      });
      return;
    }

    if (method === "session/new") {
      this.sessionRequests.push(frame);
      this.#nextSession += 1;
      this.#response(frame.id, { sessionId: `session-${this.#nextSession}` });
      return;
    }

    if (method === "session/load") {
      this.loadRequests.push(frame);
      const parameters = frame.params as Record<string, unknown> | undefined;
      const sessionId = typeof parameters?.sessionId === "string" ? parameters.sessionId : "invalid-session";
      if (this.#staleSessionIds.has(sessionId)) {
        this.#push({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32_000, message: "stale session" },
        });
        return;
      }
      this.#push({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "replayed history must stay hidden" },
            messageId: "history",
          },
        },
      });
      this.#response(frame.id, {});
      return;
    }

    if (method === "session/cancel") {
      const parameters = frame.params as Record<string, unknown> | undefined;
      if (typeof parameters?.sessionId === "string") {
        this.cancelRequests.push(parameters.sessionId);
      }
      return;
    }

    if (method !== "session/prompt") {
      return;
    }

    const parameters = frame.params as Record<string, unknown> | undefined;
    const sessionId = typeof parameters?.sessionId === "string"
      ? parameters.sessionId
      : "invalid-session";
    const prompt = Array.isArray(parameters?.prompt)
      ? (parameters.prompt as readonly unknown[])[0]
      : undefined;
    const promptRecord = prompt as Record<string, unknown> | undefined;
    const text = typeof promptRecord?.text === "string" ? promptRecord.text : "";
    let responseSent = false;
    const index = this.prompts.length;
    const call: PromptCall = {
      index,
      sessionId,
      text,
      update: (chunk, messageId) => {
        const update: Record<string, unknown> = {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk },
          messageId,
        };
        this.#push({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId, update },
        });
      },
      respond: (stopReason = "end_turn") => {
        if (responseSent) {
          return;
        }
        responseSent = true;
        this.#response(frame.id, { stopReason });
      },
    };
    this.prompts.push(call);
  }
}

interface MatrixSendAttempt {
  readonly roomId: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly transactionId: string | undefined;
  /** The fake SDK's modeled wire event; production passes encryption to SDK. */
  readonly wireEncrypted?: boolean;
}

interface MatrixTypingAttempt {
  readonly roomId: string;
  readonly isTyping: boolean;
  readonly timeoutMs: number;
}

interface MatrixReceiptAttempt {
  readonly roomId: string;
  readonly eventId: string;
}

type SdkListener = (...args: unknown[]) => void;

/** Injectable SDK boundary used as a deterministic Matrix homeserver harness. */
class MatrixSdkHarness implements MatrixSdkClientLike {
  readonly listeners = new Map<string, Set<SdkListener>>();
  readonly rooms = new Map<string, MatrixSdkRoomLike>();
  readonly attempts: MatrixSendAttempt[] = [];
  readonly sent: MatrixSendAttempt[] = [];
  readonly typing: MatrixTypingAttempt[] = [];
  readonly receipts: MatrixReceiptAttempt[] = [];
  readonly operations: string[] = [];
  readonly encryptedRooms: boolean;
  startCalls = 0;
  readonly startupInitialSyncLimits: number[] = [];
  stopCalls = 0;
  startClientAction: () => void | Promise<void> = () => {
    this.emit("sync", "PREPARED", null, { nextSyncToken: "default-start-cursor" });
  };
  sendBehavior: (attempt: MatrixSendAttempt) => void | Promise<void> = () => {};

  constructor(encryptedRooms = false) {
    this.encryptedRooms = encryptedRooms;
    this.rooms.set(ROOM_ONE, room(ROOM_ONE, encryptedRooms));
    this.rooms.set(ROOM_TWO, room(ROOM_TWO, encryptedRooms));
  }

  on(event: string, listener: SdkListener): void {
    let listeners = this.listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  off(event: string, listener: SdkListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of (this.listeners.get(event) ?? [])) {
      listener(...args);
    }
  }

  emitInbound(event: MatrixSdkEventLike): void {
    this.emit("event", event);
  }

  async whoami(): Promise<unknown> {
    return { user_id: BRIDGE_USER, device_id: MATRIX_CONFIG.deviceId };
  }

  getCrypto(): {
    getOwnDeviceKeys(): Promise<unknown>;
    isEncryptionEnabledInRoom(roomId: string): Promise<boolean>;
  } {
    return {
      getOwnDeviceKeys: async () => ({
        ed25519: "sdk-ed25519",
        curve25519: "sdk-curve25519",
      }),
      isEncryptionEnabledInRoom: async (_roomId: string) => this.encryptedRooms,
    };
  }

  async getJoinedRooms(): Promise<{ readonly joined_rooms: readonly string[] }> {
    return { joined_rooms: [...this.rooms.keys()] };
  }

  async startClient(options?: { readonly initialSyncLimit?: number }): Promise<void> {
    this.startCalls += 1;
    this.startupInitialSyncLimits.push(options?.initialSyncLimit ?? 0);
    await this.startClientAction();
  }

  stopClient(): void {
    this.stopCalls += 1;
  }

  getRoom(roomId: string): MatrixSdkRoomLike | null {
    return this.rooms.get(roomId) ?? null;
  }

  async sendMessage(
    roomId: string,
    content: Readonly<Record<string, unknown>>,
    transactionId?: string,
  ): Promise<void> {
    const attempt: MatrixSendAttempt = {
      roomId,
      content,
      transactionId,
      ...(this.encryptedRooms ? { wireEncrypted: true } : {}),
    };
    this.attempts.push(attempt);
    this.operations.push(`message:${typeof content.body === "string" ? content.body : ""}`);
    await this.sendBehavior(attempt);
    this.sent.push(attempt);
  }

  async sendTyping(roomId: string, isTyping: boolean, timeoutMs: number): Promise<void> {
    this.typing.push({ roomId, isTyping, timeoutMs });
    this.operations.push(`typing:${isTyping ? "on" : "off"}`);
  }

  async sendReadReceiptById(roomId: string, eventId: string): Promise<void> {
    this.receipts.push({ roomId, eventId });
    this.operations.push(`receipt:${eventId}`);
  }
}

function room(roomId: string, encrypted = false): MatrixSdkRoomLike {
  return {
    roomId,
    getMyMembership: () => "join",
    hasEncryptionStateEvent: () => encrypted,
  };
}

interface EventOptions {
  readonly roomId?: string;
  readonly eventId: string;
  readonly sender?: string;
  readonly body?: string;
  readonly originServerTs?: number;
  readonly encrypted?: boolean;
  readonly clearContent?: unknown;
  readonly decryptionFailure?: boolean;
}

function sdkEvent(options: EventOptions): MatrixSdkEventLike {
  const roomId = options.roomId ?? ROOM_ONE;
  const sender = options.sender ?? ALICE;
  const body = options.body ?? "hello";
  const encrypted = options.encrypted === true;
  return {
    getRoomId: () => roomId,
    getId: () => options.eventId,
    getTs: () => options.originServerTs ?? 0,
    getSender: () => sender,
    getType: () => encrypted ? "m.room.encrypted" : "m.room.message",
    getContent: () => encrypted
      ? { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "opaque-ciphertext" }
      : ({ msgtype: "m.text", body }),
    isEncrypted: () => encrypted,
    isRedacted: () => false,
    getClearContent: () => encrypted ? (options.clearContent ?? null) : null,
    getClearType: () => encrypted ? "m.room.message" : undefined,
    ...(options.decryptionFailure === true ? { isDecryptionFailure: () => true } : {}),
    // eslint-disable-next-line unicorn/no-useless-undefined -- this fake has no state key
    getStateKey: () => undefined,
  };
}

const BRIDGE_FINGERPRINTS: CryptoDeviceKeyFingerprints = {
  ed25519Fingerprint: "bridge-ed25519-stable",
  curve25519Fingerprint: "bridge-curve25519-stable",
};
const TRUSTED_DEVICE = "TRUSTED-DEVICE";

/** Deterministic Rust-crypto substitute shared by the command and daemon rigs. */
class HermeticCrypto implements MatrixCryptoVerificationAdapter {
  readonly fingerprints: CryptoDeviceKeyFingerprints;
  readonly initializationPaths: string[] = [];
  readonly forbiddenCalls: string[] = [];
  initializeCalls = 0;
  closeCalls = 0;
  requestCalls: Array<{ readonly userId: string; readonly deviceId: string }> = [];
  #closed = false;
  #incoming = new Set<(request: CryptoVerificationRequestHandle) => void>();

  constructor(fingerprints: CryptoDeviceKeyFingerprints = BRIDGE_FINGERPRINTS) {
    this.fingerprints = { ...fingerprints };
  }

  async initialize(options: CryptoInitializationOptions): Promise<void> {
    if (this.#closed) {
      throw new Error("crypto adapter closed");
    }
    this.initializeCalls += 1;
    this.initializationPaths.push(options.state.databasePath);
  }

  async getDeviceKeyFingerprints(): Promise<CryptoDeviceKeyFingerprints> {
    if (this.#closed) {
      throw new Error("crypto adapter closed");
    }
    return { ...this.fingerprints };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.#closed = true;
  }

  async refreshDeviceKeys(_userId: string, _deviceId: string): Promise<boolean> {
    if (this.#closed) {
      throw new Error("crypto adapter closed");
    }
    return true;
  }

  async requestDeviceVerification(
    userId: string,
    deviceId: string,
  ): Promise<CryptoVerificationRequestHandle> {
    this.requestCalls.push({ userId, deviceId });
    return new HermeticVerificationRequest(userId, deviceId);
  }

  onVerificationRequest(
    listener: (request: CryptoVerificationRequestHandle) => void,
  ): () => void {
    this.#incoming.add(listener);
    return () => this.#incoming.delete(listener);
  }
}

class HermeticSasVerifier implements CryptoSasVerifier {
  #showListener: ((sas: CryptoSasCallbacks) => void) | undefined;
  #cancelListeners = new Set<() => void>();
  #reject: ((error: Error) => void) | undefined;
  #settled = false;

  onShowSas(listener: (sas: CryptoSasCallbacks) => void): () => void {
    this.#showListener = listener;
    return () => {
      this.#showListener = undefined;
    };
  }

  onCancel(listener: () => void): () => void {
    this.#cancelListeners.add(listener);
    return () => this.#cancelListeners.delete(listener);
  }

  verify(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#reject = reject;
      this.#showListener?.({
        emoji: [["🐈", "cat"]],
        decimal: [123, 456, 789],
        confirm: async () => {
          this.#settled = true;
          resolve();
        },
        mismatch: () => {
          this.#settled = true;
          reject(new Error("SAS mismatch"));
        },
        cancel: () => {
          this.#settled = true;
          reject(new Error("SAS cancelled"));
        },
      });
    });
  }

  cancel(): void {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.#reject?.(new Error("SAS cancelled"));
    for (const listener of this.#cancelListeners) {
      listener();
    }
  }
}

class HermeticVerificationRequest implements CryptoVerificationRequestHandle {
  readonly initiatedByMe = true;
  readonly phase = "ready" as const;
  readonly accepting = false;
  readonly chosenMethod = "m.sas.v1";
  readonly verifier = new HermeticSasVerifier();
  cancelled = false;

  constructor(
    readonly userId: string,
    readonly deviceId: string,
  ) {}

  async accept(): Promise<void> {
    // The hermetic request is initiated by the bridge, so no accept is needed.
  }

  supportsMethod(method: string): boolean {
    return method === "m.sas.v1";
  }

  onChange(_listener: () => void): Unsubscribe {
    return () => {};
  }

  async startVerification(_method: "m.sas.v1"): Promise<CryptoSasVerifier> {
    return this.verifier;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.verifier.cancel();
  }
}

class HermeticTty implements OperatorTty {
  readonly writes: string[] = [];
  closed = false;

  constructor(readonly answer: string | undefined = "yes") {}

  async write(text: string): Promise<void> {
    this.writes.push(text);
  }

  async readLine(): Promise<string | undefined> {
    return this.answer;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class IntegrationStateLock implements StateLockLike {
  readonly lockPath: string;
  released = false;

  constructor(stateDir: string) {
    this.lockPath = `${stateDir}/.lock`;
  }

  async release(): Promise<void> {
    this.released = true;
  }
}

interface IntegrationRig {
  readonly clock: FakeClock;
  readonly peer: FakeAcpPeer;
  readonly matrixSdk: MatrixSdkHarness;
  readonly acp: ReturnType<typeof createAcpClient>;
  readonly matrix: MatrixClientAdapterImpl;
  readonly bridge: BridgeCoordinator;
  readonly lifecycle: DaemonLifecycle;
  readonly lock: IntegrationStateLock;
  readonly stateStore: BridgeStateStore | undefined;
  readonly batches: MatrixSyncBatch[];
}

interface IntegrationRigOptions {
  readonly advertiseLoadSession?: boolean;
  readonly staleSessionIds?: readonly string[];
  readonly sessionStartAt?: number;
  readonly clockStartAt?: number;
  readonly encryptedRooms?: boolean;
  readonly cryptoAdapter?: MatrixCryptoAdapter;
  readonly gateStateFlush?: {
    readonly started: () => void;
    readonly wait: Promise<void>;
  };
}

function createRig(
  config: BridgeConfig = CONFIG,
  options: IntegrationRigOptions = {},
): IntegrationRig {
  const clock = new FakeClock(options.clockStartAt ?? 0);
  const peer = new FakeAcpPeer(options);
  const matrixSdk = new MatrixSdkHarness(
    options.encryptedRooms ?? config.matrix.encryption === "required",
  );
  const acp = createAcpClient({
    cwd: config.acp.cwd,
    input: peer.input,
    output: peer.output,
    diagnostics: SILENT_DIAGNOSTICS,
  });
  const matrix = createMatrixClientAdapter(
    config.matrix,
    "integration-access-token",
    {
      client: matrixSdk,
      ...(options.cryptoAdapter === undefined ? {} : { cryptoAdapter: options.cryptoAdapter }),
    },
  );
  const batches: MatrixSyncBatch[] = [];
  matrix.onSyncBatch((batch) => {
    batches.push(batch);
  });
  let activeBridge: BridgeCoordinator | undefined;
  let stateStore: BridgeStateStore | undefined;
  const lock = new IntegrationStateLock(config.stateDir);
  const loaded: LoadedConfiguration = {
    config,
    accessToken: "integration-access-token",
    stateLock: lock,
  };
  const lifecycle = new DaemonLifecycle({
    loadedConfiguration: loaded,
    dependencies: {
      clock,
      diagnostics: SILENT_DIAGNOSTICS,
      installSignals: false,
      createAcpClient: () => acp,
      createMatrixClient: () => matrix,
      createBridge: (context) => {
        stateStore = context.stateStore;
        if (options.gateStateFlush !== undefined && context.stateStore?.flush !== undefined) {
          const originalFlush = context.stateStore.flush.bind(context.stateStore);
          context.stateStore.flush = async () => {
            options.gateStateFlush!.started();
            await options.gateStateFlush!.wait;
            await originalFlush();
          };
        }
        activeBridge = new BridgeCoordinator({
          config: context.config,
          acp: context.acp,
          matrix: context.matrix,
          diagnostics: context.diagnostics,
          clock: context.clock,
          random: () => 0,
          stateStore: context.stateStore,
          loadSession: context.loadSession,
          intakeOpen: false,
          dispatchOpen: false,
        });
        return activeBridge;
      },
    },
  });
  const rig: IntegrationRig = {
    clock,
    peer,
    matrixSdk,
    acp,
    matrix,
    get bridge() {
      if (activeBridge === undefined) {
        throw new Error("bridge is not initialized");
      }
      return activeBridge;
    },
    lifecycle,
    lock,
    get stateStore() {
      return stateStore;
    },
    batches,
  };
  return rig;
}

function requiredConfig(stateDir: string): BridgeConfig {
  return {
    ...CONFIG,
    stateDir,
    matrix: { ...MATRIX_CONFIG, encryption: "required" },
  };
}

function loadedConfiguration(config: BridgeConfig): LoadedConfiguration {
  return {
    config,
    accessToken: "integration-access-token",
    stateLock: new IntegrationStateLock(config.stateDir),
  };
}

function cryptoMatrixAdapter(
  config: BridgeConfig,
  sdk: MatrixSdkHarness,
  crypto: MatrixCryptoAdapter,
): MatrixClientAdapterImpl {
  return createMatrixClientAdapter(
    config.matrix,
    "integration-access-token",
    { client: sdk, cryptoAdapter: crypto, diagnostics: SILENT_DIAGNOSTICS },
  );
}

async function bootstrapCryptoState(
  config: BridgeConfig,
  fingerprints: CryptoDeviceKeyFingerprints = BRIDGE_FINGERPRINTS,
): Promise<void> {
  const sdk = new MatrixSdkHarness(true);
  const crypto = new HermeticCrypto(fingerprints);
  const exit = await new CryptoBootstrapLifecycle({
    loadedConfiguration: loadedConfiguration(config),
    dependencies: {
      clock: new FakeClock(0),
      diagnostics: SILENT_DIAGNOSTICS,
      installSignals: false,
      createMatrixClient: () => cryptoMatrixAdapter(config, sdk, crypto),
    },
  }).run();
  assert.equal(exit, 0);
  assert.equal(crypto.initializeCalls, 1);
}

async function verifyCryptoState(
  config: BridgeConfig,
  fingerprints: CryptoDeviceKeyFingerprints = BRIDGE_FINGERPRINTS,
): Promise<HermeticTty> {
  const sdk = new MatrixSdkHarness(true);
  const crypto = new HermeticCrypto(fingerprints);
  const tty = new HermeticTty("yes");
  const exit = await new CryptoVerificationLifecycle({
    loadedConfiguration: loadedConfiguration(config),
    targetDeviceId: TRUSTED_DEVICE,
    dependencies: {
      clock: new FakeClock(0),
      diagnostics: SILENT_DIAGNOSTICS,
      installSignals: false,
      createMatrixClient: () => cryptoMatrixAdapter(config, sdk, crypto),
      operatorTtyFactory: { open: async () => tty },
    },
  }).run();
  assert.equal(exit, 0);
  assert.equal(tty.closed, true);
  return tty;
}

async function prepareVerifiedCryptoState(
  config: BridgeConfig,
  fingerprints: CryptoDeviceKeyFingerprints = BRIDGE_FINGERPRINTS,
): Promise<void> {
  await bootstrapCryptoState(config, fingerprints);
  await verifyCryptoState(config, fingerprints);
  const manifest = JSON.parse(
    await readFile(join(config.stateDir, "crypto-state.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(manifest.bootstrapCompleted, true);
  assert.equal(manifest.sasVerified, true);
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function flushMany(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await flush();
  }
}

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  // Keep the quick microtask turn for hermetic events, but periodically yield
  // to real I/O. A setImmediate-only loop can finish all turns before slower
  // filesystem callbacks run when the test suite is concurrent on Node.js.
  const deadline = Date.now() + 5000;
  for (let turn = 0; Date.now() < deadline; turn += 1) {
    if (condition()) {
      return;
    }
    await (turn % 100 === 99 ? new Promise<void>((resolve) => setTimeout(resolve, 1)) : flush());
  }
  throw new Error(`Timed out waiting for ${description}`);
}

void test("integration wait helper honors its timeout beyond quick-turn progress", async () => {
  let turns = 0;
  await waitFor(() => turns++ >= 10_000, "delayed condition");
});

async function startRig(
  rig: IntegrationRig,
): Promise<{ readonly run: Promise<DaemonExitCode> }> {
  const run = rig.lifecycle.run();
  try {
    await waitFor(
      () => rig.matrix.lifecycle === "ready" && rig.bridge.dispatchOpen,
      "daemon startup",
    );
    return { run };
  } catch (error) {
    rig.lifecycle.receiveSignal("SIGTERM");
    rig.clock.advanceBy(1000);
    await run;
    throw error;
  }
}

async function stopRig(
  rig: IntegrationRig,
  run: Promise<DaemonExitCode>,
): Promise<void> {
  if (rig.lifecycle.fatalError === undefined) {
    rig.lifecycle.receiveSignal("SIGTERM");
  }
  await flushMany();
  rig.clock.advanceBy(1000);
  await run;
}

async function completePrompt(
  rig: IntegrationRig,
  call: PromptCall,
  reply: string,
): Promise<void> {
  call.update(reply, `message-${call.index}`);
  await flushMany(2);
  call.respond();
  await waitFor(
    () => rig.bridge.unresolvedPromptCount === 0,
    `ACP response for ${call.text}`,
  );
  rig.clock.advanceBy(300);
  await waitFor(
    () => rig.matrixSdk.sent.some((attempt) => attempt.content.body === reply),
    `Matrix delivery for ${call.text}`,
  );
}

async function completeAbandonedPrompt(
  rig: IntegrationRig,
  call: PromptCall,
  reply: string,
  expectedAttempts: number,
): Promise<void> {
  call.update(reply, `message-${call.index}`);
  await flushMany(2);
  call.respond();
  await waitFor(
    () => rig.bridge.unresolvedPromptCount === 0,
    `ACP response for abandoned ${call.text}`,
  );
  rig.clock.advanceBy(300);
  await waitFor(
    () => rig.matrixSdk.attempts.length >= expectedAttempts &&
      !rig.bridge.isRoomActive(ROOM_ONE),
    `permanent Matrix abandonment for ${call.text}`,
  );
}

void test("integration suppresses the complete first sync, delivers live text, and rejects self-loop input", async () => {
  const rig = createRig();
  const initial = sdkEvent({
    eventId: "$initial:example.org",
    body: "must be suppressed",
  });
  const buffered = sdkEvent({
    eventId: "$buffered:example.org",
    body: "startup-buffered",
  });
  rig.matrixSdk.startClientAction = () => {
    rig.matrixSdk.emit("event", initial);
    rig.matrixSdk.emit(
      "Room.timeline",
      initial,
      undefined,
      false,
      false,
      { liveEvent: false },
    );
    rig.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "startup-cursor" });
    // This event is still part of the complete first batch and must join the
    // durable baseline rather than becoming an ACP prompt.
    rig.matrixSdk.emitInbound(buffered);
  };

  const { run } = await startRig(rig);
  try {
    assert.equal(rig.peer.prompts.length, 0);
    assert.deepEqual(
      rig.batches[0]?.rooms[0]?.timeline.map((event) => event.eventId),
      ["$initial:example.org", "$buffered:example.org"],
    );

    const live = sdkEvent({ eventId: "$live:example.org", body: "live text" });
    const self = sdkEvent({
      eventId: "$self:example.org",
      sender: BRIDGE_USER,
      body: "bridge output must not loop",
    });
    rig.matrixSdk.emitInbound(live);
    rig.matrixSdk.emitInbound(self);
    rig.matrixSdk.emit("sync", "SYNCING", "PREPARED", { nextSyncToken: "live-cursor" });

    await waitFor(() => rig.peer.prompts.length === 1, "post-ready live ACP prompt");
    assert.deepEqual(rig.peer.prompts.map((prompt) => prompt.text), ["live text"]);
    await completePrompt(rig, rig.peer.prompts[0]!, "live reply");

    const liveSend = rig.matrixSdk.sent.find(
      (attempt) => attempt.content.body === "live reply",
    );
    assert.ok(liveSend);
    assert.equal(liveSend.roomId, ROOM_ONE);
    assert.deepEqual(liveSend.content, {
      msgtype: "m.text",
      body: "live reply",
    });
    assert.equal(
      liveSend.transactionId,
      computeMatrixTransactionId({
        roomId: ROOM_ONE,
        inboundEventId: "$live:example.org",
        responseKind: "agent",
        oneBasedPartNumber: 1,
      }),
    );
    assert.equal(rig.peer.prompts.some((prompt) => prompt.text === "must be suppressed"), false);
    assert.equal(rig.peer.prompts.some((prompt) => prompt.text.includes("bridge output")), false);

    const initialize = rig.peer.frames.find((frame) => frame.method === "initialize");
    assert.deepEqual(initialize?.params, {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    assert.deepEqual(rig.peer.sessionRequests[0]?.params, {
      cwd: CONFIG.acp.cwd,
      mcpServers: [],
    });
    const livePrompt = rig.peer.frames.find(
      (frame) => frame.method === "session/prompt" &&
        ((frame.params as Record<string, unknown> | undefined)?.prompt as Array<Record<string, unknown>> | undefined)?.[0]?.text === "live text",
    );
    assert.deepEqual(livePrompt?.params, {
      sessionId: rig.peer.prompts[0]?.sessionId,
      prompt: [{ type: "text", text: "live text" }],
    });
  } finally {
    await stopRig(rig, run);
  }
});

void test("integration keeps same-room order, isolates sessions, and permits bounded cross-room concurrency", async () => {
  const rig = createRig();
  const { run } = await startRig(rig);
  try {
    rig.matrixSdk.emitInbound(sdkEvent({ eventId: "$same-one:example.org", body: "room-one-first" }));
    rig.matrixSdk.emitInbound(sdkEvent({ eventId: "$same-two:example.org", body: "room-one-second" }));
    rig.matrixSdk.emit("sync", "SYNCING", "PREPARED", { nextSyncToken: "same-room-cursor" });
    await waitFor(() => rig.peer.prompts.length === 1, "first same-room prompt");
    await flushMany();
    assert.equal(rig.peer.prompts.length, 1);
    assert.ok(rig.bridge.getQueueDepth(ROOM_ONE) <= 1);

    await completePrompt(rig, rig.peer.prompts[0]!, "room-one-first-reply");
    await waitFor(() => rig.peer.prompts.length === 2, "second same-room prompt");
    assert.equal(rig.peer.prompts[0]?.sessionId, rig.peer.prompts[1]?.sessionId);
    assert.deepEqual(
      rig.peer.prompts.slice(0, 2).map((prompt) => prompt.text),
      ["room-one-first", "room-one-second"],
    );
    await completePrompt(rig, rig.peer.prompts[1]!, "room-one-second-reply");

    rig.matrixSdk.emitInbound(sdkEvent({
      eventId: "$cross-one:example.org",
      roomId: ROOM_ONE,
      body: "cross-room-one",
    }));
    rig.matrixSdk.emitInbound(sdkEvent({
      eventId: "$cross-two:example.org",
      roomId: ROOM_TWO,
      body: "cross-room-two",
    }));
    rig.matrixSdk.emit("sync", "SYNCING", "SYNCING", { nextSyncToken: "cross-room-cursor" });
    await waitFor(() => rig.peer.prompts.length === 4, "both cross-room prompts");
    await waitFor(() => rig.bridge.unresolvedPromptCount === 2, "cross-room concurrency");

    const crossRoomCalls = rig.peer.prompts.slice(2);
    assert.equal(crossRoomCalls[0]?.sessionId === crossRoomCalls[1]?.sessionId, false);
    assert.deepEqual(
      crossRoomCalls.map((prompt) => prompt.text),
      ["cross-room-one", "cross-room-two"],
    );
    assert.equal(rig.peer.sessionRequests.length, 2);
    for (const request of rig.peer.sessionRequests) {
      assert.deepEqual(request.params, { cwd: CONFIG.acp.cwd, mcpServers: [] });
    }

    for (const [index, call] of crossRoomCalls.entries()) {
      call.update(`cross reply ${index + 1}`, `cross-message-${index}`);
      await flushMany(2);
      call.respond();
    }
    await waitFor(() => rig.bridge.unresolvedPromptCount === 0, "cross-room ACP responses");
    rig.clock.advanceBy(300);
    await waitFor(
      () => rig.matrixSdk.sent.some((attempt) => attempt.content.body === "cross reply 1") &&
        rig.matrixSdk.sent.some((attempt) => attempt.content.body === "cross reply 2"),
      "cross-room Matrix delivery",
    );
  } finally {
    await stopRig(rig, run);
  }
});

void test("integration treats ACP NDJSON EOF as fatal and shuts down the complete composition", async () => {
  const rig = createRig();
  const { run } = await startRig(rig);
  try {
    rig.peer.closeInput();
    await waitFor(() => rig.lifecycle.fatalError !== undefined, "ACP EOF fatal notification");
    const exitCode = await run;
    assert.equal(exitCode, 1);
    assert.equal(rig.lifecycle.fatalError?.code, "acp_transport");
    assert.equal(rig.matrixSdk.stopCalls, 1);
    assert.equal(rig.matrix.lifecycle, "stopped");
    assert.equal(rig.lock.released, true);
  } finally {
    await stopRig(rig, run);
  }
});

void test("integration reconnects Matrix, retries transient sends with one transaction ID, and abandons permanent sends without ACP retry", async () => {
  const rig = createRig();
  let transientNext = true;
  let permanentNext = false;
  rig.matrixSdk.sendBehavior = async () => {
    if (transientNext) {
      transientNext = false;
      throw { httpStatus: 503, data: { retry_after_ms: 0 } };
    }
    if (permanentNext) {
      permanentNext = false;
      throw { httpStatus: 403, errcode: "M_FORBIDDEN" };
    }
  };

  const { run } = await startRig(rig);
  try {
    rig.matrixSdk.emit("sync", "RECONNECTING", "SYNCING");
    rig.matrixSdk.emitInbound(sdkEvent({ eventId: "$retry:example.org", body: "retry me" }));
    rig.matrixSdk.emit("sync", "CATCHUP", "RECONNECTING", { nextSyncToken: "retry-cursor" });
    await waitFor(() => rig.peer.prompts.length === 1, "reconnected live prompt");

    const retryCall = rig.peer.prompts[0]!;
    retryCall.update("retry reply", "retry-message");
    await flushMany(2);
    retryCall.respond();
    await waitFor(() => rig.bridge.unresolvedPromptCount === 0, "retry ACP response");
    rig.clock.advanceBy(300);
    await waitFor(() => rig.matrixSdk.attempts.length === 1, "first transient Matrix attempt");
    assert.equal(rig.matrixSdk.sent.length, 0);
    const retryTransactionId = rig.matrixSdk.attempts[0]?.transactionId;
    rig.clock.advanceBy(0);
    await waitFor(() => rig.matrixSdk.sent.length === 1, "transient Matrix retry success");
    assert.equal(rig.matrixSdk.attempts[1]?.transactionId, retryTransactionId);
    assert.equal(rig.peer.prompts.length, 1);

    permanentNext = true;
    rig.matrixSdk.emitInbound(sdkEvent({
      eventId: "$permanent:example.org",
      body: "permanent failure",
    }));
    rig.matrixSdk.emit("sync", "SYNCING", "CATCHUP", { nextSyncToken: "permanent-cursor" });
    await waitFor(() => rig.peer.prompts.length === 2, "permanent-failure ACP prompt");
    const permanentCall = rig.peer.prompts[1]!;
    await completeAbandonedPrompt(rig, permanentCall, "abandoned reply", 3);
    const permanentAttempts = rig.matrixSdk.attempts.filter(
      (attempt) => attempt.content.body === "abandoned reply",
    );
    assert.equal(permanentAttempts.length, 1);

    rig.matrixSdk.emitInbound(sdkEvent({
      eventId: "$after-permanent:example.org",
      body: "after permanent failure",
    }));
    rig.matrixSdk.emit("sync", "SYNCING", "SYNCING", { nextSyncToken: "recovery-cursor" });
    await waitFor(() => rig.peer.prompts.length === 3, "room recovery after permanent send failure");
    assert.deepEqual(
      rig.peer.prompts.map((prompt) => prompt.text),
      ["retry me", "permanent failure", "after permanent failure"],
    );
    await completePrompt(rig, rig.peer.prompts[2]!, "recovery reply");
    assert.equal(rig.lifecycle.fatalError, undefined);
    assert.equal(rig.matrixSdk.sent.some((attempt) => attempt.content.body === "recovery reply"), true);
  } finally {
    await stopRig(rig, run);
  }
});

void test("M2 scenario 1: the first run establishes a completed-ID baseline and restarts without replay", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m2-composition-"));
  const config: BridgeConfig = { ...CONFIG, stateDir };
  let first: IntegrationRig | undefined;
  let firstRun: Promise<DaemonExitCode> | undefined;
  let second: IntegrationRig | undefined;
  let secondRun: Promise<DaemonExitCode> | undefined;
  try {
    first = createRig(config, { advertiseLoadSession: true });
    first.matrixSdk.startClientAction = () => {
      first!.matrixSdk.emitInbound(sdkEvent({
        eventId: "$initial-m2:example.org",
        body: "history must stay suppressed",
      }));
      first!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "first-cursor" });
    };
    ({ run: firstRun } = await startRig(first));
    assert.equal(first.peer.prompts.length, 0);
    assert.deepEqual(first.matrixSdk.startupInitialSyncLimits, [100]);

    first.matrixSdk.emitInbound(sdkEvent({
      eventId: "$live-m2:example.org",
      body: "live prompt",
    }));
    first.matrixSdk.emit("sync", "RECONNECTING", "SYNCING");
    first.matrixSdk.emit("sync", "CATCHUP", "RECONNECTING", { nextSyncToken: "live-cursor" });
    await waitFor(() => first!.peer.prompts.length === 1, "M2 live prompt");
    await completePrompt(first, first.peer.prompts[0]!, "live response");
    await flushMany();
    assert.equal(first.batches.length, 2);
    const beforeStop = JSON.parse(await readFile(join(stateDir, "bridge-state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(beforeStop.initialized, true);
    assert.deepEqual(beforeStop.completedEventIds, {
      [ROOM_ONE]: ["$initial-m2:example.org", "$live-m2:example.org"],
    });
    await stopRig(first, firstRun);
    firstRun = undefined;

    const saved = JSON.parse(await readFile(join(stateDir, "bridge-state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(saved.initialized, true);
    assert.deepEqual(saved.completedEventIds, {
      [ROOM_ONE]: ["$initial-m2:example.org", "$live-m2:example.org"],
    });
    assert.equal(Object.hasOwn(saved, "cursor"), false);
    assert.deepEqual(saved.sessions, { [ROOM_ONE]: "session-1" });

    second = createRig(config, { advertiseLoadSession: true });
    second.matrixSdk.startClientAction = () => {
      second!.matrixSdk.emitInbound(sdkEvent({
        eventId: "$offline-m2:example.org",
        body: "offline prompt",
      }));
      second!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "restart-cursor" });
    };
    ({ run: secondRun } = await startRig(second));
    assert.deepEqual(second.matrixSdk.startupInitialSyncLimits, [100]);
    await waitFor(() => second!.peer.loadRequests.length === 1, "saved ACP session load");
    assert.deepEqual(second.peer.loadRequests[0]?.params, {
      sessionId: "session-1",
      cwd: config.acp.cwd,
      mcpServers: [],
    });
    await waitFor(() => second!.peer.prompts.length === 1, "offline ACP prompt");
    assert.equal(second.peer.prompts[0]?.text, "offline prompt");
    assert.equal(second.peer.prompts.some((prompt) => prompt.text === "live prompt"), false);
    await completePrompt(second, second.peer.prompts[0], "offline response");
    assert.equal(second.peer.prompts.some((prompt) => prompt.text.includes("replayed history")), false);
    await stopRig(second, secondRun);
    secondRun = undefined;
  } finally {
    if (firstRun !== undefined && first !== undefined) {
      await stopRig(first, firstRun);
    }
    if (secondRun !== undefined && second !== undefined) {
      await stopRig(second, secondRun);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M2 scenario 2: a short restart submits a bounded offline message through normal initial sync", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m2-short-restart-"));
  const config: BridgeConfig = { ...CONFIG, stateDir };
  let seed: IntegrationRig | undefined;
  let seedRun: Promise<DaemonExitCode> | undefined;
  let restart: IntegrationRig | undefined;
  let restartRun: Promise<DaemonExitCode> | undefined;
  try {
    seed = createRig(config);
    seed.matrixSdk.startClientAction = () => {
      seed!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "before-outage" });
    };
    ({ run: seedRun } = await startRig(seed));
    await stopRig(seed, seedRun);
    seedRun = undefined;

    restart = createRig(config);
    restart.matrixSdk.startClientAction = () => {
      restart!.matrixSdk.emitInbound(sdkEvent({
        eventId: "$short-offline:example.org",
        body: "bounded offline work",
      }));
      restart!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "after-outage" });
    };
    ({ run: restartRun } = await startRig(restart));

    assert.deepEqual(restart.matrixSdk.startupInitialSyncLimits, [100]);
    assert.equal(restart.batches[0]?.phase, "initial");
    assert.equal(restart.batches[0]?.rooms[0]?.timeline[0]?.isCatchUp, false);
    await waitFor(() => restart!.peer.prompts.length === 1, "short restart ACP prompt");
    assert.equal(restart.peer.prompts[0]?.text, "bounded offline work");
    await completePrompt(restart, restart.peer.prompts[0], "offline response");

    const saved = JSON.parse(await readFile(join(stateDir, "bridge-state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(saved.initialized, true);
    assert.deepEqual(saved.completedEventIds, {
      [ROOM_ONE]: ["$short-offline:example.org"],
    });
    assert.equal(Object.hasOwn(saved, "cursor"), false);
    assert.equal(restart.matrixSdk.sent.some((attempt) => attempt.content.body === "The room queue is full. Try again later."), false);
  } finally {
    if (seedRun !== undefined && seed !== undefined) {
      await stopRig(seed, seedRun);
    }
    if (restartRun !== undefined && restart !== undefined) {
      await stopRig(restart, restartRun);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M2 scenario 3: a long or high-volume interruption stays within bounded initial sync recovery", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m2-bounded-"));
  const config: BridgeConfig = { ...CONFIG, stateDir };
  let seed: IntegrationRig | undefined;
  let seedRun: Promise<DaemonExitCode> | undefined;
  let restart: IntegrationRig | undefined;
  let restartRun: Promise<DaemonExitCode> | undefined;
  try {
    seed = createRig(config);
    seed.matrixSdk.startClientAction = () => {
      seed!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "seed-cursor" });
    };
    ({ run: seedRun } = await startRig(seed));
    await stopRig(seed, seedRun);
    seedRun = undefined;

    restart = createRig(config);
    restart.matrixSdk.startClientAction = () => {
      for (let index = 1; index <= 5; index += 1) {
        restart!.matrixSdk.emitInbound(sdkEvent({
          eventId: `$catchup-${index}-m2:example.org`,
          body: `catchup-${index}`,
        }));
      }
      restart!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "bounded-cursor" });
    };
    ({ run: restartRun } = await startRig(restart));
    await waitFor(() => restart!.peer.prompts.length === 1, "first bounded catch-up prompt");
    assert.deepEqual(restart.peer.prompts.map((prompt) => prompt.text), ["catchup-3"]);
    await completePrompt(restart, restart.peer.prompts[0]!, "reply-3");
    await waitFor(() => restart!.peer.prompts.length === 2, "second bounded catch-up prompt");
    await completePrompt(restart, restart.peer.prompts[1]!, "reply-4");
    await waitFor(() => restart!.peer.prompts.length === 3, "third bounded catch-up prompt");
    await completePrompt(restart, restart.peer.prompts[2]!, "reply-5");
    assert.deepEqual(restart.peer.prompts.map((prompt) => prompt.text), ["catchup-3", "catchup-4", "catchup-5"]);
    assert.equal(restart.matrixSdk.sent.some((attempt) => attempt.content.body === "The room queue is full. Try again later."), false);
    await stopRig(restart, restartRun);
    restartRun = undefined;
  } finally {
    if (seedRun !== undefined && seed !== undefined) {
      await stopRig(seed, seedRun);
    }
    if (restartRun !== undefined && restart !== undefined) {
      await stopRig(restart, restartRun);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M2 scenario 4: a successful loaded session preserves room context", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m2-loaded-context-"));
  const config: BridgeConfig = { ...CONFIG, stateDir };
  let seed: IntegrationRig | undefined;
  let seedRun: Promise<DaemonExitCode> | undefined;
  let restart: IntegrationRig | undefined;
  let restartRun: Promise<DaemonExitCode> | undefined;
  try {
    seed = createRig(config, { advertiseLoadSession: true });
    seed.matrixSdk.startClientAction = () => {
      seed!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "context-seed" });
    };
    ({ run: seedRun } = await startRig(seed));
    seed.matrixSdk.emitInbound(sdkEvent({
      roomId: ROOM_ONE,
      eventId: "$context-seed-one:example.org",
      body: "room one context",
    }));
    seed.matrixSdk.emitInbound(sdkEvent({
      roomId: ROOM_TWO,
      eventId: "$context-seed-two:example.org",
      body: "room two context",
    }));
    seed.matrixSdk.emit("sync", "SYNCING", "PREPARED", { nextSyncToken: "context-live" });
    await waitFor(() => seed!.peer.prompts.length === 2, "seed room sessions");
    for (const [index, reply] of ["seed one reply", "seed two reply"].entries()) {
      const call = seed.peer.prompts[index];
      assert.ok(call);
      call.update(reply, `seed-message-${index}`);
      await flushMany(2);
      call.respond();
    }
    await waitFor(() => seed!.bridge.unresolvedPromptCount === 0, "seed room responses");
    seed.clock.advanceBy(300);
    await waitFor(() => seed!.matrixSdk.sent.filter((attempt) => attempt.content.body?.toString().startsWith("seed ")).length === 2, "seed Matrix responses");
    await stopRig(seed, seedRun);
    seedRun = undefined;

    const saved = JSON.parse(await readFile(join(stateDir, "bridge-state.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(saved.sessions, { [ROOM_ONE]: "session-1", [ROOM_TWO]: "session-2" });

    restart = createRig(config, { advertiseLoadSession: true });
    restart.matrixSdk.startClientAction = () => {
      restart!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "context-restart" });
    };
    ({ run: restartRun } = await startRig(restart));
    restart.matrixSdk.emitInbound(sdkEvent({
      roomId: ROOM_ONE,
      eventId: "$context-restart-one:example.org",
      body: "room one after restart",
    }));
    restart.matrixSdk.emitInbound(sdkEvent({
      roomId: ROOM_TWO,
      eventId: "$context-restart-two:example.org",
      body: "room two after restart",
    }));
    restart.matrixSdk.emit("sync", "SYNCING", "PREPARED", { nextSyncToken: "context-restart-live" });
    await waitFor(() => restart!.peer.loadRequests.length === 2, "both saved sessions loaded");
    await waitFor(() => restart!.peer.prompts.length === 2, "both restored room prompts");

    const loadIds = restart.peer.loadRequests.map((frame) => {
      const parameters = frame.params as Record<string, unknown>;
      return parameters.sessionId;
    });
    assert.deepEqual(new Set(loadIds), new Set(["session-1", "session-2"]));
    assert.equal(restart.peer.prompts.some((prompt) => prompt.text.includes("replayed history")), false);
    assert.deepEqual(
      restart.peer.prompts.map((prompt) => [prompt.sessionId, prompt.text]),
      [
        ["session-1", "room one after restart"],
        ["session-2", "room two after restart"],
      ],
    );
    for (const [index, reply] of ["restored one", "restored two"].entries()) {
      restart.peer.prompts[index]!.update(reply, `restored-message-${index}`);
      await flushMany(2);
      restart.peer.prompts[index]!.respond();
    }
    await waitFor(() => restart!.bridge.unresolvedPromptCount === 0, "restored room responses");
    restart.clock.advanceBy(300);
    await waitFor(() => restart!.matrixSdk.sent.filter((attempt) => attempt.content.body === "restored one" || attempt.content.body === "restored two").length === 2, "restored Matrix responses");
  } finally {
    if (seedRun !== undefined && seed !== undefined) {
      await stopRig(seed, seedRun);
    }
    if (restartRun !== undefined && restart !== undefined) {
      await stopRig(restart, restartRun);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M2 scenario 5: a stale mapping and /reset each create a fresh isolated session", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m2-reset-isolation-"));
  const config: BridgeConfig = { ...CONFIG, stateDir };
  let seed: IntegrationRig | undefined;
  let seedRun: Promise<DaemonExitCode> | undefined;
  let restart: IntegrationRig | undefined;
  let restartRun: Promise<DaemonExitCode> | undefined;
  try {
    seed = createRig(config, { advertiseLoadSession: true });
    seed.matrixSdk.startClientAction = () => {
      seed!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "reset-seed" });
    };
    ({ run: seedRun } = await startRig(seed));
    seed.matrixSdk.emitInbound(sdkEvent({ roomId: ROOM_ONE, eventId: "$reset-seed-one:example.org", body: "seed one" }));
    seed.matrixSdk.emitInbound(sdkEvent({ roomId: ROOM_TWO, eventId: "$reset-seed-two:example.org", body: "seed two" }));
    seed.matrixSdk.emit("sync", "SYNCING", "PREPARED", { nextSyncToken: "reset-seed-live" });
    await waitFor(() => seed!.peer.prompts.length === 2, "reset seed sessions");
    for (const [index, call] of seed.peer.prompts.entries()) {
      call.update(`seed reply ${index}`, `reset-seed-message-${index}`);
      await flushMany(2);
      call.respond();
    }
    await waitFor(() => seed!.bridge.unresolvedPromptCount === 0, "reset seed responses");
    seed.clock.advanceBy(300);
    await waitFor(() => seed!.matrixSdk.sent.filter((attempt) => attempt.content.body?.toString().startsWith("seed reply")).length === 2, "reset seed Matrix responses");
    await stopRig(seed, seedRun);
    seedRun = undefined;

    restart = createRig(config, {
      advertiseLoadSession: true,
      staleSessionIds: ["session-1"],
      sessionStartAt: 10,
    });
    restart.matrixSdk.startClientAction = () => {
      restart!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "reset-restart" });
    };
    ({ run: restartRun } = await startRig(restart));
    restart.matrixSdk.emitInbound(sdkEvent({
      roomId: ROOM_ONE,
      eventId: "$stale-room-one:example.org",
      body: "replace stale room one",
    }));
    restart.matrixSdk.emit("sync", "SYNCING", "PREPARED", { nextSyncToken: "stale-room-live" });
    await waitFor(() => restart!.peer.loadRequests.length === 1, "stale room load");
    await waitFor(() => restart!.peer.prompts.length === 1, "replacement room prompt");
    assert.equal(restart.peer.prompts[0]?.sessionId, "session-11");
    await completePrompt(restart, restart.peer.prompts[0], "replacement response");

    restart.matrixSdk.emitInbound(sdkEvent({
      roomId: ROOM_TWO,
      eventId: "$reset-room-two:example.org",
      body: "/reset",
    }));
    restart.matrixSdk.emit("sync", "SYNCING", "PREPARED", { nextSyncToken: "reset-room-live" });
    await waitFor(() => restart!.matrixSdk.sent.some((attempt) => attempt.content.body === "Agent session reset."), "room reset acknowledgement");
    assert.equal(restart.peer.loadRequests.length, 1);
    const afterReset = JSON.parse(await readFile(join(stateDir, "bridge-state.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(afterReset.sessions, { [ROOM_ONE]: "session-11" });

    restart.matrixSdk.emitInbound(sdkEvent({
      roomId: ROOM_TWO,
      eventId: "$after-reset-room-two:example.org",
      body: "fresh room two",
    }));
    restart.matrixSdk.emit("sync", "SYNCING", "PREPARED", { nextSyncToken: "after-reset-live" });
    await waitFor(() => restart!.peer.prompts.length === 2, "fresh room two prompt");
    assert.equal(restart.peer.prompts[1]?.sessionId, "session-12");
    assert.notEqual(restart.peer.prompts[0]?.sessionId, restart.peer.prompts[1]?.sessionId);
    await completePrompt(restart, restart.peer.prompts[1], "fresh room two response");
  } finally {
    if (seedRun !== undefined && seed !== undefined) {
      await stopRig(seed, seedRun);
    }
    if (restartRun !== undefined && restart !== undefined) {
      await stopRig(restart, restartRun);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M2 scenario 6: typing spans only an active ACP turn", async () => {
  const rig = createRig();
  const { run } = await startRig(rig);
  try {
    rig.matrixSdk.emitInbound(sdkEvent({ eventId: "$typing-active-one:example.org", body: "typing one" }));
    rig.matrixSdk.emit("sync", "SYNCING", "PREPARED", { nextSyncToken: "typing-one-cursor" });
    await waitFor(() => rig.peer.prompts.length === 1, "first typing prompt");
    rig.matrixSdk.emitInbound(sdkEvent({ eventId: "$typing-queued-two:example.org", body: "typing two" }));
    rig.matrixSdk.emit("sync", "SYNCING", "SYNCING", { nextSyncToken: "typing-two-cursor" });
    await flushMany();
    assert.equal(rig.matrixSdk.typing.length, 1);
    assert.deepEqual(rig.matrixSdk.typing[0], { roomId: ROOM_ONE, isTyping: true, timeoutMs: 30_000 });

    rig.clock.advanceBy(20_000);
    await flushMany();
    assert.equal(rig.matrixSdk.typing.length, 2);
    assert.equal(rig.matrixSdk.typing[1]?.isTyping, true);
    await completePrompt(rig, rig.peer.prompts[0]!, "typing one response");
    await waitFor(() => rig.peer.prompts.length === 2, "second typing prompt");
    assert.equal(rig.matrixSdk.typing[2]?.isTyping, false);
    assert.equal(rig.matrixSdk.typing[3]?.isTyping, true);
    await completePrompt(rig, rig.peer.prompts[1]!, "typing two response");

    assert.deepEqual(rig.matrixSdk.typing.map(({ isTyping }) => isTyping), [true, true, false, true, false]);
    assert.ok(rig.matrixSdk.operations.indexOf("typing:off") < rig.matrixSdk.operations.indexOf("message:typing one response"));
  } finally {
    await stopRig(rig, run);
  }
});

void test("M2 scenario 7: receipts acknowledge selected dispositions but not omitted initial-sync events", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m2-receipts-"));
  const config: BridgeConfig = { ...CONFIG, stateDir };
  let seed: IntegrationRig | undefined;
  let seedRun: Promise<DaemonExitCode> | undefined;
  let restart: IntegrationRig | undefined;
  let restartRun: Promise<DaemonExitCode> | undefined;
  try {
    seed = createRig(config);
    seed.matrixSdk.startClientAction = () => {
      seed!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "receipt-seed" });
    };
    ({ run: seedRun } = await startRig(seed));
    await stopRig(seed, seedRun);
    seedRun = undefined;

    restart = createRig(config);
    restart.matrixSdk.startClientAction = () => {
      for (let index = 1; index <= 5; index += 1) {
        restart!.matrixSdk.emitInbound(sdkEvent({
          eventId: `$receipt-catchup-${index}:example.org`,
          body: `receipt catchup ${index}`,
        }));
      }
      restart!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "receipt-after" });
    };
    ({ run: restartRun } = await startRig(restart));
    await waitFor(() => restart!.matrixSdk.receipts.length === 3, "selected catch-up receipts");
    assert.deepEqual(
      restart.matrixSdk.receipts.map(({ eventId }) => eventId),
      ["$receipt-catchup-3:example.org", "$receipt-catchup-4:example.org", "$receipt-catchup-5:example.org"],
    );
    assert.equal(restart.matrixSdk.receipts.some(({ eventId }) => eventId.includes("-1:") || eventId.includes("-2:")), false);
    for (let index = 0; index < 3; index += 1) {
      await waitFor(() => restart!.peer.prompts.length === index + 1, `receipt catch-up prompt ${index + 1}`);
      await completePrompt(restart, restart.peer.prompts[index]!, `receipt response ${index + 3}`);
    }
    assert.equal(restart.matrixSdk.sent.some((attempt) => attempt.content.body === "The room queue is full. Try again later."), false);
  } finally {
    if (seedRun !== undefined && seed !== undefined) {
      await stopRig(seed, seedRun);
    }
    if (restartRun !== undefined && restart !== undefined) {
      await stopRig(restart, restartRun);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M2 scenario 8: an interrupted event remains incomplete and is retried after restart", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m2-crash-boundary-"));
  const config: BridgeConfig = { ...CONFIG, stateDir };
  let crashed: IntegrationRig | undefined;
  let crashedRun: Promise<DaemonExitCode> | undefined;
  let restart: IntegrationRig | undefined;
  let restartRun: Promise<DaemonExitCode> | undefined;
  try {
    crashed = createRig(config);
    crashed.matrixSdk.startClientAction = () => {
      crashed!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "crash-start" });
    };
    ({ run: crashedRun } = await startRig(crashed));
    crashed.matrixSdk.emitInbound(sdkEvent({
      eventId: "$lost-in-memory:example.org",
      body: "this prompt is intentionally lost",
    }));
    crashed.matrixSdk.emit("sync", "SYNCING", "PREPARED", { nextSyncToken: "crash-after-admission" });
    await waitFor(() => crashed!.batches.length >= 2, "crash checkpoint");
    await crashed.stateStore?.flush?.();
    await waitFor(() => crashed!.peer.prompts.length === 1, "in-flight prompt before crash");
    crashed.peer.closeInput();
    await flushMany();
    crashed.clock.advanceBy(1000);
    assert.equal(await crashedRun, 1);
    crashedRun = undefined;
    assert.equal(crashed.matrixSdk.sent.length, 0);
    await flushMany(10);
    await crashed.stateStore?.flush?.();

    const saved = JSON.parse(await readFile(join(stateDir, "bridge-state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(saved.initialized, true);
    assert.deepEqual(saved.completedEventIds, {});
    assert.equal(Object.hasOwn(saved, "cursor"), false);
    assert.equal(Object.hasOwn(saved, "pendingBatches"), false);
    assert.deepEqual(saved.sessions, {});

    restart = createRig(config, { clockStartAt: 1000 });
    restart.matrixSdk.startClientAction = () => {
      restart!.matrixSdk.emitInbound(sdkEvent({
        eventId: "$lost-in-memory:example.org",
        body: "this prompt is intentionally lost",
      }));
      restart!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "crash-restart" });
    };
    ({ run: restartRun } = await startRig(restart));
    assert.deepEqual(restart.matrixSdk.startupInitialSyncLimits, [100]);
    await waitFor(() => restart!.peer.prompts.length === 1, "replayed interrupted prompt");
    await completePrompt(restart, restart.peer.prompts[0]!, "replayed response");
  } finally {
    if (crashedRun !== undefined && crashed !== undefined) {
      await stopRig(crashed, crashedRun);
    }
    if (restartRun !== undefined && restart !== undefined) {
      await stopRig(restart, restartRun);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M2 scenario 9: completion precedes a lost Matrix response and ACP is not replayed", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m2-response-loss-"));
  const config: BridgeConfig = { ...CONFIG, stateDir };
  let first: IntegrationRig | undefined;
  let firstRun: Promise<DaemonExitCode> | undefined;
  let restart: IntegrationRig | undefined;
  let restartRun: Promise<DaemonExitCode> | undefined;
  try {
    first = createRig(config);
    first.matrixSdk.startClientAction = () => {
      first!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "response-loss-start" });
    };
    first.matrixSdk.sendBehavior = (attempt) => {
      if (attempt.content.body === "lost response") {
        throw { httpStatus: 403, errcode: "M_FORBIDDEN" };
      }
    };
    ({ run: firstRun } = await startRig(first));
    first.matrixSdk.emitInbound(sdkEvent({
      eventId: "$response-loss:example.org",
      body: "response-loss prompt",
    }));
    first.matrixSdk.emit("sync", "SYNCING", "PREPARED", { nextSyncToken: "response-loss-next" });
    await waitFor(() => first!.peer.prompts.length === 1, "response-loss prompt");
    const call = first.peer.prompts[0]!;
    call.update("lost response", "response-loss-message");
    await flushMany(2);
    call.respond();
    await waitFor(() => first!.bridge.unresolvedPromptCount === 0, "response-loss ACP completion");
    first.clock.advanceBy(300);
    await waitFor(() => !first!.bridge.isRoomActive(ROOM_ONE), "response-loss bridge completion");

    const saved = JSON.parse(await readFile(join(stateDir, "bridge-state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(saved.initialized, true);
    assert.deepEqual(saved.completedEventIds, { [ROOM_ONE]: ["$response-loss:example.org"] });
    assert.equal(Object.hasOwn(saved, "cursor"), false);
    assert.equal(Object.hasOwn(saved, "pendingBatches"), false);
    assert.equal(first.matrixSdk.sent.some((attempt) => attempt.content.body === "lost response"), false);
    await stopRig(first, firstRun);
    firstRun = undefined;

    restart = createRig(config);
    restart.matrixSdk.startClientAction = () => {
      restart!.matrixSdk.emitInbound(sdkEvent({
        eventId: "$response-loss:example.org",
        body: "response-loss prompt",
      }));
      restart!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "response-loss-restart" });
    };
    ({ run: restartRun } = await startRig(restart));
    assert.deepEqual(restart.matrixSdk.startupInitialSyncLimits, [100]);
    assert.equal(restart.peer.prompts.length, 0);
  } finally {
    if (firstRun !== undefined && first !== undefined) {
      await stopRig(first, firstRun);
    }
    if (restartRun !== undefined && restart !== undefined) {
      await stopRig(restart, restartRun);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M2 graceful shutdown flushes accepted completed-ID work before releasing the state lock", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m2-shutdown-"));
  const config: BridgeConfig = { ...CONFIG, stateDir };
  let releaseFlush!: () => void;
  const stateFlushStarted = new Promise<void>((resolve) => {
    releaseFlush = resolve;
  });
  let markFlushStarted!: () => void;
  const flushStarted = new Promise<void>((resolve) => {
    markFlushStarted = resolve;
  });
  let rig: IntegrationRig | undefined;
  let run: Promise<DaemonExitCode> | undefined;
  try {
    rig = createRig(config, {
      gateStateFlush: { started: markFlushStarted, wait: stateFlushStarted },
    });
    rig.matrixSdk.startClientAction = () => {
      rig!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "startup-cursor" });
    };
    ({ run } = await startRig(rig));

    rig.matrixSdk.emitInbound(sdkEvent({
      eventId: "$shutdown-checkpoint-m2:example.org",
      body: "x".repeat(CONFIG.limits.maxInputBytes + 1),
    }));
    rig.matrixSdk.emit("sync", "CATCHUP", "SYNCING", { nextSyncToken: "shutdown-cursor" });
    await waitFor(() => rig!.batches.length === 2, "shutdown checkpoint batch admission");

    rig.lifecycle.receiveSignal("SIGTERM");
    await flushStarted;
    assert.equal(rig.lock.released, false);
    releaseFlush();
    await run;
    run = undefined;
    assert.equal(rig.lock.released, true);
    const saved = JSON.parse(await readFile(join(stateDir, "bridge-state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(saved.initialized, true);
    assert.deepEqual(saved.completedEventIds, {
      [ROOM_ONE]: ["$shutdown-checkpoint-m2:example.org"],
    });
    assert.equal(Object.hasOwn(saved, "cursor"), false);
    assert.equal(Object.hasOwn(saved, "pendingBatches"), false);
  } finally {
    if (run !== undefined && rig !== undefined) {
      releaseFlush();
      await stopRig(rig, run);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M3 scenario 1: bootstrap persists one stable local crypto identity", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m3-bootstrap-"));
  const config = requiredConfig(stateDir);
  try {
    await bootstrapCryptoState(config);
    const first = JSON.parse(
      await readFile(join(stateDir, "crypto-state.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(first.bootstrapCompleted, true);
    assert.equal(first.sasVerified, false);
    assert.equal("privateKey" in first, false);
    assert.equal("accessToken" in first, false);

    await bootstrapCryptoState(config);
    const second = JSON.parse(
      await readFile(join(stateDir, "crypto-state.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(second, first);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M3 scenario 2: SAS verification marks only the bootstrapped identity", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m3-sas-"));
  const config = requiredConfig(stateDir);
  try {
    await bootstrapCryptoState(config);
    const tty = await verifyCryptoState(config);
    assert.match(tty.writes.join(""), /Local device: BRIDGE-DEVICE/u);
    assert.match(tty.writes.join(""), /Target device: TRUSTED-DEVICE/u);
    assert.match(tty.writes.join(""), /SAS emoji: 🐈 \(cat\)/u);
    assert.match(tty.writes.join(""), /SAS decimal: 123 456 789/u);

    const manifest = JSON.parse(
      await readFile(join(stateDir, "crypto-state.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(manifest.sasVerified, true);
    assert.equal(manifest.ed25519Fingerprint, BRIDGE_FINGERPRINTS.ed25519Fingerprint);
    assert.equal(manifest.curve25519Fingerprint, BRIDGE_FINGERPRINTS.curve25519Fingerprint);
    assert.equal("trustedDeviceId" in manifest, false);
    assert.equal("crossSigningPrivateKey" in manifest, false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M3 scenario 3: a live encrypted message reaches ACP once and gets an encrypted response", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m3-live-"));
  const config = requiredConfig(stateDir);
  const crypto = new HermeticCrypto();
  let rig: IntegrationRig | undefined;
  let run: Promise<DaemonExitCode> | undefined;
  try {
    await prepareVerifiedCryptoState(config);
    rig = createRig(config, { cryptoAdapter: crypto });
    rig.matrixSdk.startClientAction = () => {
      rig!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "m3-live-start" });
    };
    ({ run } = await startRig(rig));

    rig.matrixSdk.emitInbound(sdkEvent({
      eventId: "$m3-live-encrypted:example.org",
      encrypted: true,
      clearContent: { msgtype: "m.text", body: "encrypted live prompt" },
    }));
    rig.matrixSdk.emit("sync", "SYNCING", "PREPARED", { nextSyncToken: "m3-live-after" });
    await waitFor(() => rig!.peer.prompts.length === 1, "encrypted live ACP prompt");
    assert.equal(rig.peer.prompts[0]?.text, "encrypted live prompt");
    await completePrompt(rig, rig.peer.prompts[0], "encrypted live response");

    const responses = rig.matrixSdk.sent.filter(
      (attempt) => attempt.content.body === "encrypted live response",
    );
    assert.equal(responses.length, 1);
    assert.equal(responses[0]?.wireEncrypted, true);
  } finally {
    if (run !== undefined && rig !== undefined) {
      await stopRig(rig, run);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M3 scenario 4: a short restart restores the device and catches up one bounded encrypted event", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m3-restart-catchup-"));
  const config = requiredConfig(stateDir);
  const seedCrypto = new HermeticCrypto();
  const restartCrypto = new HermeticCrypto();
  let seed: IntegrationRig | undefined;
  let seedRun: Promise<DaemonExitCode> | undefined;
  let restart: IntegrationRig | undefined;
  let restartRun: Promise<DaemonExitCode> | undefined;
  try {
    await prepareVerifiedCryptoState(config);
    seed = createRig(config, { cryptoAdapter: seedCrypto });
    seed.matrixSdk.startClientAction = () => {
      seed!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "m3-before-outage" });
    };
    ({ run: seedRun } = await startRig(seed));
    await stopRig(seed, seedRun);
    seedRun = undefined;

    restart = createRig(config, { cryptoAdapter: restartCrypto, clockStartAt: 1000 });
    restart.matrixSdk.startClientAction = () => {
      restart!.matrixSdk.emitInbound(sdkEvent({
        eventId: "$m3-offline-encrypted:example.org",
        encrypted: true,
        clearContent: { msgtype: "m.text", body: "bounded encrypted offline work" },
      }));
      restart!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "m3-after-outage" });
    };
    ({ run: restartRun } = await startRig(restart));
    assert.deepEqual(restart.matrixSdk.startupInitialSyncLimits, [100]);
    await waitFor(() => restart!.peer.prompts.length === 1, "encrypted catch-up ACP prompt");
    assert.equal(restart.peer.prompts[0]?.text, "bounded encrypted offline work");
    await completePrompt(restart, restart.peer.prompts[0], "bounded encrypted reply");
    assert.equal(restart.matrixSdk.sent.some((attempt) => attempt.wireEncrypted === true), true);
    assert.deepEqual(seedCrypto.initializationPaths, restartCrypto.initializationPaths);
  } finally {
    if (seedRun !== undefined && seed !== undefined) {
      await stopRig(seed, seedRun);
    }
    if (restartRun !== undefined && restart !== undefined) {
      await stopRig(restart, restartRun);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M3 scenario 5: first-sync encrypted history is suppressed", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m3-first-sync-"));
  const config = requiredConfig(stateDir);
  const crypto = new HermeticCrypto();
  let rig: IntegrationRig | undefined;
  let run: Promise<DaemonExitCode> | undefined;
  try {
    await prepareVerifiedCryptoState(config);
    rig = createRig(config, { cryptoAdapter: crypto });
    const history = sdkEvent({
      eventId: "$m3-encrypted-history:example.org",
      encrypted: true,
      clearContent: { msgtype: "m.text", body: "encrypted history must stay hidden" },
    });
    rig.matrixSdk.startClientAction = () => {
      rig!.matrixSdk.emitInbound(history);
      rig!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "m3-initial-cursor" });
    };
    ({ run } = await startRig(rig));
    await flushMany();
    rig.matrixSdk.emit("Event.decrypted", history);
    assert.equal(rig.peer.prompts.length, 0);
    assert.equal(rig.matrixSdk.sent.length, 0);
  } finally {
    if (run !== undefined && rig !== undefined) {
      await stopRig(rig, run);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M3 scenario 6: plaintext configured rooms fail required-mode startup", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m3-plaintext-room-"));
  const config = requiredConfig(stateDir);
  try {
    await prepareVerifiedCryptoState(config);
    const crypto = new HermeticCrypto();
    const rig = createRig(config, { cryptoAdapter: crypto, encryptedRooms: false });
    rig.matrixSdk.startClientAction = () => {
      rig.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "m3-plaintext-room" });
    };
    const exit = await rig.lifecycle.run();
    assert.equal(exit, 1);
    assert.equal(rig.peer.prompts.length, 0);
    assert.equal(crypto.initializeCalls, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M3 scenario 7: transport-plaintext messages are rejected in required mode", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m3-transport-plaintext-"));
  const config = requiredConfig(stateDir);
  const crypto = new HermeticCrypto();
  let rig: IntegrationRig | undefined;
  let run: Promise<DaemonExitCode> | undefined;
  try {
    await prepareVerifiedCryptoState(config);
    rig = createRig(config, { cryptoAdapter: crypto });
    rig.matrixSdk.startClientAction = () => {
      rig!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "m3-plaintext-start" });
    };
    ({ run } = await startRig(rig));
    rig.matrixSdk.emitInbound(sdkEvent({
      eventId: "$m3-transport-plaintext:example.org",
      body: "must never reach ACP",
    }));
    await flushMany();
    assert.equal(rig.peer.prompts.length, 0);
    assert.equal(rig.matrixSdk.sent.length, 0);
  } finally {
    if (run !== undefined && rig !== undefined) {
      await stopRig(rig, run);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M3 scenario 8: undecryptable ciphertext is suppressed without a plaintext reply", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m3-undecryptable-"));
  const config = requiredConfig(stateDir);
  const crypto = new HermeticCrypto();
  let rig: IntegrationRig | undefined;
  let run: Promise<DaemonExitCode> | undefined;
  try {
    await prepareVerifiedCryptoState(config);
    rig = createRig(config, { cryptoAdapter: crypto });
    rig.matrixSdk.startClientAction = () => {
      rig!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "m3-decrypt-start" });
    };
    ({ run } = await startRig(rig));
    rig.matrixSdk.emitInbound(sdkEvent({
      eventId: "$m3-undecryptable:example.org",
      encrypted: true,
      clearContent: { msgtype: "m.bad.encrypted", body: "secret SDK failure detail" },
      decryptionFailure: true,
    }));
    await flushMany();
    assert.equal(rig.peer.prompts.length, 0);
    assert.equal(rig.matrixSdk.sent.length, 0);
  } finally {
    if (run !== undefined && rig !== undefined) {
      await stopRig(rig, run);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M3 scenario 9: an unverified manifest fails daemon startup", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m3-unverified-"));
  const config = requiredConfig(stateDir);
  try {
    await bootstrapCryptoState(config);
    const crypto = new HermeticCrypto();
    const rig = createRig(config, { cryptoAdapter: crypto });
    rig.matrixSdk.startClientAction = () => {
      rig.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "m3-unverified" });
    };
    const exit = await rig.lifecycle.run();
    assert.equal(exit, 1);
    assert.equal(crypto.initializeCalls, 0);
    assert.equal(rig.peer.frames.length, 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M3 scenario 10: a verified-device restart preserves both public-key fingerprints", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m3-fingerprint-restart-"));
  const config = requiredConfig(stateDir);
  const firstCrypto = new HermeticCrypto();
  const secondCrypto = new HermeticCrypto();
  let first: IntegrationRig | undefined;
  let firstRun: Promise<DaemonExitCode> | undefined;
  let second: IntegrationRig | undefined;
  let secondRun: Promise<DaemonExitCode> | undefined;
  try {
    await prepareVerifiedCryptoState(config);
    first = createRig(config, { cryptoAdapter: firstCrypto });
    first.matrixSdk.startClientAction = () => {
      first!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "m3-fingerprint-one" });
    };
    ({ run: firstRun } = await startRig(first));
    await stopRig(first, firstRun);
    firstRun = undefined;

    second = createRig(config, { cryptoAdapter: secondCrypto, clockStartAt: 1000 });
    second.matrixSdk.startClientAction = () => {
      second!.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "m3-fingerprint-two" });
    };
    ({ run: secondRun } = await startRig(second));
    await stopRig(second, secondRun);
    secondRun = undefined;

    assert.deepEqual(firstCrypto.fingerprints, secondCrypto.fingerprints);
    assert.deepEqual(firstCrypto.initializationPaths, secondCrypto.initializationPaths);
    const manifest = JSON.parse(
      await readFile(join(stateDir, "crypto-state.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(manifest.sasVerified, true);
  } finally {
    if (firstRun !== undefined && first !== undefined) {
      await stopRig(first, firstRun);
    }
    if (secondRun !== undefined && second !== undefined) {
      await stopRig(second, secondRun);
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("M3 scenario 11: missing or replaced crypto state fails closed without generating a new identity", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m3-state-loss-"));
  const config = requiredConfig(stateDir);
  try {
    await prepareVerifiedCryptoState(config);
    const manifestBefore = await readFile(join(stateDir, "crypto-state.json"), "utf8");
    await rm(join(stateDir, "matrix-crypto"), { recursive: true, force: true });

    const missingCrypto = new HermeticCrypto();
    const missingRig = createRig(config, { cryptoAdapter: missingCrypto });
    missingRig.matrixSdk.startClientAction = () => {
      missingRig.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "m3-missing" });
    };
    assert.equal(await missingRig.lifecycle.run(), 1);
    assert.equal(missingCrypto.initializeCalls, 0);
    assert.equal(await readFile(join(stateDir, "crypto-state.json"), "utf8"), manifestBefore);

    await mkdir(join(stateDir, "matrix-crypto"), { mode: 0o700 });
    const replacementFingerprints: CryptoDeviceKeyFingerprints = {
      ed25519Fingerprint: "replacement-ed25519",
      curve25519Fingerprint: "replacement-curve25519",
    };
    const replacedCrypto = new HermeticCrypto(replacementFingerprints);
    const replacedRig = createRig(config, { cryptoAdapter: replacedCrypto });
    replacedRig.matrixSdk.startClientAction = () => {
      replacedRig.matrixSdk.emit("sync", "PREPARED", null, { nextSyncToken: "m3-replaced" });
    };
    assert.equal(await replacedRig.lifecycle.run(), 1);
    assert.equal(replacedCrypto.initializeCalls, 1);
    assert.equal(await readFile(join(stateDir, "crypto-state.json"), "utf8"), manifestBefore);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
