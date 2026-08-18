import assert from "node:assert/strict";
import test from "node:test";

import {
  MatrixAdapterError,
  MatrixClientAdapterImpl,
  assertMatrixIdentity,
  classifyMatrixError,
  createMatrixClientAdapter,
  createMatrixCryptoAdapter,
  type MatrixClientCreateOptions,
  type MatrixSdkClientLike,
  type MatrixSdkEventLike,
  type MatrixSdkRoomLike,
} from "./matrix-client.js";
import type { MatrixConfig } from "./config.js";
import type { DiagnosticFields, DiagnosticSink } from "./diagnostics.js";
import type { CryptoStatePaths } from "./crypto-contracts.js";
import type {
  InboundMatrixEvent,
  MatrixSyncBatch,
} from "./matrix-client.js";
import type { RenderedMatrixPart } from "./response-rendering.js";

const ROOM_ID = "!room:example.org";
const OTHER_ROOM_ID = "!other:example.org";
const BRIDGE_USER_ID = "@bridge:example.org";
const ALICE = "@alice:example.org";

const SDK_EVENT = "event";
const SDK_TIMELINE = "Room.timeline";
const SDK_SYNC = "sync";
const SDK_MY_MEMBERSHIP = "Room.myMembership";
const SDK_ROOM_STATE = "RoomState.events";
const SDK_MEMBER_MEMBERSHIP = "RoomMember.membership";

const CONFIG: MatrixConfig = {
  homeserver: "https://matrix.example.org",
  userId: BRIDGE_USER_ID,
  deviceId: "BRIDGE-DEVICE",
  accessTokenFile: "/private/matrix-token",
  allowedRooms: [ROOM_ID],
  allowedSenders: [ALICE],
  encryption: "disabled",
};

const REQUIRED_CONFIG: MatrixConfig = {
  ...CONFIG,
  encryption: "required",
};

type Listener = (...args: unknown[]) => void;

class FakeSdkClient implements MatrixSdkClientLike {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly rooms = new Map<string, MatrixSdkRoomLike>();
  readonly sent: Array<{
    readonly roomId: string;
    readonly content: Readonly<Record<string, unknown>>;
    readonly transactionId: string | undefined;
  }> = [];
  readonly typing: Array<{ readonly roomId: string; readonly isTyping: boolean; readonly timeoutMs: number }> = [];
  readonly receipts: Array<{
    readonly event: unknown;
    readonly receiptType: string | undefined;
    readonly unthreaded: boolean | undefined;
  }> = [];
  whoamiResponse: unknown = {
    user_id: BRIDGE_USER_ID,
    device_id: "BRIDGE-DEVICE",
  };
  whoamiError: unknown;
  startError: unknown;
  sendError: unknown;
  startClientAction: (() => void | Promise<void>) | undefined;
  startOptions: { readonly since?: string } | undefined;
  syncToken: string | undefined;
  readonly store = {
    setSyncToken: (token: string): void => {
      this.syncToken = token;
    },
  };
  startCalls = 0;
  stopCalls = 0;
  joinedRoomsOverride: readonly string[] | undefined;
  roomStateOverride: readonly { readonly type?: string }[] | undefined;
  cryptoInitOptions: {
    readonly useIndexedDB?: boolean;
    readonly cryptoDatabasePrefix?: string;
  } | undefined = undefined;
  cryptoInitialized = false;
  ownDeviceKeys: unknown = {
    ed25519: "ed25519-public",
    curve25519: "curve25519-public",
  };
  encryptionEnabledInRoom = true;
  verificationRequest: unknown;
  verificationRequests: readonly unknown[] = [];

  on(event: string, listener: Listener): void {
    let listeners = this.listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  off(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of (this.listeners.get(event) ?? [])) {
      listener(...args);
    }
  }

  async whoami(): Promise<unknown> {
    if (this.whoamiError !== undefined) {
      throw this.whoamiError;
    }
    return this.whoamiResponse;
  }

  async startClient(options?: { readonly since?: string }): Promise<void> {
    this.startCalls += 1;
    this.startOptions = options;
    if (this.startError !== undefined) {
      throw this.startError;
    }
    await this.startClientAction?.();
  }

  stopClient(): void {
    this.stopCalls += 1;
  }

  async initRustCrypto(options?: {
    readonly useIndexedDB?: boolean;
    readonly cryptoDatabasePrefix?: string;
  }): Promise<void> {
    this.cryptoInitOptions = options;
    this.cryptoInitialized = true;
  }

  getCrypto(): {
    getOwnDeviceKeys(): Promise<unknown>;
    isEncryptionEnabledInRoom(roomId: string): Promise<boolean>;
    requestDeviceVerification?(userId: string, deviceId: string): Promise<unknown>;
    getVerificationRequestsToDeviceInProgress?(userId: string): readonly unknown[];
  } | undefined {
    if (!this.cryptoInitialized) {
      return undefined;
    }
    return {
      getOwnDeviceKeys: async () => this.ownDeviceKeys,
      isEncryptionEnabledInRoom: async (_roomId: string) => this.encryptionEnabledInRoom,
      requestDeviceVerification: async (_userId: string, _deviceId: string) => this.verificationRequest,
      getVerificationRequestsToDeviceInProgress: (_userId: string) => this.verificationRequests,
    };
  }

  getRoom(roomId: string): MatrixSdkRoomLike | null {
    return this.rooms.get(roomId) ?? null;
  }

  async getJoinedRooms(): Promise<{ readonly joined_rooms: readonly string[] }> {
    return { joined_rooms: this.joinedRoomsOverride ?? [...this.rooms.keys()] };
  }

  async roomState(_roomId: string): Promise<readonly { readonly type?: string }[]> {
    return this.roomStateOverride ?? [];
  }

  async sendMessage(
    roomId: string,
    content: Readonly<Record<string, unknown>>,
    transactionId?: string,
  ): Promise<void> {
    this.sent.push({ roomId, content, transactionId });
    if (this.sendError !== undefined) {
      throw this.sendError;
    }
  }

  async sendTyping(roomId: string, isTyping: boolean, timeoutMs: number): Promise<void> {
    this.typing.push({ roomId, isTyping, timeoutMs });
  }

  async sendReadReceipt(event: unknown, receiptType?: string, unthreaded?: boolean): Promise<void> {
    this.receipts.push({ event, receiptType, unthreaded });
  }
}

function room(
  roomId = ROOM_ID,
  membership = "join",
  encrypted = false,
): MatrixSdkRoomLike {
  return {
    roomId,
    getMyMembership: () => membership,
    hasEncryptionStateEvent: () => encrypted,
  };
}

class RustVerificationRequestDouble {
  readonly otherUserId = "@trusted:example.org";
  readonly otherDeviceId = "TRUSTED01";
  readonly initiatedByMe = true;
  phase = 2;
  readonly listeners = new Map<string, Set<() => void>>();
  methodsRead = false;
  acceptCalls = 0;

  get methods(): never {
    this.methodsRead = true;
    throw new Error("not implemented");
  }

  otherPartySupportsMethod(method: string): boolean {
    return this.phase >= 3 && method === "m.sas.v1";
  }

  async accept(): Promise<void> {
    this.acceptCalls += 1;
    this.phase = 3;
    this.emit("change");
  }

  on(event: string, listener: () => void): void {
    let listeners = this.listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  off(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string): void {
    for (const listener of (this.listeners.get(event) ?? [])) {
      listener();
    }
  }
}

interface EventOptions {
  readonly roomId?: string;
  readonly eventId?: string;
  readonly sender?: string;
  readonly type?: string;
  readonly content?: Readonly<Record<string, unknown>>;
  readonly encrypted?: boolean;
  readonly redacted?: boolean;
  readonly clearContent?: unknown;
  readonly stateKey?: string;
}

function event(options: EventOptions = {}): MatrixSdkEventLike {
  const values = {
    roomId: ROOM_ID,
    eventId: "$event:example.org",
    sender: ALICE,
    type: "m.room.message",
    content: { msgtype: "m.text", body: "hello" },
    encrypted: false,
    redacted: false,
    clearContent: null,
    ...options,
  };
  return {
    getRoomId: () => values.roomId,
    getId: () => values.eventId,
    getSender: () => values.sender,
    getType: () => values.type,
    getContent: () => values.content,
    isEncrypted: () => values.encrypted,
    isRedacted: () => values.redacted,
    getClearContent: () => values.clearContent,
    getStateKey: () => values.stateKey,
  };
}

function readyClient(): FakeSdkClient {
  const client = new FakeSdkClient();
  client.rooms.set(ROOM_ID, room());
  client.startClientAction = () => {
    client.emit(SDK_SYNC, "PREPARED", null, { nextSyncToken: "initial-cursor" });
  };
  return client;
}

function adapterFor(client: FakeSdkClient): MatrixClientAdapterImpl {
  return createMatrixClientAdapter(CONFIG, "access-token", { client });
}

function requiredAdapterFor(client: FakeSdkClient): MatrixClientAdapterImpl {
  return createMatrixClientAdapter(REQUIRED_CONFIG, "access-token", { client });
}

const CRYPTO_STATE: CryptoStatePaths = {
  databasePath: "/private/state/matrix-crypto",
  manifestPath: "/private/state/crypto-state.json",
};

function captureDiagnostics(
  records: Array<{ readonly event: string; readonly fields: DiagnosticFields }>,
): DiagnosticSink {
  return {
    emit(_level, eventName, fields = {}) {
      records.push({ event: eventName, fields });
    },
    debug() { /* no-op */ },
    info() { /* no-op */ },
    warn() { /* no-op */ },
    error() { /* no-op */ },
  };
}

void test("constructs a token-authenticated client with the configured device", () => {
  let received: MatrixClientCreateOptions | undefined;
  const fake = readyClient();
  createMatrixClientAdapter(CONFIG, "secret-token", {
    clientFactory: (options) => {
      received = options;
      return fake;
    },
  });

  assert.deepEqual(received, {
    baseUrl: CONFIG.homeserver,
    accessToken: "secret-token",
    userId: CONFIG.userId,
    deviceId: CONFIG.deviceId,
  });
  assert.equal(fake.startCalls, 0);
});

void test("loads the pinned Matrix SDK through the default factory under strict ESM", async () => {
  const previousFetch = globalThis.fetch;
  let requestCount = 0;
  let sdkLogCalls = 0;
  const consoleMethods = ["debug", "error", "info", "log", "trace", "warn"] as const;
  const previousConsoleMethods = new Map<
    (typeof consoleMethods)[number],
    Console[(typeof consoleMethods)[number]]
  >();
  for (const method of consoleMethods) {
    previousConsoleMethods.set(method, console[method].bind(console));
    console[method] = (() => {
      sdkLogCalls += 1;
    }) as Console[(typeof consoleMethods)[number]];
  }
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(
      JSON.stringify({ user_id: BRIDGE_USER_ID, device_id: "BRIDGE-DEVICE" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const adapter = createMatrixClientAdapter(CONFIG, "runtime-test-token");
    assert.deepEqual(await adapter.whoAmI(), {
      userId: BRIDGE_USER_ID,
      deviceId: "BRIDGE-DEVICE",
    });
    const { logger: matrixSdkRootLogger } = await import("matrix-js-sdk/lib/logger.js");
    matrixSdkRootLogger.debug("root logger must not enter ACP stdout");
    matrixSdkRootLogger
      .getChild("[MatrixRTCSession !room:example.org m.call#ROOM]")
      .debug("No membership changes detected for room !room:example.org");
    await adapter.stop();
  } finally {
    globalThis.fetch = previousFetch;
    for (const method of consoleMethods) {
      const previous = previousConsoleMethods.get(method);
      if (previous !== undefined) {
        console[method] = previous;
      }
    }
  }

  assert.equal(requestCount, 1);
  assert.equal(sdkLogCalls, 0);
});

void test("returns strict whoami identity data and validates configured IDs", async () => {
  const fake = readyClient();
  const adapter = adapterFor(fake);
  const identity = await adapter.whoAmI();
  assert.deepEqual(identity, {
    userId: BRIDGE_USER_ID,
    deviceId: "BRIDGE-DEVICE",
  });
  assert.deepEqual(await adapter.validateIdentity(), identity);
  assert.deepEqual(await adapter.validateConfiguredRooms(), {
    rooms: [{ roomId: ROOM_ID, membership: "join", encrypted: false }],
  });

  fake.whoamiResponse = { user_id: BRIDGE_USER_ID };
  await assert.rejects(
    () => adapter.whoAmI(),
    (error: unknown) =>
      error instanceof MatrixAdapterError && /missing a user or device/u.test(error.message),
  );

  assert.throws(
    () => assertMatrixIdentity({ userId: "@wrong:example.org", deviceId: "BRIDGE-DEVICE" }, CONFIG),
    /does not match the configured user ID/u,
  );
  assert.throws(
    () => assertMatrixIdentity({ userId: BRIDGE_USER_ID, deviceId: "WRONG" }, CONFIG),
    /does not match the configured device ID/u,
  );
});

void test("required mode initializes Rust crypto before sync, validates encrypted rooms, and exposes normalized public keys", async () => {
  const fake = readyClient();
  fake.rooms.set(ROOM_ID, room(ROOM_ID, "join", true));
  fake.startClientAction = () => {
    assert.equal(fake.cryptoInitialized, true);
    fake.emit(SDK_SYNC, "PREPARED", null, { nextSyncToken: "initial-cursor" });
  };
  fake.ownDeviceKeys = {
    ed25519: "  ed25519-public  ",
    curve25519: "curve25519-public",
  };
  const adapter = requiredAdapterFor(fake);
  await adapter.initializeCrypto(CRYPTO_STATE);
  assert.deepEqual(fake.cryptoInitOptions, {
    useIndexedDB: true,
    cryptoDatabasePrefix: CRYPTO_STATE.databasePath,
  });
  assert.deepEqual(await adapter.getDeviceKeyFingerprints(), {
    ed25519Fingerprint: "ed25519-public",
    curve25519Fingerprint: "curve25519-public",
  });
  await adapter.start();
  await adapter.stop();
  assert.equal(fake.stopCalls, 1);
});

void test("Rust verification adapter uses phase/capability events without reading the unsupported methods getter", async () => {
  const fake = readyClient();
  const raw = new RustVerificationRequestDouble();
  fake.cryptoInitialized = true;
  fake.verificationRequest = raw;
  const adapter = createMatrixCryptoAdapter(fake);
  const request = await adapter.requestDeviceVerification("@trusted:example.org", "TRUSTED01");

  assert.equal(request.phase, "requested");
  assert.equal(request.supportsMethod("m.sas.v1"), false);
  assert.equal(raw.methodsRead, false);

  await request.accept();
  assert.equal(raw.acceptCalls, 1);
  assert.equal(request.phase, "ready");

  let changes = 0;
  const unsubscribe = request.onChange(() => {
    changes += 1;
  });
  raw.phase = 3;
  raw.emit("change");
  unsubscribe();
  assert.equal(request.phase, "ready");
  assert.equal(request.supportsMethod("m.sas.v1"), true);
  assert.equal(changes, 1);
  assert.equal(raw.methodsRead, false);
});

void test("required mode rejects a configured plaintext room at startup", async () => {
  const fake = readyClient();
  fake.encryptionEnabledInRoom = false;
  const adapter = requiredAdapterFor(fake);
  await adapter.initializeCrypto(CRYPTO_STATE);

  await assert.rejects(() => adapter.start(), /is not encrypted/u);
  assert.equal(fake.stopCalls, 1);
});

void test("required mode admits late decryption once and rejects plaintext", async () => {
  const fake = readyClient();
  fake.rooms.set(ROOM_ID, room(ROOM_ID, "join", true));
  const adapter = requiredAdapterFor(fake);
  await adapter.initializeCrypto(CRYPTO_STATE);
  const received: InboundMatrixEvent[] = [];
  adapter.onSyncBatch((batch) => {
    for (const room of batch.rooms) {
      received.push(...room.timeline);
    }
  });
  await adapter.start();

  let clearContent: unknown = null;
  const encrypted = {
    ...event({
      eventId: "$late-decryption:example.org",
      encrypted: true,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "never-exposed" },
    }),
    getClearContent: () => clearContent,
    getClearType: () => "m.room.message",
  } satisfies MatrixSdkEventLike;
  fake.emit(SDK_EVENT, encrypted);
  assert.equal(received.length, 0);
  clearContent = { msgtype: "m.text", body: "decrypted" };
  fake.emit(SDK_EVENT, encrypted);
  fake.emit(SDK_EVENT, encrypted);
  fake.emit(SDK_SYNC, "SYNCING", "PREPARED", { nextSyncToken: "late-decryption-cursor" });
  assert.equal(received.length, 1);
  const delivered = received.at(0);
  assert.ok(delivered);
  assert.deepEqual(delivered.content, { msgtype: "m.text", body: "decrypted" });
  assert.equal(delivered.isEncrypted, true);
  assert.equal(delivered.isDecrypted, true);

  fake.emit(SDK_EVENT, event({
    eventId: "$plaintext-in-required:example.org",
    content: { msgtype: "m.text", body: "must-reject" },
  }));
  assert.equal(received.length, 1);
  await adapter.stop();
});

void test("closes global-only encrypted catch-up at the batch cutoff", async () => {
  const fake = readyClient();
  fake.rooms.set(ROOM_ID, room(ROOM_ID, "join", true));
  let clearContent: unknown = null;
  const encrypted = {
    ...event({
      eventId: "$global-only-catch-up:example.org",
      encrypted: true,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "not-forwarded" },
    }),
    getClearContent: () => clearContent,
    getClearType: () => "m.room.message",
  } satisfies MatrixSdkEventLike;
  fake.startClientAction = () => {
    // Deliberately omit Room.timeline: some SDK versions surface the first
    // ciphertext only through the global event callback.
    fake.emit(SDK_EVENT, encrypted);
    fake.emit(SDK_SYNC, "PREPARED", null, { nextSyncToken: "catch-up-cursor" });
  };
  const records: Array<{ readonly event: string; readonly fields: DiagnosticFields }> = [];
  const batches: MatrixSyncBatch[] = [];
  const adapter = createMatrixClientAdapter(REQUIRED_CONFIG, "access-token", {
    client: fake,
    diagnostics: captureDiagnostics(records),
  });
  await adapter.initializeCrypto(CRYPTO_STATE);
  adapter.onSyncBatch((batch) => { batches.push(batch); });
  await adapter.start({ since: "saved-cursor" });

  assert.deepEqual(batches[0]?.rooms, []);
  assert.equal(records.some((record) => record.event === "matrix-encrypted-catch-up-omitted"), true);

  clearContent = { msgtype: "m.text", body: "late catch-up" };
  fake.emit("Event.decrypted", encrypted);
  assert.doesNotMatch(JSON.stringify(records), /not-forwarded|late catch-up/u);
  await adapter.stop();
});

void test("keeps catch-up decrypted events in Matrix timeline order after out-of-order completion", async () => {
  const fake = readyClient();
  fake.rooms.set(ROOM_ID, room(ROOM_ID, "join", true));
  let firstClear: unknown = null;
  let secondClear: unknown = null;
  const first = {
    ...event({
      eventId: "$ordered-first:example.org",
      encrypted: true,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "first" },
    }),
    getClearContent: () => firstClear,
    getClearType: () => "m.room.message",
  } satisfies MatrixSdkEventLike;
  const second = {
    ...event({
      eventId: "$ordered-second:example.org",
      encrypted: true,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "second" },
    }),
    getClearContent: () => secondClear,
    getClearType: () => "m.room.message",
  } satisfies MatrixSdkEventLike;
  fake.startClientAction = () => {
    fake.emit(SDK_TIMELINE, first, undefined, false, false, { liveEvent: true });
    fake.emit(SDK_TIMELINE, second, undefined, false, false, { liveEvent: true });
    fake.emit(SDK_EVENT, first);
    fake.emit(SDK_EVENT, second);
    secondClear = { msgtype: "m.text", body: "second" };
    fake.emit("Event.decrypted", second);
    firstClear = { msgtype: "m.text", body: "first" };
    fake.emit("Event.decrypted", first);
    fake.emit(SDK_SYNC, "PREPARED", null, { nextSyncToken: "ordered-cursor" });
  };
  const batches: MatrixSyncBatch[] = [];
  const adapter = requiredAdapterFor(fake);
  await adapter.initializeCrypto(CRYPTO_STATE);
  adapter.onSyncBatch((batch) => { batches.push(batch); });
  await adapter.start({ since: "saved-cursor" });

  assert.deepEqual(
    batches[0]?.rooms[0]?.timeline.map((inbound) => inbound.eventId),
    ["$ordered-first:example.org", "$ordered-second:example.org"],
  );
  await adapter.stop();
});

void test("suppresses already-decrypted first-sync encrypted history after PREPARED", async () => {
  const fake = readyClient();
  fake.rooms.set(ROOM_ID, room(ROOM_ID, "join", true));
  const encrypted = {
    ...event({
      eventId: "$initial-clear:example.org",
      encrypted: true,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "history" },
      clearContent: { msgtype: "m.text", body: "history must stay hidden" },
    }),
    getClearType: () => "m.room.message",
  } satisfies MatrixSdkEventLike;
  fake.startClientAction = () => {
    fake.emit(SDK_EVENT, encrypted);
    fake.emit(SDK_SYNC, "PREPARED", null, { nextSyncToken: "initial-cursor" });
  };
  const batches: MatrixSyncBatch[] = [];
  const adapter = requiredAdapterFor(fake);
  await adapter.initializeCrypto(CRYPTO_STATE);
  adapter.onSyncBatch((batch) => { batches.push(batch); });
  await adapter.start();
  fake.emit("Event.decrypted", encrypted);

  assert.equal(batches[0]?.phase, "initial");
  assert.deepEqual(batches[0]?.rooms, []);
  await adapter.stop();
});

void test("suppresses unresolved first-sync ciphertext after the initial cutoff", async () => {
  const fake = readyClient();
  fake.rooms.set(ROOM_ID, room(ROOM_ID, "join", true));
  let clearContent: unknown = null;
  const encrypted = {
    ...event({
      eventId: "$initial-ciphertext:example.org",
      encrypted: true,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "history" },
    }),
    getClearContent: () => clearContent,
    getClearType: () => "m.room.message",
  } satisfies MatrixSdkEventLike;
  fake.startClientAction = () => {
    fake.emit(SDK_EVENT, encrypted);
    fake.emit(SDK_SYNC, "PREPARED", null, { nextSyncToken: "initial-cursor" });
  };
  const adapter = requiredAdapterFor(fake);
  await adapter.initializeCrypto(CRYPTO_STATE);
  const batches: MatrixSyncBatch[] = [];
  adapter.onSyncBatch((batch) => { batches.push(batch); });
  await adapter.start();

  clearContent = { msgtype: "m.text", body: "history must stay hidden" };
  fake.emit("Event.decrypted", encrypted);
  assert.deepEqual(batches[0]?.rooms, []);
  await adapter.stop();
});

void test("bounds encrypted pending state and removes SDK retry listeners on stop", async () => {
  const fake = readyClient();
  fake.rooms.set(ROOM_ID, room(ROOM_ID, "join", true));
  let oldestClear: unknown = null;
  const oldest = {
    ...event({
      eventId: "$pending-0:example.org",
      encrypted: true,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "oldest" },
    }),
    getClearContent: () => oldestClear,
    getClearType: () => "m.room.message",
  } satisfies MatrixSdkEventLike;
  const adapter = requiredAdapterFor(fake);
  const received: InboundMatrixEvent[] = [];
  adapter.onSyncBatch((batch) => {
    for (const room of batch.rooms) {
      received.push(...room.timeline);
    }
  });
  await adapter.initializeCrypto(CRYPTO_STATE);
  await adapter.start();
  fake.emit(SDK_EVENT, oldest);
  for (let index = 1; index <= 10_000; index += 1) {
    fake.emit(SDK_EVENT, event({
      eventId: `$pending-${index}:example.org`,
      encrypted: true,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: `ciphertext-${index}` },
    }));
  }
  oldestClear = { msgtype: "m.text", body: "oldest retried after bounded eviction" };
  fake.emit("Event.decrypted", oldest);
  fake.emit(SDK_SYNC, "SYNCING", "PREPARED", { nextSyncToken: "pending-cursor" });
  assert.deepEqual(received.map((inbound) => inbound.content.body), ["oldest retried after bounded eviction"]);

  await adapter.stop();
  fake.emit("Event.decrypted", oldest);
  assert.deepEqual(received.map((inbound) => inbound.content.body), ["oldest retried after bounded eviction"]);
  assert.equal([...fake.listeners.values()].reduce((count, listeners) => count + listeners.size, 0), 0);
});

void test("suppresses SDK decryption-failure clear content and reports metadata only", async () => {
  const fake = readyClient();
  fake.rooms.set(ROOM_ID, room(ROOM_ID, "join", true));
  const adapter = requiredAdapterFor(fake);
  await adapter.initializeCrypto(CRYPTO_STATE);
  const received: InboundMatrixEvent[] = [];
  const failures: Array<{ readonly eventId: string; readonly reason: string }> = [];
  adapter.onSyncBatch((batch) => {
    for (const room of batch.rooms) {
      received.push(...room.timeline);
    }
  });
  adapter.onDecryptionFailure((failure, metadata) => {
    failures.push({ eventId: metadata.eventId, reason: failure.reason });
  });
  await adapter.start();

  const failed = {
    ...event({
      eventId: "$undecryptable:example.org",
      encrypted: true,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "secret-ciphertext" },
      clearContent: { msgtype: "m.bad.encrypted", body: "sdk error details" },
    }),
    isDecryptionFailure: () => true,
  } satisfies MatrixSdkEventLike;
  fake.emit(SDK_EVENT, failed);

  assert.deepEqual(received, []);
  assert.deepEqual(failures, [{ eventId: "$undecryptable:example.org", reason: "decryption_failed" }]);
  await adapter.stop();
});

void test("does not admit asynchronous first-sync history or post-selection catch-up decryption", async () => {
  const fake = readyClient();
  fake.rooms.set(ROOM_ID, room(ROOM_ID, "join", true));
  let clearContent: unknown = null;
  const encrypted = {
    ...event({
      eventId: "$catch-up-late:example.org",
      encrypted: true,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "ciphertext" },
    }),
    getClearContent: () => clearContent,
    getClearType: () => "m.room.message",
  } satisfies MatrixSdkEventLike;
  fake.startClientAction = () => {
    fake.emit(SDK_TIMELINE, encrypted, undefined, false, false, { liveEvent: true });
    fake.emit(SDK_EVENT, encrypted);
    fake.emit(SDK_SYNC, "PREPARED", null, { nextSyncToken: "catch-up-cursor" });
  };
  const batches: MatrixSyncBatch[] = [];
  const adapter = requiredAdapterFor(fake);
  await adapter.initializeCrypto(CRYPTO_STATE);
  adapter.onSyncBatch((batch) => { batches.push(batch); });
  await adapter.start({ since: "saved-cursor" });

  assert.deepEqual(batches, [{ nextBatch: "catch-up-cursor", phase: "incremental", rooms: [] }]);
  clearContent = { msgtype: "m.text", body: "too late" };
  fake.emit(SDK_EVENT, encrypted);
  assert.deepEqual(batches, [{ nextBatch: "catch-up-cursor", phase: "incremental", rooms: [] }]);
  await adapter.stop();
});

void test("suppresses initial sync events, buffers post-ready events, and preserves order", async () => {
  const fake = readyClient();
  const initial = event({ eventId: "$initial:example.org" });
  const firstLive = event({ eventId: "$first:example.org", content: { msgtype: "m.text", body: "first" } });
  const secondLive = event({ eventId: "$second:example.org", content: { msgtype: "m.text", body: "second" } });
  const history = event({ eventId: "$history:example.org" });
  fake.startClientAction = () => {
    fake.emit(SDK_EVENT, initial);
    fake.emit(SDK_TIMELINE, initial, undefined, false, false, { liveEvent: false });
    fake.emit(SDK_SYNC, "PREPARED", null, { nextSyncToken: "initial-cursor" });
  };

  const received: InboundMatrixEvent[] = [];
  const adapter = adapterFor(fake);
  adapter.onSyncBatch((batch) => {
    for (const room of batch.rooms) {
      received.push(...room.timeline);
    }
  });
  await adapter.start();

  fake.emit(SDK_EVENT, firstLive);
  fake.emit(SDK_TIMELINE, firstLive, undefined, false, false, { liveEvent: true });
  fake.emit(SDK_TIMELINE, secondLive, undefined, false, false, { liveEvent: true });
  fake.emit(SDK_TIMELINE, history, undefined, false, false, { liveEvent: false });
  fake.emit(SDK_SYNC, "SYNCING", "PREPARED", { nextSyncToken: "live-cursor" });

  assert.deepEqual(received.map((inbound) => inbound.eventId), [
    "$first:example.org",
    "$second:example.org",
  ]);
  assert.equal(received[0]?.isLive, true);
  assert.equal(received[0]?.isPlaintext, true);
  assert.deepEqual(received[0]?.content, { msgtype: "m.text", body: "first" });

  const outsideAllowlist = event({
    eventId: "$outside:example.org",
    roomId: OTHER_ROOM_ID,
    sender: "@untrusted:example.org",
  });
  fake.emit(SDK_EVENT, outsideAllowlist);
  fake.emit(SDK_SYNC, "SYNCING", "SYNCING", { nextSyncToken: "outside-cursor" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(received.at(-1)?.roomId, OTHER_ROOM_ID);
});

void test("starts from an opaque cursor and emits the first incremental batch after room validation", async () => {
  const fake = readyClient();
  fake.startClientAction = () => {
    fake.emit(SDK_EVENT, event({ eventId: "$catch-up:example.org" }));
    fake.emit(
      SDK_SYNC,
      "PREPARED",
      null,
      {
        nextSyncToken: "next-opaque-cursor",
        rooms: { join: { [ROOM_ID]: { timeline: { limited: true } } } },
      },
    );
  };
  const batches: unknown[] = [];
  const adapter = adapterFor(fake);
  adapter.onSyncBatch((batch) => {
    batches.push(batch);
  });
  await adapter.start({ since: "saved-opaque-cursor" });

  assert.equal(fake.startOptions?.since, "saved-opaque-cursor");
  assert.equal(fake.syncToken, "saved-opaque-cursor");
  assert.deepEqual(batches, [{
    nextBatch: "next-opaque-cursor",
    phase: "incremental",
    rooms: [{
      roomId: ROOM_ID,
      timeline: [{
        roomId: ROOM_ID,
        eventId: "$catch-up:example.org",
        sender: ALICE,
        type: "m.room.message",
        content: { msgtype: "m.text", body: "hello" },
        isLive: true,
        isCatchUp: true,
        timeline: { phase: "incremental", isCatchUp: true, limited: true },
        isRedacted: false,
        isPlaintext: true,
        isEncrypted: false,
        isDecrypted: true,
      }],
      limited: true,
    }],
  }]);
});

void test("does not fall back to an initial sync when a saved cursor is rejected", async () => {
  const fake = readyClient();
  fake.startClientAction = () => {
    throw { httpStatus: 400, errcode: "M_UNKNOWN_POS" };
  };
  const adapter = adapterFor(fake);
  await assert.rejects(
    () => adapter.start({ since: "expired-opaque-cursor" }),
    /reset private bridge state before retrying/u,
  );
  assert.equal(fake.startOptions?.since, "expired-opaque-cursor");
});

void test("requires every configured room to be joined and unencrypted", async () => {
  for (const [configuredRoom, expected] of [
    [null, /is not joined/u],
    [room(ROOM_ID, "leave"), /is not joined/u],
    [room(ROOM_ID, "join", true), /is encrypted/u],
  ] as const) {
    const fake = readyClient();
    fake.rooms.clear();
    if (configuredRoom !== null) {
      fake.rooms.set(ROOM_ID, configuredRoom);
    }
    const fatal: FatalErrorRecord[] = [];
    const adapter = adapterFor(fake);
    adapter.onFatalError((error) => fatal.push(error));
    await assert.rejects(() => adapter.start(), expected);
    assert.equal(fatal.length, 1);
    assert.equal(fatal[0]?.code, "matrix_invariant");
    assert.equal(fake.stopCalls, 1);
  }
});

void test("validates current joined rooms and room state independently of local room flags", async () => {
  const missing = readyClient();
  missing.joinedRoomsOverride = [];
  await assert.rejects(() => adapterFor(missing).start(), /is not joined/u);

  const encrypted = readyClient();
  encrypted.roomStateOverride = [{ type: "m.room.encryption" }];
  await assert.rejects(() => adapterFor(encrypted).start(), /is encrypted/u);
});

interface FatalErrorRecord {
  readonly code: string;
  readonly message: string;
}

void test("signals runtime room invariants but ignores other users' membership", async () => {
  const otherUserClient = readyClient();
  const otherFatal: FatalErrorRecord[] = [];
  const otherAdapter = adapterFor(otherUserClient);
  otherAdapter.onFatalError((error) => otherFatal.push(error));
  await otherAdapter.start();
  otherUserClient.emit(
    SDK_MEMBER_MEMBERSHIP,
    event({ type: "m.room.member" }),
    { roomId: ROOM_ID, userId: ALICE, membership: "leave" },
  );
  assert.deepEqual(otherFatal, []);

  const encryptedClient = readyClient();
  const encryptedFatal: FatalErrorRecord[] = [];
  const encryptedAdapter = adapterFor(encryptedClient);
  encryptedAdapter.onFatalError((error) => encryptedFatal.push(error));
  await encryptedAdapter.start();
  encryptedClient.emit(
    SDK_ROOM_STATE,
    event({ type: "m.room.encryption", eventId: "$encryption:example.org" }),
    {},
    null,
  );
  assert.equal(encryptedFatal[0]?.code, "matrix_invariant");
  assert.match(encryptedFatal[0]?.message ?? "", /became encrypted/u);

  const leftClient = readyClient();
  const leftFatal: FatalErrorRecord[] = [];
  const leftAdapter = adapterFor(leftClient);
  leftAdapter.onFatalError((error) => leftFatal.push(error));
  await leftAdapter.start();
  leftClient.emit(SDK_MY_MEMBERSHIP, leftClient.rooms.get(ROOM_ID), "leave", "join");
  leftClient.emit(
    SDK_MEMBER_MEMBERSHIP,
    event({
      type: "m.room.member",
      stateKey: BRIDGE_USER_ID,
      content: { membership: "leave" },
    }),
    { roomId: ROOM_ID, userId: BRIDGE_USER_ID, membership: "leave" },
  );
  assert.equal(leftFatal.length, 1);
  assert.match(leftFatal[0]?.message ?? "", /left configured Matrix room/u);
});

void test("required mode treats a runtime crypto room-state mismatch as fatal", async () => {
  const fake = readyClient();
  fake.rooms.set(ROOM_ID, room(ROOM_ID, "join", true));
  const fatal: FatalErrorRecord[] = [];
  const adapter = requiredAdapterFor(fake);
  adapter.onFatalError((error) => fatal.push(error));
  await adapter.initializeCrypto(CRYPTO_STATE);
  await adapter.start();

  fake.encryptionEnabledInRoom = false;
  fake.emit(
    SDK_ROOM_STATE,
    event({ type: "m.room.encryption", eventId: "$runtime-encryption:example.org" }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(fatal, [{
    code: "matrix_invariant",
    message: `Configured Matrix room ${ROOM_ID} is no longer encrypted`,
  }]);
  await adapter.stop();
});

void test("sends only one ordinary top-level text event with the supplied transaction ID", async () => {
  const fake = readyClient();
  const adapter = adapterFor(fake);
  const part = {
    roomId: ROOM_ID,
    inboundEventId: "$inbound:example.org",
    responseKind: "agent",
    partNumber: 1,
    partCount: 1,
    transactionId: "mab1_transaction",
    content: {
      msgtype: "m.text",
      body: "reply",
      "m.relates_to": { "m.in_reply_to": { event_id: "$old:example.org" } },
    },
  } as unknown as RenderedMatrixPart;

  await adapter.sendMessage(part);
  assert.deepEqual(fake.sent, [{
    roomId: ROOM_ID,
    content: { msgtype: "m.text", body: "reply" },
    transactionId: "mab1_transaction",
  }]);
});

void test("required outbound responses use the validated SDK encryption path and never fall back", async () => {
  const fake = readyClient();
  fake.rooms.set(ROOM_ID, room(ROOM_ID, "join", true));
  const adapter = requiredAdapterFor(fake);
  await adapter.initializeCrypto(CRYPTO_STATE);
  await adapter.start();

  const part = {
    roomId: ROOM_ID,
    inboundEventId: "$inbound-encrypted:example.org",
    responseKind: "agent",
    partNumber: 1,
    partCount: 1,
    transactionId: "mab1_encrypted_transaction",
    content: { msgtype: "m.text", body: "encrypted reply" },
  } as unknown as RenderedMatrixPart;
  await adapter.sendMessage(part);
  assert.equal(fake.sent.length, 1);

  const fatal: FatalErrorRecord[] = [];
  adapter.onFatalError((error) => fatal.push(error));
  fake.sendError = { name: "RustCryptoError", message: "private encryption failure" };
  await assert.rejects(() => adapter.sendMessage({ ...part, transactionId: "mab1_no_plaintext_fallback" }), /encrypted message delivery failed/u);
  assert.equal(fake.sent.length, 2);
  assert.deepEqual(fatal, [{ code: "matrix_invariant", message: "Matrix encrypted message delivery failed" }]);
  await adapter.stop();
});

void test("sends 30-second typing updates and an unthreaded m.read receipt", async () => {
  const fake = readyClient();
  const eventObject = { id: "$read:example.org" };
  fake.rooms.set(ROOM_ID, {
    ...room(),
    findEventById: (eventId: string) => eventId === "$read:example.org" ? eventObject : undefined,
  });
  const adapter = adapterFor(fake);

  await adapter.sendTyping(ROOM_ID, true, 30_000);
  await adapter.sendTyping(ROOM_ID, false, 30_000);
  await adapter.sendReadReceipt(ROOM_ID, "$read:example.org");

  assert.deepEqual(fake.typing, [
    { roomId: ROOM_ID, isTyping: true, timeoutMs: 30_000 },
    { roomId: ROOM_ID, isTyping: false, timeoutMs: 30_000 },
  ]);
  assert.deepEqual(fake.receipts, [{
    event: eventObject,
    receiptType: "m.read",
    unthreaded: true,
  }]);
});

void test("normalizes retryability and server retry-delay metadata without retrying", async () => {
  const rateLimited = classifyMatrixError({
    httpStatus: 429,
    errcode: "M_LIMIT_EXCEEDED",
    data: { retry_after_ms: 1500 },
  });
  assert.equal(rateLimited.kind, "transient");
  assert.equal(rateLimited.retryable, true);
  assert.equal(rateLimited.retryAfterMs, 1500);

  const serverFailure = classifyMatrixError({
    httpStatus: 503,
    httpHeaders: new Headers({ "Retry-After": "3" }),
  });
  assert.equal(serverFailure.kind, "transient");
  assert.equal(serverFailure.retryAfterMs, 3000);
  assert.equal(serverFailure.sdkRetryable, true);

  const timeout = classifyMatrixError({ httpStatus: 408 });
  assert.equal(timeout.kind, "transient");
  assert.equal(timeout.retryable, true);

  const forbidden = classifyMatrixError({ httpStatus: 403, errcode: "M_FORBIDDEN" });
  assert.equal(forbidden.kind, "permanent");
  assert.equal(forbidden.retryable, false);

  const fake = readyClient();
  fake.sendError = { httpStatus: 503 };
  const adapter = adapterFor(fake);
  await assert.rejects(
    () => adapter.sendMessage({
      roomId: ROOM_ID,
      inboundEventId: "$inbound:example.org",
      responseKind: "error",
      partNumber: 1,
      partCount: 1,
      transactionId: "mab1_retry-once",
      content: { msgtype: "m.text", body: "reply" },
    }),
    (error: unknown) =>
      error instanceof MatrixAdapterError &&
      error.failure.kind === "transient" &&
      error.failure.retryable,
  );
  assert.equal(fake.sent.length, 1);
});

void test("exposes reconnect state without taking over SDK backoff and shuts down cleanly", async () => {
  const fake = readyClient();
  const adapter = adapterFor(fake);
  const states: string[] = [];
  const reconnects: string[] = [];
  const fatal: FatalErrorRecord[] = [];
  adapter.onSyncState((change) => states.push(change.state));
  adapter.onReconnect((change) => reconnects.push(change.state));
  adapter.onFatalError((error) => fatal.push(error));
  await adapter.start();

  fake.emit(SDK_SYNC, "RECONNECTING", "SYNCING");
  fake.emit(SDK_SYNC, "CATCHUP", "RECONNECTING");
  assert.deepEqual(states, ["PREPARED", "RECONNECTING", "CATCHUP"]);
  assert.deepEqual(reconnects, ["RECONNECTING"]);
  assert.deepEqual(fatal, []);

  adapter.stopIntake();
  fake.emit(SDK_EVENT, event({ eventId: "$after-stop:example.org" }));

  await adapter.stop();
  await adapter.stop();
  assert.equal(fake.stopCalls, 1);
  assert.equal(adapter.lifecycle, "stopped");
  assert.equal([...fake.listeners.values()].reduce((count, set) => count + set.size, 0), 0);
});

void test("initial sync transport errors reject startup and are not retried", async () => {
  const fake = readyClient();
  fake.startClientAction = () => {
    fake.emit(SDK_SYNC, "ERROR", null, { error: { httpStatus: 503 } });
  };
  const fatal: FatalErrorRecord[] = [];
  const adapter = adapterFor(fake);
  adapter.onFatalError((error) => fatal.push(error));
  await assert.rejects(
    () => adapter.start(),
    (error: unknown) =>
      error instanceof MatrixAdapterError && error.failure.kind === "transient",
  );
  assert.equal(fake.startCalls, 1);
  assert.equal(fake.stopCalls, 1);
  assert.equal(fatal.length, 1);
});
