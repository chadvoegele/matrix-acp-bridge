import {
  calculateRetryBackoff,
  createClient,
  MemoryStore,
} from "matrix-js-sdk";
import { logger as matrixSdkRootLogger } from "matrix-js-sdk/lib/logger.js";
import {
  classifyCryptoFailure,
  SAS_VERIFICATION_METHOD,
} from "./crypto-runtime.js";
import { RateLimitedDiagnosticSink } from "./diagnostics.js";
import { isValidMatrixEventId } from "./matrix-validation.js";
import { configureNodeIndexedDb as configureNodeIndexedDatabase, flushNodeIndexedDb as flushNodeIndexedDatabase } from "./node-indexeddb.js";
import { isRecord, numberProperty, stringProperty } from "./object-validation.js";
import type { BridgeConfig, MatrixConfig } from "./config.js";
import type { DiagnosticSink, FatalError, FatalErrorListener } from "./diagnostics.js";
import type { Unsubscribe } from "./cancellation.js";

import type {
  CryptoDeviceKeyFingerprints,
  CryptoFailureClassification,
  CryptoInitializationOptions,
  CryptoStatePaths,
} from "./crypto-contracts.js";
import type { RenderedMatrixPart } from "./response-rendering.js";
import type { MatrixCryptoAdapter } from "./crypto-contracts.js";

export type { BridgeConfig, MatrixConfig } from "./config.js";
export type { FatalError, FatalErrorListener } from "./diagnostics.js";
export type { Unsubscribe } from "./cancellation.js";

export type MatrixRoomId = string;
export type MatrixUserId = string;
export type MatrixEventId = string;
export type MatrixDeviceId = string;

/**
 * A sync cursor is issued by Matrix and must be treated as an opaque value.
 * It is intentionally not parsed, compared, or assembled by bridge code.
 */
export type MatrixSyncCursor = string;

export interface MatrixIdentity {
  readonly userId: MatrixUserId;
  readonly deviceId: MatrixDeviceId;
}

/** Normalized lifecycle phases exposed by the Matrix verification adapter. */
export type CryptoVerificationRequestPhase =
  | "unsent"
  | "requested"
  | "ready"
  | "started"
  | "cancelled"
  | "done";

/** SDK-independent handle for one to-device verification request. */
export interface CryptoVerificationRequestHandle {
  readonly userId: MatrixUserId;
  readonly deviceId: MatrixDeviceId;
  /** True when the SDK says the local client initiated this request. */
  readonly initiatedByMe: boolean;
  readonly phase: CryptoVerificationRequestPhase;
  readonly chosenMethod: string | undefined;
  readonly verifier: CryptoSasVerifier | undefined;
  /** Accept an incoming request and advertise the supported SAS method. */
  accept(): Promise<void>;
  /** Whether the other party advertises support for a method. */
  supportsMethod(method: string): boolean;
  /** Fires when the request phase, capabilities, or verifier changes. */
  onChange(listener: () => void): Unsubscribe;
  startVerification(method: typeof SAS_VERIFICATION_METHOD): Promise<CryptoSasVerifier>;
  cancel(): Promise<void>;
}

/** Narrow SAS verifier boundary; QR and trust-management APIs are absent. */
export interface CryptoSasVerifier {
  onShowSas(listener: (sas: CryptoSasCallbacks) => void): Unsubscribe;
  onCancel(listener: () => void): Unsubscribe;
  verify(): Promise<void>;
  cancel?(): void;
}

export interface CryptoSasCallbacks {
  readonly emoji?: readonly (readonly [string, string])[];
  readonly decimal?: readonly [number, number, number];
  confirm(): Promise<void>;
  mismatch(): void;
  cancel(): void;
}

export interface MatrixEventCryptoMetadata {
  readonly wireEncrypted: boolean;
  readonly decrypted: boolean;
}

export interface MatrixDecryptedEvent {
  readonly event: InboundMatrixEvent;
  readonly crypto: MatrixEventCryptoMetadata;
}

export type MatrixDecryptionListener = (event: MatrixDecryptedEvent) => void;
export type MatrixDecryptionFailureListener = (
  failure: CryptoFailureClassification,
  metadata: Readonly<{
    readonly roomId: MatrixRoomId;
    readonly eventId: MatrixEventId;
    readonly sender: MatrixUserId;
    readonly isCatchUp: boolean;
  }>,
) => void;

export interface MatrixDecryptionLifecycle {
  onDecrypted(listener: MatrixDecryptionListener): Unsubscribe;
  onFailure(listener: MatrixDecryptionFailureListener): Unsubscribe;
  close(): void;
}

export type MatrixSyncPhase = "initial" | "incremental";

export interface MatrixTimelineMetadata {
  readonly phase: MatrixSyncPhase;
  readonly isCatchUp: boolean;
  readonly limited: boolean;
}

export interface MatrixSyncRoomBatch {
  readonly roomId: MatrixRoomId;
  readonly timeline: readonly InboundMatrixEvent[];
  readonly limited: boolean;
}

export interface MatrixSyncBatch {
  readonly nextBatch: MatrixSyncCursor;
  readonly phase: MatrixSyncPhase;
  readonly rooms: readonly MatrixSyncRoomBatch[];
}

export type MatrixSyncBatchListener = (batch: MatrixSyncBatch) => void | Promise<void>;

export interface MatrixSyncStartOptions {
  /** The opaque cursor supplied as `since`; omitted for the first run. */
  readonly since?: MatrixSyncCursor;
  /** Keep Matrix event intake closed for one-shot crypto readiness operations. */
  readonly intakeEnabled?: boolean;
}

export interface MatrixConfiguredRoomState {
  readonly roomId: MatrixRoomId;
  readonly membership: string;
  readonly encrypted: boolean;
}

export interface MatrixConfiguredRoomValidation {
  readonly rooms: readonly MatrixConfiguredRoomState[];
}

/** The SDK-independent event shape supplied to inbound policy code. */
export interface InboundMatrixEvent {
  readonly roomId: MatrixRoomId;
  readonly eventId?: MatrixEventId;
  readonly sender: MatrixUserId;
  readonly type: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly isLive: boolean;
  /** True when the event came from the bounded restart catch-up response. */
  readonly isCatchUp?: boolean;
  readonly timeline?: MatrixTimelineMetadata;
  readonly isRedacted: boolean;
  /** Optional adapter metadata used to fail closed for undecrypted events. */
  readonly isPlaintext?: boolean;
  readonly isEncrypted?: boolean;
  readonly isDecrypted?: boolean;
  /** Present on state events; timeline message events omit this field. */
  readonly stateKey?: string;
}

export interface MatrixReadReceipt {
  readonly roomId: MatrixRoomId;
  readonly eventId: MatrixEventId;
  readonly receiptType: "m.read";
  /** Deliberately absent: this contract is always unthreaded. */
  readonly threadId?: never;
}

export interface MatrixTypingAdapter {
  sendTyping(roomId: MatrixRoomId, isTyping: boolean, timeoutMs: number): Promise<void>;
}

export interface MatrixReceiptAdapter {
  sendReadReceipt(roomId: MatrixRoomId, eventId: MatrixEventId): Promise<void>;
}

/** Required ephemeral-operation contract for the Matrix adapter. */
export interface MatrixEphemeralAdapter extends MatrixTypingAdapter, MatrixReceiptAdapter {}

/** Matrix surface used by BridgeCoordinator after sync composition is set up. */
export interface MatrixBridgeAdapter {
  onFatalError(listener: FatalErrorListener): Unsubscribe;
  stopIntake(): void;
  sendMessage(part: RenderedMatrixPart): Promise<void>;
  /** Send typing state for an active ACP turn. */
  sendTyping?(roomId: MatrixRoomId, isTyping: boolean, timeoutMs: number): Promise<void>;
  /** Sends the unthreaded `m.read` receipt for the supplied event. */
  sendReadReceipt?(roomId: MatrixRoomId, eventId: MatrixEventId): Promise<void>;
  stop(): Promise<void>;
}

export interface MatrixClientAdapter extends MatrixBridgeAdapter {
  whoAmI(): Promise<MatrixIdentity>;
  /** Initialize the pinned Rust crypto backend before the first sync. */
  initializeCrypto?(state: CryptoStatePaths): Promise<void>;
  /** Return normalized public keys from the initialized crypto backend. */
  getDeviceKeyFingerprints?(): Promise<CryptoDeviceKeyFingerprints>;
  /** Narrow manual-SAS surface; absent in disabled mode. */
  getCryptoVerificationAdapter?(): MatrixCryptoVerificationAdapter;
  /** Close the crypto backend before releasing the process state lock. */
  closeCrypto?(): Promise<void>;
  /** Observe only authenticated clear events produced from encrypted wire events. */
  onDecrypted?(listener: MatrixDecryptionListener): Unsubscribe;
  /** Observe metadata-only SDK decryption failures. */
  onDecryptionFailure?(listener: MatrixDecryptionFailureListener): Unsubscribe;
  /** Observe SDK sync/reconnect state without taking ownership of backoff. */
  onSyncState(listener: MatrixSyncStateListener): Unsubscribe;
  onSyncBatch(listener: MatrixSyncBatchListener): Unsubscribe;
  start(options?: MatrixSyncStartOptions): Promise<void>;
  /** Validate every configured room's membership and encryption state. */
  validateConfiguredRooms?(): Promise<MatrixConfiguredRoomValidation>;
}

/** Rust-crypto to-device verification surface used by the manual command. */
export interface MatrixCryptoVerificationAdapter extends MatrixCryptoAdapter {
  /**
   * Refresh and validate one exact remote device in the Rust crypto store.
   * A false result means the homeserver did not provide that exact device.
   */
  refreshDeviceKeys(userId: MatrixUserId, deviceId: MatrixDeviceId): Promise<boolean>;
  requestDeviceVerification(
    userId: MatrixUserId,
    deviceId: MatrixDeviceId,
  ): Promise<CryptoVerificationRequestHandle>;
  onVerificationRequest(listener: (request: CryptoVerificationRequestHandle) => void): Unsubscribe;
}

export type MatrixSyncState =
  | "ERROR"
  | "PREPARED"
  | "STOPPED"
  | "SYNCING"
  | "CATCHUP"
  | "RECONNECTING";

export interface MatrixSyncStateChange {
  readonly state: MatrixSyncState;
  readonly previousState: MatrixSyncState | null;
  readonly failure?: MatrixFailureClassification;
}

export type MatrixSyncStateListener = (change: MatrixSyncStateChange) => void;

export type MatrixFailureKind = "transient" | "permanent";

/** Safe, SDK-independent metadata for a failed Matrix operation. */
export interface MatrixFailureClassification {
  readonly kind: MatrixFailureKind;
  readonly retryable: boolean;
  /** The server-supplied or SDK-recommended delay, when one is available. */
  readonly retryAfterMs?: number;
  /** Whether the SDK's own retry policy accepted this failure. */
  readonly sdkRetryable: boolean;
  readonly httpStatus?: number;
  readonly errcode?: string;
}

/**
 * The deliberately small part of MatrixClient used by the adapter.  Keeping
 * this boundary injectable makes lifecycle tests independent of a homeserver
 * while the real factory below still uses the pinned SDK.
 */
export interface MatrixSdkEventLike {
  getRoomId(): string | undefined;
  getId(): string | undefined;
  getSender(): string | undefined;
  getType(): string;
  getContent(): unknown;
  isEncrypted(): boolean;
  isRedacted(): boolean;
  getClearContent?(): unknown;
  getClearType?(): string | undefined;
  isDecryptionFailure?(): boolean;
  readonly decryptionFailureReason?: unknown;
  getStateKey?(): string | undefined;
}

export interface MatrixSdkRoomLike {
  readonly roomId?: string;
  getMyMembership(): string | undefined;
  hasEncryptionStateEvent(): boolean;
  findEventById?(eventId: string): unknown;
}

export interface MatrixSdkStoreLike {
  getSyncToken?(): string | null;
  setSyncToken?(token: string): void;
  getSavedSync?(): Promise<unknown>;
  getSavedSyncToken?(): Promise<string | null>;
  resetStartupObservation?(): void;
  getStartupTokenObservation?(): MatrixSyncTokenObservation;
}

export interface MatrixSyncTokenObservation {
  readonly consulted: boolean;
  readonly value: string | null | undefined;
}

/**
 * Process-local SDK state with the bridge checkpoint exposed through the
 * public saved-token startup hook. The bridge recovery state remains the only
 * durable cursor ledger; this store never saves sync responses or event data.
 */
export class CursorAwareMatrixStore extends MemoryStore implements MatrixSdkStoreLike {
  #savedSyncTokenConsulted = false;
  #savedSyncToken: string | null | undefined;

  override getSavedSyncToken(): Promise<string | null> {
    const token = this.getSyncToken();
    this.#savedSyncTokenConsulted = true;
    this.#savedSyncToken = token;
    return Promise.resolve(token);
  }

  resetStartupObservation(): void {
    this.#savedSyncTokenConsulted = false;
    this.#savedSyncToken = undefined;
  }

  getStartupTokenObservation(): MatrixSyncTokenObservation {
    return {
      consulted: this.#savedSyncTokenConsulted,
      value: this.#savedSyncToken,
    };
  }
}

type SdkListener = (...args: unknown[]) => void;

export interface MatrixSdkClientLike {
  on(event: string, listener: SdkListener): unknown;
  off?(event: string, listener: SdkListener): unknown;
  removeListener?(event: string, listener: SdkListener): unknown;
  whoami(): Promise<unknown>;
  startClient(): Promise<void>;
  stopClient(): void;
  initRustCrypto?(options?: {
    readonly useIndexedDB?: boolean;
    readonly cryptoDatabasePrefix?: string;
  }): Promise<void>;
  getCrypto?(): {
    getOwnDeviceKeys(): Promise<unknown>;
    isEncryptionEnabledInRoom?(roomId: string): Promise<boolean>;
    getUserDeviceInfo?(
      userIds: string[],
      downloadUncached?: boolean,
    ): Promise<unknown>;
    processDeviceLists?(deviceLists: {
      readonly changed?: readonly string[];
      readonly left?: readonly string[];
    }): Promise<void>;
    onSyncCompleted?(
      syncState: { readonly nextSyncToken?: string; readonly catchingUp?: boolean },
    ): void | Promise<void>;
    requestDeviceVerification?(userId: string, deviceId: string): Promise<unknown>;
    getVerificationRequestsToDeviceInProgress?(userId: string): readonly unknown[];
  } | undefined;
  getRoom(roomId: string): MatrixSdkRoomLike | null | undefined;
  readonly store?: MatrixSdkStoreLike;
  getJoinedRooms?(): Promise<{ readonly joined_rooms: readonly string[] }>;
  roomState?(roomId: string): Promise<readonly {
    readonly type?: string;
    readonly content?: unknown;
    readonly state_key?: string;
  }[]>;
  sendTyping?(roomId: string, isTyping: boolean, timeoutMs: number): Promise<unknown>;
  sendReadReceipt?(event: unknown, receiptType?: string, unthreaded?: boolean): Promise<unknown>;
  sendReadReceiptById?(roomId: string, eventId: string): Promise<unknown>;
  sendMessage(
    roomId: string,
    content: Readonly<Record<string, unknown>>,
    transactionId?: string,
  ): Promise<unknown>;
}

export interface MatrixClientCreateOptions {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly verificationMethods?: readonly string[];
}

export type MatrixClientFactory = (
  options: MatrixClientCreateOptions,
) => MatrixSdkClientLike;

const SDK_EVENTS = {
  event: "event",
  decrypted: "Event.decrypted",
  timeline: "Room.timeline",
  timelineReset: "Room.timelineReset",
  sync: "sync",
  syncUnexpectedError: "sync.unexpectedError",
  myMembership: "Room.myMembership",
  roomState: "RoomState.events",
  memberMembership: "RoomMember.membership",
} as const;

const SDK_SYNC_STATES = {
  error: "ERROR",
  prepared: "PREPARED",
  stopped: "STOPPED",
  syncing: "SYNCING",
  catchup: "CATCHUP",
  reconnecting: "RECONNECTING",
} as const;

const SDK_EVENT_TYPES = {
  roomEncryption: "m.room.encryption",
  roomMember: "m.room.member",
} as const;

export interface MatrixClientAdapterOptions {
  /** Replace the SDK factory with a hermetic fake in tests. */
  readonly clientFactory?: MatrixClientFactory;
  /** Supply an already-created SDK boundary, primarily for tests. */
  readonly client?: MatrixSdkClientLike;
  /** Replace the SDK crypto boundary with a hermetic fake in tests. */
  readonly cryptoAdapter?: MatrixCryptoAdapter;
  /** Metadata-only sink for SDK decryption failures. */
  readonly diagnostics?: DiagnosticSink;
}

export type MatrixOperation = "whoami" | "start" | "send_message";

/**
 * The SDK's public own-device-key shape is intentionally not part of the
 * bridge contract. It is converted to CryptoDeviceKeyFingerprints at this
 * boundary and never escapes as an SDK object.
 */
interface MatrixSdkOwnDeviceKeysLike {
  readonly ed25519?: unknown;
  readonly curve25519?: unknown;
}

function normalizedPublicFingerprint(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  // eslint-disable-next-line no-control-regex -- fingerprints reject Unicode controls
  if (normalized.length === 0 || /[\u0000-\u001F\u007F\u0080-\u009F\u2028\u2029]/u.test(normalized)) {
    return undefined;
  }
  return normalized;
}

/**
 * Adapter around matrix-js-sdk's Node Rust crypto entry points. The SDK
 * accepts a database prefix rather than exposing its WASM store type; the
 * prefix is the stable, already-validated path beneath state_dir.
 */
export interface MatrixSdkCryptoAdapterOptions {
  /** Enable the Node-only persistent IndexedDB adapter. */
  readonly useNodeIndexedDb?: boolean;
}

export class MatrixSdkCryptoAdapter implements MatrixCryptoVerificationAdapter {
  readonly #client: MatrixSdkClientLike;
  readonly #useNodeIndexedDb: boolean;
  #closed = false;
  #userId: string | undefined;
  #usesNodeIndexedDb = false;

  constructor(client: MatrixSdkClientLike, options: MatrixSdkCryptoAdapterOptions = {}) {
    this.#client = client;
    this.#useNodeIndexedDb = options.useNodeIndexedDb === true;
  }

  async initialize(options: CryptoInitializationOptions): Promise<void> {
    if (this.#closed) {
      throw new Error("crypto adapter is closed");
    }
    if (this.#client.initRustCrypto === undefined) {
      throw new Error("Rust crypto is unavailable in the Matrix SDK client");
    }
    if (this.#useNodeIndexedDb) {
      await configureNodeIndexedDatabase(options.state.databasePath);
      this.#usesNodeIndexedDb = (globalThis as unknown as Record<string, unknown>).indexedDB !== undefined;
    }
    await this.#client.initRustCrypto({
      useIndexedDB: true,
      cryptoDatabasePrefix: options.state.databasePath,
    });
    this.#userId = options.userId;
  }

  async getDeviceKeyFingerprints(): Promise<CryptoDeviceKeyFingerprints> {
    if (this.#closed) {
      throw new Error("crypto adapter is closed");
    }
    const crypto = this.#client.getCrypto?.();
    if (crypto === undefined) {
      throw new Error("Rust crypto is not initialized");
    }
    const keys = await crypto.getOwnDeviceKeys() as MatrixSdkOwnDeviceKeysLike;
    const ed25519Fingerprint = normalizedPublicFingerprint(keys?.ed25519);
    const curve25519Fingerprint = normalizedPublicFingerprint(keys?.curve25519);
    if (ed25519Fingerprint === undefined || curve25519Fingerprint === undefined) {
      throw new Error("Rust crypto returned invalid public device keys");
    }
    return { ed25519Fingerprint, curve25519Fingerprint };
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    // matrix-js-sdk owns the RustCrypto instance and closes it from
    // stopClient(). The containing Matrix adapter calls closeCrypto after
    // stopClient; flush the Node IndexedDB snapshot after the SDK has finished
    // its final transactions.
    if (this.#usesNodeIndexedDb) {
      await flushNodeIndexedDatabase();
    }
  }

  async refreshDeviceKeys(userId: string, deviceId: string): Promise<boolean> {
    if (this.#closed) {
      throw new Error("crypto adapter is closed");
    }
    const crypto = this.#client.getCrypto?.();
    if (
      crypto?.getUserDeviceInfo === undefined ||
      crypto.processDeviceLists === undefined ||
      crypto.onSyncCompleted === undefined
    ) {
      throw new Error("Matrix device-key refresh is unavailable");
    }

    try {
      // These are the same public Rust-crypto callbacks used by /sync. Marking
      // the exact user changed causes the SDK to queue a validated /keys/query
      // for the Olm machine; onSyncCompleted runs that queued request and
      // imports its response before getUserDeviceInfo reads the store.
      await crypto.processDeviceLists({ changed: [userId] });
      await crypto.onSyncCompleted({});
      const deviceMap = await crypto.getUserDeviceInfo([userId]);
      return hasExactDevice(deviceMap, userId, deviceId);
    } catch {
      // Never let SDK transport/protocol text cross the Matrix adapter.
      throw new Error("Matrix device keys could not be refreshed");
    }
  }

  async requestDeviceVerification(
    userId: string,
    deviceId: string,
  ): Promise<CryptoVerificationRequestHandle> {
    if (this.#closed) {
      throw new Error("crypto adapter is closed");
    }
    const crypto = this.#client.getCrypto?.();
    if (crypto?.requestDeviceVerification === undefined) {
      throw new Error("Matrix verification is unavailable");
    }
    let request: unknown;
    try {
      request = await crypto.requestDeviceVerification(userId, deviceId);
    } catch {
      // Keep SDK errors, including Rust's "Not a known device", inside the
      // adapter. The verification operation maps this to safe protocol
      // metadata without exposing SDK text or response bodies.
      throw new Error("Matrix verification request could not be created");
    }
    // Rust crypto can leave otherDeviceId unset while an outgoing request is
    // still Requested. Keep the exact arguments used to create this handle as
    // its temporary binding; once Rust exposes an identity, the raw value is
    // returned and can be checked for conflicts by the verification operation.
    return new MatrixSdkVerificationRequest(request, { userId, deviceId });
  }

  onVerificationRequest(
    listener: (request: CryptoVerificationRequestHandle) => void,
  ): Unsubscribe {
    let active = true;
    const wrapped = (request: unknown): void => {
      if (!active) {
        return;
      }
      try {
        listener(new MatrixSdkVerificationRequest(request));
      } catch {
        // A malformed SDK request is ignored at this adapter boundary.
      }
    };
    this.#client.on("crypto.verificationRequestReceived", wrapped);
    const existing = this.#client.getCrypto?.()?.getVerificationRequestsToDeviceInProgress?.(
      this.#userId ?? "",
    );
    if (existing !== undefined) {
      for (const request of existing) {
        queueMicrotask(() => wrapped(request));
      }
    }
    return () => {
      active = false;
      if (this.#client.off === undefined) {
        this.#client.removeListener?.("crypto.verificationRequestReceived", wrapped);
      } else {
        this.#client.off("crypto.verificationRequestReceived", wrapped);
      }
    };
  }
}

function hasExactDevice(value: unknown, userId: string, deviceId: string): boolean {
  if (!(value instanceof Map)) {
    return false;
  }
  const devices = (value as Map<unknown, unknown>).get(userId);
  if (!(devices instanceof Map)) {
    return false;
  }
  const device = (devices as Map<unknown, unknown>).get(deviceId);
  if (!isRecord(device) || device.userId !== userId || device.deviceId !== deviceId) {
    return false;
  }
  const keys = device.keys;
  if (!(keys instanceof Map)) {
    return false;
  }
  const ed25519Key = (keys as Map<unknown, unknown>).get(`ed25519:${deviceId}`);
  const curve25519Key = (keys as Map<unknown, unknown>).get(`curve25519:${deviceId}`);
  return typeof ed25519Key === "string" && ed25519Key.length > 0 &&
    typeof curve25519Key === "string" && curve25519Key.length > 0;
}

export const createMatrixCryptoAdapter = (
  client: MatrixSdkClientLike,
  options: MatrixSdkCryptoAdapterOptions = {},
): MatrixSdkCryptoAdapter => new MatrixSdkCryptoAdapter(client, options);

interface MatrixSdkVerificationRequestLike {
  readonly otherUserId?: unknown;
  readonly otherDeviceId?: unknown;
  readonly initiatedByMe?: unknown;
  readonly phase?: unknown;
  readonly chosenMethod?: unknown;
  readonly verifier?: unknown;
  otherPartySupportsMethod?(method: string): boolean;
  accept?(): Promise<void>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  startVerification?(method: string): Promise<unknown>;
  cancel?(parameters?: unknown): Promise<void>;
}

interface MatrixSdkVerificationRequestBinding {
  readonly userId: string;
  readonly deviceId: string;
}

interface MatrixSdkSasCallbacksLike {
  readonly sas?: {
    readonly emoji?: readonly (readonly [string, string])[];
    readonly decimal?: readonly [number, number, number];
  };
  confirm(): Promise<void>;
  mismatch(): void;
  cancel(): void;
}

interface MatrixSdkVerifierLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  verify(): Promise<void>;
  cancel?(error: Error): void;
}

class MatrixSdkSasVerifier implements CryptoSasVerifier {
  readonly #verifier: MatrixSdkVerifierLike;

  constructor(verifier: unknown) {
    if (!isRecord(verifier) || typeof verifier.verify !== "function" || typeof verifier.on !== "function") {
      throw new Error("Matrix SAS verifier is invalid");
    }
    this.#verifier = verifier as unknown as MatrixSdkVerifierLike;
  }

  onShowSas(listener: (sas: CryptoSasCallbacks) => void): Unsubscribe {
    const wrapped = (value: unknown): void => {
      if (!isRecord(value) || typeof value.confirm !== "function" ||
          typeof value.mismatch !== "function" || typeof value.cancel !== "function") {
        return;
      }
      const raw = value as unknown as MatrixSdkSasCallbacksLike;
      listener({
        ...(raw.sas?.emoji === undefined ? {} : { emoji: raw.sas.emoji }),
        ...(raw.sas?.decimal === undefined ? {} : { decimal: raw.sas.decimal }),
        confirm: () => raw.confirm(),
        mismatch: () => raw.mismatch(),
        cancel: () => raw.cancel(),
      });
    };
    this.#verifier.on("show_sas", wrapped);
    return () => this.#remove("show_sas", wrapped);
  }

  onCancel(listener: () => void): Unsubscribe {
    const wrapped = (): void => listener();
    this.#verifier.on("cancel", wrapped);
    return () => this.#remove("cancel", wrapped);
  }

  verify(): Promise<void> {
    return this.#verifier.verify();
  }

  cancel(): void {
    this.#verifier.cancel?.(new Error("verification cancelled"));
  }

  #remove(event: string, listener: (...args: unknown[]) => void): void {
    if (this.#verifier.off === undefined) {
      this.#verifier.removeListener?.(event, listener);
    } else {
      this.#verifier.off(event, listener);
    }
  }
}

class MatrixSdkVerificationRequest implements CryptoVerificationRequestHandle {
  readonly #request: MatrixSdkVerificationRequestLike;
  readonly #binding: MatrixSdkVerificationRequestBinding | undefined;

  constructor(request: unknown, binding?: MatrixSdkVerificationRequestBinding) {
    if (!isRecord(request)) {
      throw new Error("Matrix verification request is invalid");
    }
    this.#request = request;
    this.#binding = binding;
  }

  get userId(): string {
    return typeof this.#request.otherUserId === "string"
      ? this.#request.otherUserId
      : this.#binding?.userId ?? "";
  }

  get deviceId(): string {
    return typeof this.#request.otherDeviceId === "string"
      ? this.#request.otherDeviceId
      : this.#binding?.deviceId ?? "";
  }

  get initiatedByMe(): boolean {
    return this.#request.initiatedByMe === true;
  }

  get phase(): CryptoVerificationRequestPhase {
    let phase: unknown;
    try {
      phase = this.#request.phase;
    } catch {
      throw new Error("Matrix verification request phase is unavailable");
    }
    switch (phase) {
      case 1: {
        return "unsent";
      }
      case 2: {
        return "requested";
      }
      case 3: {
        return "ready";
      }
      case 4: {
        return "started";
      }
      case 5: {
        return "cancelled";
      }
      case 6: {
        return "done";
      }
      default: {
        throw new Error("Matrix verification request has an invalid phase");
      }
    }
  }

  get chosenMethod(): string | undefined {
    return typeof this.#request.chosenMethod === "string" ? this.#request.chosenMethod : undefined;
  }

  get verifier(): CryptoSasVerifier | undefined {
    if (this.#request.verifier === undefined) {
      return undefined;
    }
    return new MatrixSdkSasVerifier(this.#request.verifier);
  }

  supportsMethod(method: string): boolean {
    if (this.#request.otherPartySupportsMethod === undefined) {
      throw new Error("Matrix verification request capability checks are unavailable");
    }
    try {
      return this.#request.otherPartySupportsMethod(method);
    } catch {
      throw new Error("Matrix verification request capability check failed");
    }
  }

  async accept(): Promise<void> {
    if (this.#request.accept === undefined) {
      throw new Error("Matrix verification request cannot be accepted");
    }
    try {
      await this.#request.accept();
    } catch {
      throw new Error("Matrix verification request acceptance failed");
    }
  }

  onChange(listener: () => void): Unsubscribe {
    if (this.#request.on === undefined) {
      throw new Error("Matrix verification request change events are unavailable");
    }
    const wrapped = (): void => listener();
    try {
      this.#request.on("change", wrapped);
    } catch {
      throw new Error("Matrix verification request change subscription failed");
    }
    return () => {
      if (this.#request.off === undefined) {
        this.#request.removeListener?.("change", wrapped);
      } else {
        this.#request.off("change", wrapped);
      }
    };
  }

  async startVerification(method: typeof SAS_VERIFICATION_METHOD): Promise<CryptoSasVerifier> {
    if (this.#request.startVerification === undefined) {
      throw new Error("Matrix verification request cannot start SAS");
    }
    try {
      return new MatrixSdkSasVerifier(await this.#request.startVerification(method));
    } catch {
      throw new Error("Matrix SAS verification could not be started");
    }
  }

  async cancel(): Promise<void> {
    if (this.#request.cancel === undefined) {
      throw new Error("Matrix verification request cannot be cancelled");
    }
    try {
      await this.#request.cancel({ reason: "Manual SAS verification cancelled" });
    } catch {
      throw new Error("Matrix verification request cancellation failed");
    }
  }
}

/**
 * Safe error returned by adapter operations.  The original SDK error is not
 * copied into the message or the classification, so callers can log this
 * without leaking Matrix response bodies or request details.
 */
export class MatrixAdapterError extends Error {
  readonly operation: MatrixOperation;
  readonly failure: MatrixFailureClassification;

  constructor(
    operation: MatrixOperation,
    message: string,
    failure: MatrixFailureClassification,
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.name = "MatrixAdapterError";
    this.operation = operation;
    this.failure = failure;
    if (options !== undefined && options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: false,
      });
    }
  }
}

export class MatrixIdentityMismatchError extends MatrixAdapterError {
  constructor(message: string) {
    super("whoami", message, {
      kind: "permanent",
      retryable: false,
      sdkRetryable: false,
    });
    this.name = "MatrixIdentityMismatchError";
  }
}

interface MatrixErrorRecord {
  readonly [key: string]: unknown;
}

/**
 * The Matrix SDK's default logger writes through the process console.  The
 * bridge's stdout is the ACP NDJSON transport, so the SDK must not receive
 * that logger in this process.  Keep this interface local rather than making
 * the SDK logger type part of the bridge-facing API.
 */
interface MatrixSdkLogger {
  trace(...messages: unknown[]): void;
  debug(...messages: unknown[]): void;
  info(...messages: unknown[]): void;
  warn(...messages: unknown[]): void;
  error(...messages: unknown[]): void;
  log(...messages: unknown[]): void;
  getChild(namespace: string): MatrixSdkLogger;
}

const silentMatrixSdkLogger: MatrixSdkLogger = {
  trace() { /* Matrix diagnostics are disabled for the ACP process. */ },
  debug() { /* Matrix diagnostics are disabled for the ACP process. */ },
  info() { /* Matrix diagnostics are disabled for the ACP process. */ },
  warn() { /* Matrix diagnostics are disabled for the ACP process. */ },
  error() { /* Matrix diagnostics are disabled for the ACP process. */ },
  log() { /* Matrix diagnostics are disabled for the ACP process. */ },
  getChild() {
    return silentMatrixSdkLogger;
  },
};

interface MatrixSdkRootLogger extends MatrixSdkLogger {
  setLevel(level: "silent", persist?: boolean): void;
}

function silenceMatrixSdkRootLogger(): void {
  // MatrixRTC's static helpers import this logger directly instead of using
  // the logger supplied to MatrixClient. Configure it before creating the
  // client so module-level child loggers are silent too.
  const rootLogger = matrixSdkRootLogger as unknown as MatrixSdkRootLogger;
  rootLogger.setLevel("silent", false);
  rootLogger.getChild = () => silentMatrixSdkLogger;
}

function own(value: MatrixErrorRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function property(value: MatrixErrorRecord, key: string): unknown {
  return value[key];
}

function retryDelayFromError(error: unknown): number | undefined {
  if (isRecord(error)) {
    const getRetryAfterMs = property(error, "getRetryAfterMs");
    if (typeof getRetryAfterMs === "function") {
      try {
        const result = (getRetryAfterMs as () => unknown).call(error);
        if (typeof result === "number" && Number.isFinite(result) && result >= 0) {
          return result;
        }
      } catch {
        // An invalid SDK hint is treated as absent.  The SDK fallback below
        // still supplies a safe retryability decision.
      }
    }

    const data = property(error, "data");
    const retryAfterMs = numberProperty(data, "retry_after_ms");
    if (retryAfterMs !== undefined && Number.isInteger(retryAfterMs) && retryAfterMs >= 0) {
      return retryAfterMs;
    }

    const headers = property(error, "httpHeaders");
    if (isRecord(headers)) {
      const get = property(headers, "get");
      if (typeof get === "function") {
        try {
          const value = (get as (name: string) => unknown).call(headers, "Retry-After");
          const parsed = parseRetryAfterHeader(value);
          if (parsed !== undefined) {
            return parsed;
          }
        } catch {
          // Ignore malformed server hints.
        }
      }
    }
  }
  return undefined;
}

function parseRetryAfterHeader(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    if (Number.isSafeInteger(seconds)) {
      return seconds * 1000;
    }
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }
  return undefined;
}

function sdkRetryDelay(error: unknown, attempts: number): number {
  try {
    return calculateRetryBackoff(error, attempts, true);
  } catch {
    return -1;
  }
}

/**
 * Classify a Matrix/SDK failure without retrying it.  The SDK's own
 * `calculateRetryBackoff` is used as the retryability oracle; this adapter
 * only returns its result as metadata for the coordinator.
 */
export function classifyMatrixError(
  error: unknown,
  attempts = 0,
): MatrixFailureClassification {
  const httpStatus = numberProperty(error, "httpStatus", "statusCode", "status");
  const data = isRecord(error) ? own(error, "data") : undefined;
  const errcode =
    stringProperty(error, "errcode", "errorCode") ?? stringProperty(data, "errcode");
  const name = stringProperty(error, "name");
  const sdkDelay = sdkRetryDelay(error, Math.max(0, attempts));
  const sdkRetryable = sdkDelay >= 0;

  const isClientError =
    httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500;
  const isRedirect =
    httpStatus !== undefined && httpStatus >= 300 && httpStatus < 400;
  const explicitlyPermanent =
    name === "AbortError" ||
    name === "M_TOO_LARGE" ||
    errcode === "M_TOO_LARGE" ||
    isRedirect ||
    (isClientError && httpStatus !== 408 && httpStatus !== 429);
  const isTransientStatus =
    httpStatus === 408 ||
    httpStatus === 429 ||
    (httpStatus !== undefined && httpStatus >= 500 && httpStatus < 600);
  const retryable = !explicitlyPermanent && (isTransientStatus || sdkRetryable);
  const kind = retryable ? "transient" : "permanent";

  if (!retryable) {
    return {
      kind,
      retryable,
      sdkRetryable,
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(errcode === undefined ? {} : { errcode }),
    };
  }

  const retryAfterMs =
    retryDelayFromError(error) ??
    (sdkDelay >= 0
      ? sdkDelay
      : 1000 * 2 ** Math.min(Math.max(0, attempts), 4));
  return {
    kind,
    retryable,
    retryAfterMs,
    sdkRetryable,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(errcode === undefined ? {} : { errcode }),
  };
}

function permanentFailure(): MatrixFailureClassification {
  return { kind: "permanent", retryable: false, sdkRetryable: false };
}

/** Identify SDK encryption failures without allowing their text to escape. */
function looksLikeCryptoFailure(error: unknown): boolean {
  const record = isRecord(error) ? error : undefined;
  const code = stringProperty(record, "code", "errcode", "errorCode", "name");
  if (code !== undefined && /crypto|encrypt|olm|megolm|room.?key|device.?key/iu.test(code)) {
    return true;
  }
  const message = stringProperty(record, "message");
  return message !== undefined && /crypto|encrypt|olm|megolm|room.?key|device.?key/iu.test(message);
}

function matrixConfigFrom(config: MatrixConfig | BridgeConfig): MatrixConfig {
  if ("matrix" in config) {
    return config.matrix;
  }
  return config;
}

function defaultClientFactory(options: MatrixClientCreateOptions): MatrixSdkClientLike {
  let client: MatrixSdkClientLike | undefined;
  let loading: Promise<MatrixSdkClientLike> | undefined;
  const subscriptions: SdkSubscription[] = [];
  const store = new CursorAwareMatrixStore();

  const load = async (): Promise<MatrixSdkClientLike> => {
    if (client !== undefined) {
      return client;
    }
    if (loading === undefined) {
      loading = Promise.resolve().then(() => {
        silenceMatrixSdkRootLogger();
        client = createClient({
          baseUrl: options.baseUrl,
          accessToken: options.accessToken,
          userId: options.userId,
          deviceId: options.deviceId,
          ...(options.verificationMethods === undefined
            ? {}
            : { verificationMethods: [...options.verificationMethods] }),
          store,
          logger: silentMatrixSdkLogger,
        }) as unknown as MatrixSdkClientLike;
        for (const subscription of subscriptions) {
          client.on(subscription.event, subscription.listener);
        }
        return client;
      });
    }
    return loading;
  };

  return {
    on(event, listener) {
      const subscription = { event, listener };
      subscriptions.push(subscription);
      if (client !== undefined) {
        client.on(event, listener);
      }
    },
    off(event, listener) {
      const index = subscriptions.findIndex(
        (subscription) =>
          subscription.event === event && subscription.listener === listener,
      );
      if (index !== -1) {
        subscriptions.splice(index, 1);
      }
      if (client?.off === undefined) {
        client?.removeListener?.(event, listener);
      } else {
        client.off(event, listener);
      }
    },
    async whoami() {
      return (await load()).whoami();
    },
    async startClient() {
      await (await load()).startClient();
    },
    stopClient() {
      client?.stopClient();
    },
    async initRustCrypto(options?: {
      readonly useIndexedDB?: boolean;
      readonly cryptoDatabasePrefix?: string;
    }) {
      await (await load()).initRustCrypto?.(options);
    },
    getCrypto() {
      return client?.getCrypto?.();
    },
    getRoom(roomId) {
      return client?.getRoom(roomId);
    },
    getJoinedRooms() {
      return load().then((loaded) => loaded.getJoinedRooms?.() ?? { joined_rooms: [] });
    },
    roomState(roomId) {
      return load().then((loaded) => loaded.roomState?.(roomId) ?? []);
    },
    async sendTyping(roomId, isTyping, timeoutMs) {
      await (await load()).sendTyping?.(roomId, isTyping, timeoutMs);
    },
    async sendReadReceiptById(roomId, eventId) {
      const loaded = await load();
      const matrixRoom = loaded.getRoom(roomId);
      const event = matrixRoom?.findEventById?.(eventId);
      if (event !== undefined && loaded.sendReadReceipt !== undefined) {
        await loaded.sendReadReceipt(event, "m.read", true);
      }
    },
    store,
    async sendMessage(roomId, content, transactionId) {
      await (await load()).sendMessage(roomId, content, transactionId);
    },
  };
}

function syncStateFrom(value: unknown): MatrixSyncState | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value) {
    case SDK_SYNC_STATES.error:
    case SDK_SYNC_STATES.prepared:
    case SDK_SYNC_STATES.stopped:
    case SDK_SYNC_STATES.syncing:
    case SDK_SYNC_STATES.catchup:
    case SDK_SYNC_STATES.reconnecting: {
      return value;
    }
    default: {
      return undefined;
    }
  }
}

function unsubscribeFrom<T>(set: Set<T>, listener: T): void {
  set.delete(listener);
}

type Lifecycle = "idle" | "starting" | "ready" | "stopped";

interface EventContext {
  readonly order: number;
  readonly isLive: boolean;
  readonly isCatchUp: boolean;
  readonly limited: boolean;
  readonly catchUpClosed: boolean;
}

type EncryptedEventStatus = "pending" | "completed" | "omitted";

/**
 * Metadata-only state for one encrypted event.  In particular, this record
 * never retains the Matrix event, encrypted content, clear content, or SDK
 * failure object.  It exists separately from #eventIds because ciphertext
 * must not consume the ordinary processed-event FIFO before decryption.
 */
interface EncryptedEventRecord {
  readonly status: EncryptedEventStatus;
  readonly roomId?: string;
  readonly sender?: string;
  readonly isCatchUp: boolean;
}

interface SdkSubscription {
  readonly event: string;
  readonly listener: SdkListener;
}

export class MatrixClientAdapterImpl implements MatrixClientAdapter {
  readonly #config: MatrixConfig;
  readonly #client: MatrixSdkClientLike;
  readonly #crypto: MatrixCryptoAdapter | undefined;
  readonly #diagnostics: DiagnosticSink | undefined;
  readonly #configuredRooms: ReadonlySet<string>;

  #lifecycle: Lifecycle = "idle";
  #intakeStopped = false;
  #intakeEnabled = true;
  #prepared = false;
  #fatalEmitted = false;
  #sdkStopped = false;
  #cryptoInitialized = false;
  #cryptoClosed = false;
  #lastSyncState: MatrixSyncState | null = null;

  readonly #syncStateListeners = new Set<MatrixSyncStateListener>();
  readonly #syncBatchListeners = new Set<MatrixSyncBatchListener>();
  readonly #fatalListeners = new Set<FatalErrorListener>();
  readonly #decryptedListeners = new Set<MatrixDecryptionListener>();
  readonly #decryptionFailureListeners = new Set<MatrixDecryptionFailureListener>();
  readonly #sdkSubscriptions: SdkSubscription[] = [];
  readonly #eventIds = new Set<string>();
  readonly #eventOrder: string[] = [];
  readonly #encryptedEvents = new Map<string, EncryptedEventRecord>();
  readonly #eventContexts = new Map<string, EventContext>();
  readonly #validatedRooms = new Map<string, boolean>();
  readonly #pendingBatchEvents: InboundMatrixEvent[] = [];
  readonly #pendingBatchLimitedRooms = new Set<string>();

  #since: string | undefined;
  #firstBatch = true;
  #nextEventOrder = 0;
  #syncBatchInFlight = false;
  #pendingNextBatch: string | undefined;

  #resolvePrepared: (() => void) | undefined;
  #rejectPrepared: ((error: unknown) => void) | undefined;
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;

  constructor(
    config: MatrixConfig | BridgeConfig,
    accessToken: string,
    options: MatrixClientAdapterOptions = {},
  ) {
    this.#config = matrixConfigFrom(config);
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new MatrixAdapterError(
        "whoami",
        "The Matrix access token is missing",
        permanentFailure(),
      );
    }
    if (options.client !== undefined && options.clientFactory !== undefined) {
      throw new TypeError("Specify either client or clientFactory, not both");
    }

    this.#configuredRooms = new Set(this.#config.allowedRooms);
    this.#diagnostics = options.diagnostics === undefined || options.diagnostics instanceof RateLimitedDiagnosticSink
      ? options.diagnostics
      : new RateLimitedDiagnosticSink(options.diagnostics);
    const factory = options.clientFactory ?? defaultClientFactory;
    this.#client = options.client ??
      factory({
        baseUrl: this.#config.homeserver,
        accessToken,
        userId: this.#config.userId,
        deviceId: this.#config.deviceId,
        ...(this.#config.encryption === "required"
          ? { verificationMethods: [SAS_VERIFICATION_METHOD] }
          : {}),
      });
    this.#crypto = this.#config.encryption === "required"
      ? options.cryptoAdapter ?? createMatrixCryptoAdapter(this.#client, {
        useNodeIndexedDb: options.client === undefined && options.clientFactory === undefined,
      })
      : undefined;
  }

  /** The SDK client is intentionally not exposed outside the adapter. */
  get lifecycle(): Lifecycle {
    return this.#lifecycle;
  }

  async whoAmI(): Promise<MatrixIdentity> {
    let response: unknown;
    try {
      response = await this.#client.whoami();
    } catch (error) {
      throw this.#operationError("whoami", error, "Matrix identity request failed");
    }

    if (!isRecord(response)) {
      throw new MatrixAdapterError(
        "whoami",
        "Matrix identity response is invalid",
        permanentFailure(),
      );
    }
    const userId = own(response, "user_id");
    const deviceId = own(response, "device_id");
    if (typeof userId !== "string" || userId.length === 0 ||
        typeof deviceId !== "string" || deviceId.length === 0) {
      throw new MatrixAdapterError(
        "whoami",
        "Matrix identity response is missing a user or device ID",
        permanentFailure(),
      );
    }
    return { userId, deviceId };
  }

  /** Call whoami and enforce the configured user/device identity. */
  async validateIdentity(): Promise<MatrixIdentity> {
    const identity = await this.whoAmI();
    assertMatrixIdentity(identity, this.#config);
    return identity;
  }

  /** Initialize Rust crypto before Matrix sync begins in required mode. */
  async initializeCrypto(state: CryptoStatePaths): Promise<void> {
    if (this.#config.encryption !== "required") {
      return;
    }
    if (this.#crypto === undefined) {
      throw new MatrixAdapterError(
        "start",
        "Required Matrix encryption needs a crypto-enabled Matrix adapter",
        permanentFailure(),
      );
    }
    if (this.#cryptoInitialized) {
      return;
    }
    const options: CryptoInitializationOptions = {
      state,
      userId: this.#config.userId,
      deviceId: this.#config.deviceId,
    };
    try {
      await this.#crypto.initialize(options);
      this.#cryptoInitialized = true;
    } catch (error) {
      throw new MatrixAdapterError(
        "start",
        "Matrix Rust crypto initialization failed",
        permanentFailure(),
        { cause: error },
      );
    }
  }

  /** Obtain only the normalized public keys needed by the bridge manifest. */
  async getDeviceKeyFingerprints(): Promise<CryptoDeviceKeyFingerprints> {
    if (this.#config.encryption !== "required" || this.#crypto === undefined || !this.#cryptoInitialized) {
      throw new MatrixAdapterError(
        "start",
        "Matrix Rust crypto is not initialized",
        permanentFailure(),
      );
    }
    try {
      return await this.#crypto.getDeviceKeyFingerprints();
    } catch (error) {
      throw new MatrixAdapterError(
        "start",
        "Matrix Rust crypto public keys are unavailable",
        permanentFailure(),
        { cause: error },
      );
    }
  }

  getCryptoVerificationAdapter(): MatrixCryptoVerificationAdapter {
    if (
      this.#config.encryption !== "required" ||
      this.#crypto === undefined ||
      typeof (this.#crypto as Partial<MatrixCryptoVerificationAdapter>).requestDeviceVerification !== "function" ||
      typeof (this.#crypto as Partial<MatrixCryptoVerificationAdapter>).onVerificationRequest !== "function"
    ) {
      throw new MatrixAdapterError(
        "start",
        "Matrix SAS verification is unavailable",
        permanentFailure(),
      );
    }
    return this.#crypto as MatrixCryptoVerificationAdapter;
  }

  async closeCrypto(): Promise<void> {
    if (this.#cryptoClosed || this.#crypto === undefined) {
      return;
    }
    this.#cryptoClosed = true;
    await this.#crypto.close();
  }

  onDecrypted(listener: MatrixDecryptionListener): Unsubscribe {
    this.#decryptedListeners.add(listener);
    return () => unsubscribeFrom(this.#decryptedListeners, listener);
  }

  onDecryptionFailure(listener: MatrixDecryptionFailureListener): Unsubscribe {
    this.#decryptionFailureListeners.add(listener);
    return () => unsubscribeFrom(this.#decryptionFailureListeners, listener);
  }

  onSyncState(listener: MatrixSyncStateListener): Unsubscribe {
    this.#syncStateListeners.add(listener);
    return () => unsubscribeFrom(this.#syncStateListeners, listener);
  }

  onSyncBatch(listener: MatrixSyncBatchListener): Unsubscribe {
    this.#syncBatchListeners.add(listener);
    return () => unsubscribeFrom(this.#syncBatchListeners, listener);
  }

  /** Convenience subscription for the SDK's nonfatal reconnect transition. */
  onReconnect(listener: MatrixSyncStateListener): Unsubscribe {
    const wrapped: MatrixSyncStateListener = (change) => {
      if (change.state === "RECONNECTING") {
        listener(change);
      }
    };
    return this.onSyncState(wrapped);
  }

  onFatalError(listener: FatalErrorListener): Unsubscribe {
    this.#fatalListeners.add(listener);
    return () => unsubscribeFrom(this.#fatalListeners, listener);
  }

  start(options: MatrixSyncStartOptions = {}): Promise<void> {
    if (this.#lifecycle === "ready") {
      return Promise.resolve();
    }
    if (this.#lifecycle === "starting" && this.#startPromise !== undefined) {
      return this.#startPromise;
    }
    if (this.#lifecycle === "stopped") {
      return Promise.reject(new MatrixAdapterError(
        "start",
        "The Matrix adapter has been stopped",
        permanentFailure(),
      ));
    }

    if (this.#config.encryption === "required" && !this.#cryptoInitialized) {
      return Promise.reject(new MatrixAdapterError(
        "start",
        "Matrix Rust crypto must be initialized before sync",
        permanentFailure(),
      ));
    }

    this.#lifecycle = "starting";
    this.#intakeStopped = false;
    this.#intakeEnabled = options.intakeEnabled !== false;
    this.#since = options.since;
    this.#firstBatch = true;
    this.#pendingBatchEvents.length = 0;
    this.#pendingBatchLimitedRooms.clear();
    this.#encryptedEvents.clear();
    this.#eventContexts.clear();
    this.#nextEventOrder = 0;
    this.#pendingNextBatch = undefined;
    this.#registerSdkListeners();
    this.#startPromise = this.#runStart();
    return this.#startPromise;
  }

  stopIntake(): void {
    this.#intakeStopped = true;
    this.#pendingBatchEvents.length = 0;
    this.#encryptedEvents.clear();
    this.#eventContexts.clear();
    if (this.#lifecycle === "starting") {
      this.#rejectPrepared?.(new MatrixAdapterError(
        "start",
        "Matrix intake stopped during startup",
        permanentFailure(),
      ));
      this.#rejectPrepared = undefined;
      this.#resolvePrepared = undefined;
    }
  }

  async sendMessage(part: RenderedMatrixPart): Promise<void> {
    if (this.#lifecycle === "stopped") {
      throw new MatrixAdapterError(
        "send_message",
        "The Matrix adapter has been stopped",
        permanentFailure(),
      );
    }
    if (
      !isRecord(part) ||
      typeof part.roomId !== "string" ||
      typeof part.transactionId !== "string" ||
      !isRecord(part.content) ||
      part.content.msgtype !== "m.text" ||
      typeof part.content.body !== "string"
    ) {
      throw new MatrixAdapterError(
        "send_message",
        "The Matrix message part is invalid",
        permanentFailure(),
      );
    }

    if (!this.#configuredRooms.has(part.roomId)) {
      throw new MatrixAdapterError(
        "send_message",
        "The Matrix response room is not configured",
        permanentFailure(),
      );
    }
    if (this.#config.encryption === "required" && this.#validatedRooms.get(part.roomId) !== true) {
      throw this.#fatalEncryptionSend("Required Matrix encryption is not ready for this room");
    }

    // Construct a fresh top-level content object.  This deliberately strips
    // relations, formatting, and any accidental caller-supplied fields.
    const content = {
      msgtype: "m.text",
      body: part.content.body,
    } as const;
    try {
      await this.#client.sendMessage(part.roomId, content, part.transactionId);
    } catch (error) {
      if (this.#config.encryption === "required" && looksLikeCryptoFailure(error)) {
        throw this.#fatalEncryptionSend("Matrix encrypted message delivery failed", error);
      }
      throw this.#operationError(
        "send_message",
        error,
        "Matrix message send failed",
      );
    }
  }

  async sendTyping(roomId: string, isTyping: boolean, timeoutMs: number): Promise<void> {
    if (this.#client.sendTyping === undefined) {
      return;
    }
    try {
      await this.#client.sendTyping(roomId, isTyping, timeoutMs);
    } catch (error) {
      throw this.#operationError("send_message", error, "Matrix typing update failed");
    }
  }

  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    try {
      if (this.#client.sendReadReceiptById !== undefined) {
        await this.#client.sendReadReceiptById(roomId, eventId);
        return;
      }
      const room = this.#client.getRoom(roomId);
      const event = room?.findEventById?.(eventId);
      if (event !== undefined && this.#client.sendReadReceipt !== undefined) {
        await this.#client.sendReadReceipt(event, "m.read", true);
      }
    } catch (error) {
      throw this.#operationError("send_message", error, "Matrix read receipt failed");
    }
  }

  async stop(): Promise<void> {
    if (this.#stopPromise !== undefined) {
      return this.#stopPromise;
    }
    // A startup callback can report a fatal checkpoint or room-invariant
    // failure while #runStart is awaiting that callback. Waiting for
    // #startPromise here would create a cycle: start waits for the callback,
    // the callback reports fatal, and shutdown waits for start. stopIntake()
    // already rejects the PREPARED gate and stopClient() interrupts the SDK;
    // let the startup unwind independently in this phase.
    const startupInProgress = this.#lifecycle === "starting";
    this.#stopPromise = (async () => {
      this.stopIntake();
      this.#detachSdkListeners();
      // Stop the SDK before flushing Node IndexedDB. Rust crypto may persist
      // account and Olm state during stopClient(); flushing first can lose
      // one-time-key and session updates needed by the next process.
      this.#stopSdkClient();
      // Persistence failure is a shutdown failure: suppressing it can report a
      // clean stop after losing the latest Olm or Megolm state.
      await this.closeCrypto();
      if (!startupInProgress) {
        await this.#startPromise?.catch(() => {});
      }
      this.#lifecycle = "stopped";
    })();
    return this.#stopPromise;
  }

  async #runStart(): Promise<void> {
    const preparedPromise = new Promise<void>((resolve, reject) => {
      this.#resolvePrepared = resolve;
      this.#rejectPrepared = reject;
    });

    let sdkStart: Promise<void> | undefined;

    try {
      this.#prepareStoreForStartup();
      sdkStart = Promise.resolve().then(() => this.#client.startClient());
      sdkStart.catch((error: unknown) => {
        this.#rejectPrepared?.(
          this.#startError(error, "Matrix sync failed to start"),
        );
      });
      await preparedPromise;
      await sdkStart;
      if (this.#intakeStopped || this.#fatalEmitted) {
        throw new MatrixAdapterError(
          "start",
          "Matrix intake stopped during startup",
          permanentFailure(),
        );
      }
      this.#verifySavedSyncToken();
      await this.validateConfiguredRooms();
      if (this.#pendingNextBatch === undefined) {
        throw new MatrixAdapterError(
          "start",
          "Matrix sync response did not establish a cursor",
          permanentFailure(),
        );
      }
      await this.#emitPendingBatch();
      this.#resolvePrepared = undefined;
      this.#rejectPrepared = undefined;
      this.#lifecycle = "ready";
      if (this.#pendingNextBatch !== undefined) {
        void this.#emitPendingBatch().catch(() => {});
      }
    } catch (error) {
      const normalized = error instanceof MatrixAdapterError
        ? error
        : this.#operationError("start", error, "Matrix startup failed");
      this.stopIntake();
      this.#detachSdkListeners();
      this.#stopSdkClient();
      this.#lifecycle = "stopped";
      if (!this.#fatalEmitted) {
        this.#emitFatal({
          code: normalized.failure.kind === "transient" ? "matrix_transport" : "startup",
          message: normalized.message,
        });
      }
      throw normalized;
    }
  }

  #prepareStoreForStartup(): void {
    const store = this.#client.store;
    if (
      store?.setSyncToken === undefined ||
      store.getSavedSync === undefined ||
      store.getSavedSyncToken === undefined ||
      store.resetStartupObservation === undefined ||
      store.getStartupTokenObservation === undefined
    ) {
      throw new MatrixAdapterError(
        "start",
        "Matrix client store does not support cursor-aware startup",
        permanentFailure(),
      );
    }
    store.resetStartupObservation();
    if (this.#since !== undefined) {
      store.setSyncToken(this.#since);
    }
  }

  #verifySavedSyncToken(): void {
    const observation = this.#client.store?.getStartupTokenObservation?.();
    const expected = this.#since ?? null;
    if (observation?.consulted !== true || observation.value !== expected) {
      throw new MatrixAdapterError(
        "start",
        "Matrix client store did not return the expected saved cursor",
        permanentFailure(),
      );
    }
    try {
      this.#diagnostics?.info("saved-sync-token-verified");
    } catch {
      // Diagnostics are observational and never affect startup verification.
    }
  }

  /**
   * Validate every configured room, including membership and encryption.
   * This remains a synchronous SDK lookup today, but the async boundary lets
   * a cursor-aware adapter perform an independent current-state query.
   */
  async validateConfiguredRooms(): Promise<MatrixConfiguredRoomValidation> {
    return this.#validateConfiguredRooms();
  }

  #registerSdkListeners(): void {
    this.#addSdkListener(SDK_EVENTS.event, this.#handleClientEvent);
    // Rust crypto re-emits this event after each asynchronous decrypt attempt.
    // It is the retry path for events whose first observation contained only
    // ciphertext, and it also carries the SDK's success/failure distinction.
    this.#addSdkListener(SDK_EVENTS.decrypted, this.#handleDecryptedEvent);
    // Room.timeline is retained as a boundary-level fallback.  The global
    // event callback is the primary source; the bounded event-ID index keeps
    // the two SDK notifications from producing duplicate bridge events.
    this.#addSdkListener(SDK_EVENTS.timeline, this.#handleTimelineEvent);
    this.#addSdkListener(SDK_EVENTS.timelineReset, this.#handleTimelineReset);
    this.#addSdkListener(SDK_EVENTS.sync, this.#handleSyncState);
    this.#addSdkListener(SDK_EVENTS.syncUnexpectedError, this.#handleSyncUnexpectedError);
    this.#addSdkListener(SDK_EVENTS.myMembership, this.#handleRoomMembership);
    this.#addSdkListener(SDK_EVENTS.roomState, this.#handleRoomStateEvent);
    this.#addSdkListener(SDK_EVENTS.memberMembership, this.#handleMemberMembership);
  }

  #addSdkListener(event: string, listener: SdkListener): void {
    this.#client.on(event, listener);
    this.#sdkSubscriptions.push({ event, listener });
  }

  #detachSdkListeners(): void {
    while (this.#sdkSubscriptions.length > 0) {
      const subscription = this.#sdkSubscriptions.pop()!;
      try {
        if (this.#client.off === undefined) {
          this.#client.removeListener?.(subscription.event, subscription.listener);
        } else {
          this.#client.off(subscription.event, subscription.listener);
        }
      } catch {
        // Listener cleanup is best effort during shutdown.
      }
    }
  }

  #handleClientEvent = (...args: unknown[]): void => {
    this.#handleInboundSdkEvent(args[0]);
  };

  #handleDecryptedEvent = (...args: unknown[]): void => {
    this.#handleInboundSdkEvent(args[0]);
  };

  #handleTimelineEvent = (...args: unknown[]): void => {
    // SDK room timeline callbacks use their third argument to indicate that
    // the event was inserted at the start (historical/back-pagination data).
    const toStartOfTimeline = args.length >= 3 ? args[2] : args[1];
    const data = args.length >= 5 && isRecord(args[4]) ? args[4] : undefined;
    const roomId = (() => {
      try {
        return (args[0] as MatrixSdkEventLike | undefined)?.getRoomId?.();
      } catch {
        return;
      }
    })();
    if (data?.limited === true && typeof roomId === "string") {
      this.#pendingBatchLimitedRooms.add(roomId);
    }
    const eventId = this.#readEventId(args[0] as MatrixSdkEventLike | undefined);
    if (eventId !== undefined) {
      this.#rememberEventContext(eventId, {
        isLive:
          toStartOfTimeline !== true &&
          data?.liveEvent !== false &&
          this.#phaseAllowsLiveEvents(),
        isCatchUp:
          this.#since !== undefined &&
          this.#firstBatch &&
          toStartOfTimeline !== true &&
          data?.liveEvent !== false,
        limited: data?.limited === true,
        catchUpClosed: false,
      });
    }
    if (toStartOfTimeline === true || data?.liveEvent === false) {
      return;
    }
    this.#handleInboundSdkEvent(args[0]);
  };

  #handleTimelineReset = (...args: unknown[]): void => {
    const room = args[0] as MatrixSdkRoomLike | undefined;
    if (typeof room?.roomId === "string") {
      this.#pendingBatchLimitedRooms.add(room.roomId);
    }
  };

  async #emitPendingBatch(): Promise<void> {
    if (this.#syncBatchInFlight || this.#pendingNextBatch === undefined) {
      return;
    }
    this.#syncBatchInFlight = true;
    const phase = this.#since === undefined && this.#firstBatch ? "initial" : "incremental";
    const isCatchUp = phase === "incremental" && this.#firstBatch;
    const events = this.#pendingBatchEvents.splice(0);
    events.sort((left, right) => this.#eventOrderFor(left) - this.#eventOrderFor(right));
    if (isCatchUp) {
      // The batch is now classified. Unresolved encrypted events are omitted
      // from this bounded selection and may not re-enter it after its cursor
      // has been committed.
      this.#closeCatchUpContexts();
    } else if (phase === "initial") {
      // First-run history is suppressed even when the SDK has not yet
      // produced clear content. Do not let a later retry turn that history
      // into live intake after the initial cursor is committed.
      this.#closeInitialEncryptedEvents();
    }
    const limitedRooms = new Set(this.#pendingBatchLimitedRooms);
    this.#pendingBatchLimitedRooms.clear();
    const rooms = new Map<string, { timeline: InboundMatrixEvent[]; limited: boolean }>();
    for (const event of events) {
      let room = rooms.get(event.roomId);
      if (room === undefined) {
        room = { timeline: [], limited: limitedRooms.has(event.roomId) };
        rooms.set(event.roomId, room);
      }
      room.timeline.push({
        ...event,
        ...(isCatchUp ? { isCatchUp: true } : { isCatchUp: false }),
        timeline: { phase, isCatchUp, limited: room.limited },
      });
    }
    for (const roomId of limitedRooms) {
      if (!rooms.has(roomId)) {
        rooms.set(roomId, { timeline: [], limited: true });
      }
    }
    const batch = {
      nextBatch: this.#pendingNextBatch,
      phase,
      rooms: [...rooms.entries()].map(([roomId, room]) => ({
        roomId,
        timeline: room.timeline,
        limited: room.limited,
      })),
    } satisfies MatrixSyncBatch;
    this.#pendingNextBatch = undefined;
    try {
      for (const listener of this.#syncBatchListeners) {
        await listener(batch);
      }
      this.#firstBatch = false;
    } finally {
      this.#syncBatchInFlight = false;
      if (this.#lifecycle === "ready" && this.#pendingNextBatch !== undefined) {
        void this.#emitPendingBatch().catch(() => {});
      }
    }
  }

  #handleInboundSdkEvent(value: unknown): void {
    if (
      this.#intakeStopped ||
      !this.#intakeEnabled ||
      this.#fatalEmitted ||
      !isRecord(value)
    ) {
      return;
    }
    const event = value as unknown as MatrixSdkEventLike;
    const eventId = this.#readEventId(event);
    if (eventId === undefined) {
      return;
    }
    if (this.#eventIds.has(eventId)) {
      return;
    }
    const encryptedRecord = this.#encryptedEvents.get(eventId);
    if (encryptedRecord?.status === "completed" || encryptedRecord?.status === "omitted") {
      return;
    }
    let context = this.#eventContexts.get(eventId);
    if (context === undefined) {
      context = this.#rememberEventContext(eventId, {
        isLive: this.#phaseAllowsLiveEvents(),
        isCatchUp: this.#since !== undefined && this.#firstBatch,
        limited: false,
        catchUpClosed: false,
      });
    }
    const encrypted = this.#isEncryptedEvent(event);
    if (this.#prepared) {
      this.#handleRuntimeInvariantEvent(event);
    }
    if (this.#fatalEmitted) {
      return;
    }
    if (!context.isLive || context.catchUpClosed) {
      if (this.#config.encryption === "required" && encrypted) {
        if (this.#hasAuthenticatedClearContent(event)) {
          this.#rememberEncryptedCompleted(eventId, context, this.#eventMetadata(event));
        } else {
          this.#rememberEncryptedPending(eventId, context, this.#eventMetadata(event));
        }
      } else if (!encrypted && !context.isLive) {
        // Plaintext history may consume the ordinary deduplication slot. The
        // encrypted path deliberately does not do this for ciphertext.
        this.#rememberEventId(eventId);
      }
      return;
    }
    const normalized = this.#normalizeEvent(event, eventId, context);
    if (normalized === undefined) {
      // Ciphertext and SDK-generated decryption-failure clear content are
      // deliberately not added to the processed-event FIFO. A later SDK
      // event may expose authenticated clear content after keys arrive.
      if (this.#config.encryption === "required" && encrypted) {
        const metadata = this.#eventMetadata(event);
        if (this.#hasAuthenticatedClearContent(event)) {
          // A successfully decrypted but unsupported clear event is still
          // complete. Retrying it on every SDK callback would keep it in the
          // pending registry forever and violate at-most-once observation.
          this.#rememberEncryptedCompleted(eventId, context, metadata);
          this.#rememberEventId(eventId);
        } else {
          this.#rememberEncryptedPending(eventId, context, metadata);
        }
        if (this.#isDecryptionFailure(event)) {
          this.#emitDecryptionFailure(event, eventId, context);
        }
      } else if (encrypted) {
        // Disabled mode rejects encrypted events at the SDK boundary. This
        // prevents ciphertext from reaching authorization or bridge code.
        this.#rememberEventId(eventId);
      } else {
        // Disabled mode retains the existing behavior: malformed/unsupported event
        // observations consume their event ID and are not replayed.
        this.#rememberEventId(eventId);
      }
      return;
    }
    // The dedup index is populated only after required-mode ciphertext has
    // yielded authenticated clear content. This permits late decryption.
    if (normalized.isEncrypted === true) {
      this.#rememberEncryptedCompleted(eventId, context, {
        roomId: normalized.roomId,
        sender: normalized.sender,
      });
    }
    this.#rememberEventId(eventId);
    if (normalized.isEncrypted === true && normalized.isDecrypted === true) {
      const decryptedEvent: MatrixDecryptedEvent = {
        event: normalized,
        crypto: {
          wireEncrypted: true,
          decrypted: true,
        } satisfies MatrixEventCryptoMetadata,
      };
      for (const listener of this.#decryptedListeners) {
        try {
          listener(decryptedEvent);
        } catch {
          // Lifecycle observers are observational and cannot affect intake.
        }
      }
    }
    this.#pendingBatchEvents.push(normalized);
  }

  #readEventId(event: MatrixSdkEventLike | undefined): string | undefined {
    if (event === undefined) {
      return undefined;
    }
    try {
      const eventId = event.getId();
      return isValidMatrixEventId(eventId) ? eventId : undefined;
    } catch {
      return undefined;
    }
  }

  #normalizeEvent(
    event: MatrixSdkEventLike,
    eventId: string,
    context: EventContext,
  ): InboundMatrixEvent | undefined {
    let roomId: string | undefined;
    let sender: string | undefined;
    let type: string;
    let content: unknown;
    let clearContent: unknown;
    let encrypted = false;
    let redacted = false;
    try {
      roomId = event.getRoomId();
      sender = event.getSender();
      encrypted = event.isEncrypted();
      redacted = event.isRedacted();
      if (encrypted && this.#isDecryptionFailure(event)) {
        return undefined;
      }
      if (this.#config.encryption === "disabled" && encrypted) {
        return undefined;
      }
      if (this.#config.encryption === "required" && encrypted) {
        clearContent = event.getClearContent?.();
        content = clearContent;
        type = event.getClearType?.() ?? event.getType();
      } else {
        type = event.getType();
        content = event.getContent();
      }
    } catch {
      return undefined;
    }
    if (
      typeof roomId !== "string" ||
      typeof sender !== "string" ||
      typeof type !== "string" ||
      !isRecord(content)
    ) {
      return undefined;
    }

    let decrypted = !encrypted;
    if (encrypted) {
      decrypted = clearContent !== null && clearContent !== undefined;
    }
    if (
      this.#config.encryption === "required" &&
      (!encrypted || !decrypted || type === "m.room.encrypted")
    ) {
      return undefined;
    }

    const stateKey = (() => {
      try {
        return event.getStateKey?.();
      } catch {
        return;
      }
    })();

    return {
      roomId,
      eventId,
      sender,
      type,
      content: { ...content },
      isLive: context.isLive,
      ...(context.isCatchUp ? { isCatchUp: true } : {}),
      isRedacted: redacted,
      isPlaintext: !encrypted,
      isEncrypted: encrypted,
      isDecrypted: decrypted,
      ...(stateKey === undefined ? {} : { stateKey }),
    };
  }

  #isEncryptedEvent(event: MatrixSdkEventLike): boolean {
    try {
      return event.isEncrypted();
    } catch {
      return false;
    }
  }

  #hasAuthenticatedClearContent(event: MatrixSdkEventLike): boolean {
    try {
      const clearContent = event.getClearContent?.();
      return event.isEncrypted() &&
        !this.#isDecryptionFailure(event) &&
        clearContent !== undefined &&
        clearContent !== null;
    } catch {
      return false;
    }
  }

  #eventMetadata(event: MatrixSdkEventLike): {
    readonly roomId?: string;
    readonly sender?: string;
  } {
    try {
      const roomId = event.getRoomId();
      const sender = event.getSender();
      return {
        ...(typeof roomId === "string" ? { roomId } : {}),
        ...(typeof sender === "string" ? { sender } : {}),
      };
    } catch {
      return {};
    }
  }

  #isDecryptionFailure(event: MatrixSdkEventLike): boolean {
    try {
      if (event.isDecryptionFailure?.() === true) {
        return true;
      }
      if (event.decryptionFailureReason !== undefined && event.decryptionFailureReason !== null) {
        return true;
      }
      // Older SDK event shims expose only the synthetic clear content after a
      // failed attempt. Never treat that diagnostic payload as authenticated
      // application content.
      const clearContent = event.getClearContent?.();
      return isRecord(clearContent) && clearContent.msgtype === "m.bad.encrypted";
    } catch {
      return true;
    }
  }

  #emitDecryptionFailure(
    event: MatrixSdkEventLike,
    eventId: string,
    context: EventContext,
  ): void {
    let roomId: string | undefined;
    let sender: string | undefined;
    try {
      roomId = event.getRoomId();
      sender = event.getSender();
    } catch {
      return;
    }
    if (typeof roomId !== "string" || typeof sender !== "string") {
      return;
    }
    const failure = classifyCryptoFailure("decrypt", "decryption_failed");
    const metadata = { roomId, eventId, sender, isCatchUp: context.isCatchUp } as const;
    try {
      this.#diagnostics?.warn("matrix-decryption-failed", {
        roomId,
        eventId,
        sender,
        isCatchUp: context.isCatchUp,
        reason: failure.reason,
      });
    } catch {
      // Diagnostics must never affect event handling.
    }
    for (const listener of this.#decryptionFailureListeners) {
      try {
        listener(failure, metadata);
      } catch {
        // Lifecycle observers are observational and cannot affect intake.
      }
    }
  }

  #rememberEventContext(
    eventId: string,
    context: Omit<EventContext, "order">,
  ): EventContext {
    const previous = this.#eventContexts.get(eventId);
    const next = previous === undefined ? {
      ...context,
      order: ++this.#nextEventOrder,
    } : {
      order: previous.order,
      isLive: previous.isLive && context.isLive,
      isCatchUp: previous.isCatchUp || context.isCatchUp,
      limited: previous.limited || context.limited,
      catchUpClosed: previous.catchUpClosed || context.catchUpClosed,
    };
    this.#eventContexts.set(eventId, next);
    while (this.#eventContexts.size > 10_000) {
      const oldest = this.#eventContexts.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      this.#eventContexts.delete(oldest);
    }
    return next;
  }

  #rememberEventId(eventId: string): void {
    this.#eventIds.add(eventId);
    this.#eventOrder.push(eventId);
    if (this.#eventOrder.length > 10_000) {
      const oldest = this.#eventOrder.shift();
      if (oldest !== undefined) {
        this.#eventIds.delete(oldest);
      }
    }
  }

  #closeCatchUpContexts(): void {
    // Classify the encrypted registry independently from event-context
    // retention. This keeps a pending catch-up event closed even if its
    // timeline context was evicted from the separate bounded ordering map.
    for (const [eventId, encrypted] of this.#encryptedEvents) {
      if (!encrypted.isCatchUp || encrypted.status !== "pending") {
        continue;
      }
      this.#encryptedEvents.set(eventId, { ...encrypted, status: "omitted" });
      const fields = {
        ...(encrypted.roomId === undefined ? {} : { roomId: encrypted.roomId }),
        ...(encrypted.sender === undefined ? {} : { sender: encrypted.sender }),
        eventId,
        isCatchUp: true,
        reason: "decryption_pending_at_catchup_cutoff",
      } as const;
      try {
        this.#diagnostics?.warn("matrix-encrypted-catch-up-omitted", fields);
      } catch {
        // Diagnostics are observational and never affect the cutoff.
      }
    }
    for (const [eventId, context] of this.#eventContexts) {
      if (!context.isCatchUp || context.catchUpClosed) {
        continue;
      }
      this.#eventContexts.set(eventId, { ...context, catchUpClosed: true });
    }
  }

  #closeInitialEncryptedEvents(): void {
    for (const [eventId, encrypted] of this.#encryptedEvents) {
      if (!encrypted.isCatchUp && encrypted.status === "pending") {
        this.#encryptedEvents.set(eventId, { ...encrypted, status: "omitted" });
      }
    }
  }

  #rememberEncryptedPending(
    eventId: string,
    context: EventContext,
    metadata: { readonly roomId?: string; readonly sender?: string },
  ): void {
    const previous = this.#encryptedEvents.get(eventId);
    if (previous?.status === "completed" || previous?.status === "omitted") {
      return;
    }
    this.#rememberEncryptedEvent(eventId, {
      status: "pending",
      isCatchUp: previous?.isCatchUp === true || context.isCatchUp,
      ...(metadata.roomId === undefined ? {} : { roomId: metadata.roomId }),
      ...(metadata.sender === undefined ? {} : { sender: metadata.sender }),
    });
  }

  #rememberEncryptedCompleted(
    eventId: string,
    context: EventContext,
    metadata: { readonly roomId?: string; readonly sender?: string },
  ): void {
    this.#rememberEncryptedEvent(eventId, {
      status: "completed",
      isCatchUp: context.isCatchUp,
      ...(metadata.roomId === undefined ? {} : { roomId: metadata.roomId }),
      ...(metadata.sender === undefined ? {} : { sender: metadata.sender }),
    });
  }

  #rememberEncryptedEvent(eventId: string, record: EncryptedEventRecord): void {
    this.#encryptedEvents.set(eventId, record);
    while (this.#encryptedEvents.size > 10_000) {
      const oldest = this.#encryptedEvents.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      this.#encryptedEvents.delete(oldest);
    }
  }

  #phaseAllowsLiveEvents(): boolean {
    // The SDK's initial timeline callbacks are normally delivered before
    // PREPARED. Once PREPARED has been observed, global callbacks can be live
    // events arriving while room validation runs; they must retain the
    // existing startup-buffer behavior. Timeline metadata still marks explicit
    // initial-history callbacks as non-live.
    return this.#prepared || this.#since !== undefined;
  }

  #eventOrderFor(event: InboundMatrixEvent): number {
    const eventId = event.eventId;
    if (eventId === undefined) {
      return Number.MAX_SAFE_INTEGER;
    }
    return this.#eventContexts.get(eventId)?.order ?? Number.MAX_SAFE_INTEGER;
  }

  #handleSyncState = (...args: unknown[]): void => {
    const state = syncStateFrom(args[0]);
    if (state === undefined) {
      return;
    }
    const previousState = syncStateFrom(args[1]) ?? this.#lastSyncState;
    this.#lastSyncState = state;
    const data = isRecord(args[2]) ? args[2] : undefined;
    const nextSyncToken = stringProperty(data, "nextSyncToken", "next_batch");
    if (nextSyncToken !== undefined &&
        (state === SDK_SYNC_STATES.prepared ||
          state === SDK_SYNC_STATES.syncing ||
          state === SDK_SYNC_STATES.catchup)) {
      this.#pendingNextBatch = nextSyncToken;
    }
    const joinedRooms = data === undefined ? undefined : own(data, "rooms");
    if (isRecord(joinedRooms)) {
      const joined = own(joinedRooms, "join");
      if (isRecord(joined)) {
        for (const [roomId, roomData] of Object.entries(joined)) {
          if (isRecord(roomData) && isRecord(own(roomData, "timeline")) &&
              own(own(roomData, "timeline") as MatrixErrorRecord, "limited") === true) {
            this.#pendingBatchLimitedRooms.add(roomId);
          }
        }
      }
    }
    const rawFailure = data === undefined ? undefined : own(data, "error");
    const failure = state === "ERROR" ? classifyMatrixError(rawFailure) : undefined;
    const change: MatrixSyncStateChange = {
      state,
      previousState: previousState ?? null,
      ...(failure === undefined ? {} : { failure }),
    };
    for (const listener of this.#syncStateListeners) {
      try {
        listener(change);
      } catch {
        // Observability callbacks are not allowed to affect SDK lifecycle.
      }
    }

    if (state === SDK_SYNC_STATES.prepared) {
      this.#prepared = true;
      this.#resolvePrepared?.();
      this.#resolvePrepared = undefined;
      this.#rejectPrepared = undefined;
      return;
    }
    if (
      this.#since !== undefined &&
      (state === SDK_SYNC_STATES.reconnecting || state === SDK_SYNC_STATES.error) &&
      this.#isSavedCursorRejection(rawFailure)
    ) {
      const error = this.#startError(rawFailure, "Matrix sync failed");
      if (this.#prepared) {
        this.#emitFatal({ code: "matrix_transport", message: error.message });
      } else {
        this.#rejectPrepared?.(error);
      }
      return;
    }
    if (state === SDK_SYNC_STATES.error) {
      const error = this.#startError(rawFailure, "Matrix sync failed");
      if (this.#prepared) {
        this.#emitFatal({ code: "matrix_transport", message: "Matrix sync failed" });
      } else {
        this.#rejectPrepared?.(error);
      }
    }
    if (
      (state === SDK_SYNC_STATES.syncing || state === SDK_SYNC_STATES.catchup) &&
      this.#lifecycle === "ready"
    ) {
      void this.#emitPendingBatch().catch(() => {});
    }
  };

  #handleSyncUnexpectedError = (): void => {
    if (!this.#prepared || this.#intakeStopped) {
      return;
    }
    this.#emitFatal({ code: "matrix_transport", message: "Matrix sync failed" });
  };

  #handleRoomMembership = (...args: unknown[]): void => {
    if (!this.#prepared || this.#intakeStopped) {
      return;
    }
    const room = args[0] as MatrixSdkRoomLike | undefined;
    const roomId = room?.roomId;
    if (
      room === undefined ||
      typeof roomId !== "string" ||
      !this.#configuredRooms.has(roomId)
    ) {
      return;
    }
    let membership = typeof args[1] === "string" ? args[1] : undefined;
    if (membership === undefined) {
      try {
        membership = room.getMyMembership();
      } catch {
        membership = undefined;
      }
    }
    if (membership !== "join") {
      this.#emitFatal({
        code: "matrix_invariant",
        message: `Bridge account left configured Matrix room ${roomId}`,
      });
    }
  };

  #handleMemberMembership = (...args: unknown[]): void => {
    if (!this.#prepared || this.#intakeStopped) {
      return;
    }
    const member = args[1] as {
      readonly roomId?: string;
      readonly userId?: string;
      readonly membership?: string;
    } | undefined;
    if (
      member?.userId !== this.#config.userId ||
      typeof member.roomId !== "string" ||
      !this.#configuredRooms.has(member.roomId)
    ) {
      return;
    }
    if (member.membership !== "join") {
      this.#emitFatal({
        code: "matrix_invariant",
        message: `Bridge account left configured Matrix room ${member.roomId}`,
      });
    }
  };

  #handleRoomStateEvent = (...args: unknown[]): void => {
    if (!this.#prepared || this.#intakeStopped) {
      return;
    }
    this.#handleRuntimeInvariantEvent(args[0] as MatrixSdkEventLike);
  };

  #handleRuntimeInvariantEvent(event: MatrixSdkEventLike): void {
    let roomId: string | undefined;
    let type: string | undefined;
    try {
      roomId = event.getRoomId();
      type = event.getType();
    } catch {
      return;
    }
    if (typeof roomId !== "string" || !this.#configuredRooms.has(roomId)) {
      return;
    }
    if (type === SDK_EVENT_TYPES.roomEncryption) {
      if (this.#config.encryption === "disabled") {
        this.#emitFatal({
          code: "matrix_invariant",
          message: `Configured Matrix room ${roomId} became encrypted`,
        });
      } else {
        void this.#assertRequiredRuntimeEncryption(roomId);
      }
      return;
    }
    if (type !== SDK_EVENT_TYPES.roomMember) {
      return;
    }
    let stateKey: string | undefined;
    let content: unknown;
    try {
      stateKey = event.getStateKey?.();
      content = event.getContent();
    } catch {
      return;
    }
    if (stateKey !== this.#config.userId || !isRecord(content)) {
      return;
    }
    if (own(content, "membership") !== "join") {
      this.#emitFatal({
        code: "matrix_invariant",
        message: `Bridge account left configured Matrix room ${roomId}`,
      });
    }
  }

  async #assertRequiredRuntimeEncryption(roomId: string): Promise<void> {
    try {
      const room = this.#client.getRoom(roomId);
      if (room === null || room === undefined || room.getMyMembership() !== "join") {
        throw new Error("room membership invariant");
      }
      const encrypted = room.hasEncryptionStateEvent();
      const crypto = this.#client.getCrypto?.();
      if (crypto === undefined) {
        throw new Error("crypto invariant");
      }
      if (crypto.isEncryptionEnabledInRoom !== undefined && !await crypto.isEncryptionEnabledInRoom(roomId)) {
          throw new Error("room crypto state invariant");
        }
      if (!encrypted) {
        throw new Error("room encryption invariant");
      }
    } catch {
      this.#emitFatal({
        code: "matrix_invariant",
        message: `Configured Matrix room ${roomId} is no longer encrypted`,
      });
    }
  }

  async #validateConfiguredRooms(): Promise<MatrixConfiguredRoomValidation> {
    this.#validatedRooms.clear();
    let joinedRooms: ReadonlySet<string> | undefined;
    if (this.#client.getJoinedRooms !== undefined) {
      try {
        const response = await this.#client.getJoinedRooms();
        if (!isRecord(response) || !Array.isArray(response.joined_rooms) ||
            response.joined_rooms.some((roomId) => typeof roomId !== "string")) {
          throw new Error("invalid joined-room response");
        }
        joinedRooms = new Set(response.joined_rooms as string[]);
      } catch (error) {
        throw this.#operationError("start", error, "Matrix room validation failed");
      }
    }
    const rooms: MatrixConfiguredRoomState[] = [];
    for (const roomId of this.#configuredRooms) {
      if (joinedRooms !== undefined && !joinedRooms.has(roomId)) {
        throw this.#startupInvariant(`Configured Matrix room ${roomId} is not joined`);
      }
      let room: MatrixSdkRoomLike | null | undefined;
      try {
        room = this.#client.getRoom(roomId);
      } catch (error) {
        throw this.#operationError("start", error, "Matrix room validation failed");
      }
      if (room === null || room === undefined) {
        throw this.#startupInvariant(`Configured Matrix room ${roomId} is not joined`);
      }
      let membership: string | undefined;
      let encrypted: boolean;
      try {
        membership = room.getMyMembership();
        encrypted = room.hasEncryptionStateEvent();
      } catch (error) {
        throw this.#operationError("start", error, "Matrix room validation failed");
      }
      if (membership !== "join") {
        throw this.#startupInvariant(`Configured Matrix room ${roomId} is not joined`);
      }
      if (this.#client.roomState !== undefined) {
        try {
          const state = await this.#client.roomState(roomId);
          encrypted = encrypted || state.some((event) => event.type === SDK_EVENT_TYPES.roomEncryption);
        } catch (error) {
          throw this.#operationError("start", error, "Matrix room validation failed");
        }
      }
      if (this.#config.encryption === "required") {
        try {
          const crypto = this.#client.getCrypto?.();
          if (crypto === undefined) {
            throw new Error("Rust crypto is unavailable");
          }
          if (crypto?.isEncryptionEnabledInRoom !== undefined) {
            if (!await crypto.isEncryptionEnabledInRoom(roomId)) {
              throw this.#startupInvariant(`Configured Matrix room ${roomId} is not encrypted`);
            }
            encrypted = true;
          }
        } catch (error) {
          if (error instanceof MatrixAdapterError) {
            throw error;
          }
          throw this.#operationError("start", error, "Matrix room validation failed");
        }
        if (!encrypted) {
          throw this.#startupInvariant(`Configured Matrix room ${roomId} is not encrypted`);
        }
      } else if (encrypted) {
        throw this.#startupInvariant(`Configured Matrix room ${roomId} is encrypted`);
      }
      this.#validatedRooms.set(roomId, encrypted);
      rooms.push({ roomId, membership, encrypted });
    }
    return { rooms };
  }

  #startError(error: unknown, message: string): MatrixAdapterError {
    if (this.#since !== undefined && this.#isSavedCursorRejection(error)) {
      return new MatrixAdapterError(
        "start",
        "Saved Matrix sync cursor was rejected; reset private bridge state before retrying",
        classifyMatrixError(error),
        { cause: error },
      );
    }
    return this.#operationError("start", error, message);
  }

  #isSavedCursorRejection(error: unknown): boolean {
    const errcode = stringProperty(
      isRecord(error) ? own(error, "data") : undefined,
      "errcode",
    ) ?? stringProperty(error, "errcode", "errorCode");
    return errcode === "M_UNKNOWN_POS" ||
      errcode === "M_INVALID_PARAM" ||
      errcode === "M_UNKNOWN_TOKEN";
  }

  #startupInvariant(message: string): MatrixAdapterError {
    const error = new MatrixAdapterError("start", message, permanentFailure());
    this.#emitFatal({ code: "matrix_invariant", message });
    return error;
  }

  #fatalEncryptionSend(message: string, cause?: unknown): MatrixAdapterError {
    const error = new MatrixAdapterError(
      "send_message",
      message,
      permanentFailure(),
      cause === undefined ? undefined : { cause },
    );
    this.#emitFatal({ code: "matrix_invariant", message });
    return error;
  }

  #operationError(
    operation: MatrixOperation,
    error: unknown,
    message: string,
  ): MatrixAdapterError {
    if (error instanceof MatrixAdapterError) {
      return error;
    }
    return new MatrixAdapterError(
      operation,
      message,
      classifyMatrixError(error),
      { cause: error },
    );
  }

  #emitFatal(error: FatalError): void {
    if (this.#fatalEmitted) {
      return;
    }
    this.#fatalEmitted = true;
    this.#intakeStopped = true;
    this.#pendingBatchEvents.length = 0;
    for (const listener of this.#fatalListeners) {
      try {
        listener(error);
      } catch {
        // Fatal listeners are notification hooks; preserve notification to
        // the remaining listeners and the SDK lifecycle state.
      }
    }
  }

  #stopSdkClient(): void {
    if (this.#sdkStopped) {
      return;
    }
    this.#sdkStopped = true;
    try {
      this.#client.stopClient();
    } catch {
      // stopClient is best effort; shutdown must still release the adapter.
    }
  }
}

/** Verify the homeserver identity against the exact configured IDs. */
export function assertMatrixIdentity(
  identity: MatrixIdentity,
  config: MatrixConfig | BridgeConfig,
): void {
  const matrix = matrixConfigFrom(config);
  if (identity.userId !== matrix.userId) {
    throw new MatrixIdentityMismatchError(
      "Matrix whoami user ID does not match the configured user ID",
    );
  }
  if (identity.deviceId !== matrix.deviceId) {
    throw new MatrixIdentityMismatchError(
      "Matrix whoami device ID does not match the configured device ID",
    );
  }
}

export function createMatrixClientAdapter(
  config: MatrixConfig | BridgeConfig,
  accessToken: string,
  options?: MatrixClientAdapterOptions,
): MatrixClientAdapterImpl {
  return new MatrixClientAdapterImpl(config, accessToken, options);
}
