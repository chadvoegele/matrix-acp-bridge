import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import {
  validatePrivateStateDirectory,
  validatePrivateStateFileMetadata,
  ConfigurationError,
} from "./config.js";
import type { DiagnosticSink } from "./diagnostics.js";
import type { AcpSessionId } from "./acp-client.js";
import { closeQuietly, unlinkQuietly } from "./file-utils.js";
import { isMatrixId, isSafeHomeserver, isValidMatrixEventId } from "./matrix-validation.js";
import { hasExactKeys, isNodeError, isRecord } from "./object-validation.js";
import type {
  MatrixDeviceId,
  MatrixEventId,
  MatrixRoomId,
  MatrixSyncCursor,
  MatrixUserId,
} from "./matrix-client.js";

export interface MatrixCheckpointIdentity {
  readonly homeserver: string;
  readonly userId: MatrixUserId;
  readonly deviceId: MatrixDeviceId;
}

export interface MatrixSyncCheckpoint {
  readonly schemaVersion: number;
  readonly identity: MatrixCheckpointIdentity;
  readonly cursor: MatrixSyncCursor;
  /** Unix epoch milliseconds captured when the cursor was committed. */
  readonly committedAtMs: number;
}

/** Structural recovery metadata for one room in one Matrix sync batch. */
export interface MatrixRecoveryRoomLedger {
  readonly roomId: MatrixRoomId;
  readonly eventIds: readonly MatrixEventId[];
  readonly completedEventIds: readonly MatrixEventId[];
}

/** Structural recovery metadata for one ordered Matrix sync boundary. */
export interface MatrixRecoveryBatch {
  readonly fromCursor: MatrixSyncCursor;
  readonly nextBatch: MatrixSyncCursor;
  readonly rooms: readonly MatrixRecoveryRoomLedger[];
}

export interface MatrixRecoveryBatchInput {
  readonly nextBatch: MatrixSyncCursor;
  readonly rooms: readonly {
    readonly roomId: MatrixRoomId;
    readonly eventIds: readonly MatrixEventId[];
  }[];
}

export type MatrixRecoveryEventStatus = "pending" | "completed";

/** A read-only view of the private bridge-state document. */
export interface BridgeStateSnapshot {
  readonly schemaVersion: number;
  readonly identity: MatrixCheckpointIdentity;
  /** Absent until the first successful sync cursor has been committed. */
  readonly cursor?: MatrixSyncCursor;
  /** Present together with `cursor`. */
  readonly committedAtMs?: number;
  readonly sessionMappings: Readonly<Record<MatrixRoomId, AcpSessionId>>;
  /** Ordered, cursor-scoped recovery ledgers; bodies are never persisted. */
  readonly pendingBatches: readonly MatrixRecoveryBatch[];
}

/** Maximum number of event IDs retained before the processed cursor advances. */
export const MAX_PENDING_RECOVERY_EVENTS = 100_000;
/** Maximum number of in-flight cursor boundaries retained in one state file. */
export const MAX_PENDING_RECOVERY_BATCHES = 10_000;

/**
 * Atomic durable state boundary used by the sync and session layers.
 * Implementations must reject a failed mutation rather than reporting it as
 * committed; callers should treat such a failure as fatal.
 */
export interface BridgeStateStore {
  readonly statePath: string;
  getSnapshot(): BridgeStateSnapshot;
  getCheckpoint(): MatrixSyncCheckpoint | undefined;
  getSessionMapping(roomId: MatrixRoomId): AcpSessionId | undefined;
  getSessionMappings(): ReadonlyMap<MatrixRoomId, AcpSessionId>;
  /** Initial-cursor mutation; it cannot bypass pending ledgers. */
  commitCursor(cursor: MatrixSyncCursor, committedAtMs?: number): Promise<void>;
  registerSyncBatch(
    batch: MatrixRecoveryBatchInput,
  ): Promise<ReadonlyMap<MatrixEventId, MatrixRecoveryEventStatus>>;
  completeSyncEvent(eventId: MatrixEventId): Promise<boolean>;
  advanceRecoveryCursor(): Promise<boolean>;
  getPendingRecoveryBatches(): readonly MatrixRecoveryBatch[];
  setSessionMapping(roomId: MatrixRoomId, sessionId: AcpSessionId): Promise<boolean>;
  removeSessionMapping(roomId: MatrixRoomId): Promise<boolean>;
  pruneSessionMappings(allowedRooms: readonly MatrixRoomId[]): Promise<readonly MatrixRoomId[]>;
  discardSessionMappings(): Promise<boolean>;
  /** Wait for all mutations already accepted by this process to settle. */
  flush?(): Promise<void>;
}

export const BRIDGE_STATE_FILE_NAME = "bridge-state.json";
export const BRIDGE_STATE_SCHEMA_VERSION = 11;

export type BridgeStateFaultPoint =
  | "write"
  | "file-fsync"
  | "rename"
  | "directory-fsync";

/** Test-only fault boundary; injected failures are sanitized before escaping. */
export type BridgeStateFaultInjector = (
  point: BridgeStateFaultPoint,
) => void | Promise<void>;

export type BridgeStateFailureCategory =
  | "unsafe-path"
  | "permissions"
  | "read"
  | "corrupt"
  | "unsupported-version"
  | "identity-mismatch"
  | "invalid-input"
  | "bound-exceeded"
  | "missing-checkpoint"
  | "write"
  | "file-fsync"
  | "rename"
  | "directory-fsync";

/**
 * A sanitized fatal state failure. The message contains only a stable
 * category and the state-file location; it never contains state contents or
 * a raw parser/filesystem error.
 */
export class BridgeStateError extends Error {
  readonly code = "state" as const;
  readonly fatal = true as const;
  readonly category: BridgeStateFailureCategory;
  readonly statePath: string;

  constructor(category: BridgeStateFailureCategory, statePath: string) {
    super(`Private bridge state failure (${category}) at ${statePath}`);
    this.name = "BridgeStateError";
    this.category = category;
    this.statePath = statePath;
  }
}

export interface BridgeStateStoreOptions {
  readonly stateDir: string;
  readonly identity: MatrixCheckpointIdentity;
  /** Defaults to Date.now; only the wall-clock commit timestamp is persisted. */
  readonly now?: () => number;
  readonly diagnostics?: DiagnosticSink;
  readonly faultInjector?: BridgeStateFaultInjector;
}

interface InternalState {
  readonly cursor: MatrixSyncCursor | undefined;
  readonly committedAtMs: number | undefined;
  readonly sessions: Map<MatrixRoomId, AcpSessionId>;
  readonly pendingBatches: RecoveryBatchMutable[];
}

interface RecoveryRoomMutable {
  readonly roomId: MatrixRoomId;
  readonly eventIds: MatrixEventId[];
  completedEventIds: MatrixEventId[];
}

interface RecoveryBatchMutable {
  readonly fromCursor: MatrixSyncCursor;
  readonly nextBatch: MatrixSyncCursor;
  readonly rooms: RecoveryRoomMutable[];
}

interface ParsedState {
  readonly identity: MatrixCheckpointIdentity;
  readonly cursor: MatrixSyncCursor | undefined;
  readonly committedAtMs: number | undefined;
  readonly sessions: ReadonlyMap<MatrixRoomId, AcpSessionId>;
  readonly pendingBatches: readonly RecoveryBatchMutable[];
}

interface RecoveryEventLocation {
  readonly batchIndex: number;
  readonly roomIndex: number;
}

const NOFOLLOW = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
const DIRECTORY_FLAG = "O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0;
const STATE_FILE_FLAGS = constants.O_RDONLY | NOFOLLOW;
const TEMP_FILE_FLAGS = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW;

/** Open and validate the one private bridge-state document for a process. */
export async function openBridgeStateStore(
  options: BridgeStateStoreOptions,
): Promise<PrivateBridgeStateStore> {
  const requestedPath = join(options.stateDir, BRIDGE_STATE_FILE_NAME);
  let stateDir: string;
  try {
    stateDir = await validatePrivateStateDirectory(options.stateDir);
  } catch (error) {
    if (error instanceof BridgeStateError) {
      emitStateFailure(options.diagnostics, error);
      throw error;
    }
    const failure = new BridgeStateError(
      error instanceof ConfigurationError ? "unsafe-path" : "read",
      requestedPath,
    );
    emitStateFailure(options.diagnostics, failure);
    throw failure;
  }

  return await PrivateBridgeStateStore.openValidated({ ...options, stateDir });
}

export class PrivateBridgeStateStore implements BridgeStateStore {
  readonly statePath: string;

  readonly #stateDir: string;
  readonly #identity: MatrixCheckpointIdentity;
  readonly #now: () => number;
  readonly #diagnostics: DiagnosticSink | undefined;
  readonly #faultInjector: BridgeStateFaultInjector | undefined;
  #state: InternalState | undefined;
  #tail: Promise<void> = Promise.resolve();

  private constructor(
    stateDir: string,
    identity: MatrixCheckpointIdentity,
    now: () => number,
    diagnostics: DiagnosticSink | undefined,
    faultInjector: BridgeStateFaultInjector | undefined,
  ) {
    this.#stateDir = stateDir;
    this.statePath = join(stateDir, BRIDGE_STATE_FILE_NAME);
    this.#identity = {
      homeserver: identity.homeserver,
      userId: identity.userId,
      deviceId: identity.deviceId,
    };
    this.#now = now;
    this.#diagnostics = diagnostics;
    this.#faultInjector = faultInjector;
  }

  static async open(options: BridgeStateStoreOptions): Promise<PrivateBridgeStateStore> {
    return openBridgeStateStore(options);
  }

  static async openValidated(options: BridgeStateStoreOptions & { readonly stateDir: string }): Promise<PrivateBridgeStateStore> {
    const store = new PrivateBridgeStateStore(
      options.stateDir,
      options.identity,
      options.now ?? Date.now,
      options.diagnostics,
      options.faultInjector,
    );
    try {
      store.#validateIdentity(options.identity);
      await store.#discardCrashLeftTemporaryFiles();
      await store.#load();
    } catch (error) {
      if (error instanceof BridgeStateError) {
        store.#emitFailure(error);
      }
      throw error;
    }
    return store;
  }

  getSnapshot(): BridgeStateSnapshot {
    const state = this.#state;
    const checkpoint = state?.cursor !== undefined && state.committedAtMs !== undefined
      ? { cursor: state.cursor, committedAtMs: state.committedAtMs }
      : {};
    const sessions = Object.fromEntries(
      [...(state?.sessions.entries() ?? [])].sort(([left], [right]) => left.localeCompare(right)),
    ) as Record<MatrixRoomId, AcpSessionId>;
    return {
      schemaVersion: BRIDGE_STATE_SCHEMA_VERSION,
      identity: { ...this.#identity },
      ...checkpoint,
      sessionMappings: sessions,
      pendingBatches: state === undefined ? [] : state.pendingBatches.map((batch) => cloneBatch(batch)),
    };
  }

  getCheckpoint(): MatrixSyncCheckpoint | undefined {
    const state = this.#state;
    if (state?.cursor === undefined || state.committedAtMs === undefined) {
      return undefined;
    }
    return {
      schemaVersion: BRIDGE_STATE_SCHEMA_VERSION,
      identity: { ...this.#identity },
      cursor: state.cursor,
      committedAtMs: state.committedAtMs,
    };
  }

  getPendingRecoveryBatches(): readonly MatrixRecoveryBatch[] {
    return (this.#state?.pendingBatches ?? []).map((batch) => cloneBatch(batch));
  }

  getSessionMapping(roomId: MatrixRoomId): AcpSessionId | undefined {
    return this.#state?.sessions.get(roomId);
  }

  getSessionMappings(): ReadonlyMap<MatrixRoomId, AcpSessionId> {
    return new Map(this.#state?.sessions ?? []);
  }

  /**
   * Retained for first-run initialization and old embedders. It is deliberately
   * unable to move a cursor past an uncompleted recovery ledger.
   */
  async commitCursor(cursor: MatrixSyncCursor, committedAtMs = this.#now()): Promise<void> {
    return this.#enqueue(async () => {
      this.#validateCursor(cursor);
      this.#validateCommitTime(committedAtMs);
      const previous = this.#state;
      if (previous !== undefined && previous.pendingBatches.length > 0) {
        throw this.#failure("invalid-input");
      }
      if (
        previous !== undefined &&
        previous.cursor === cursor &&
        previous.committedAtMs === committedAtMs
      ) {
        return;
      }
      const next: InternalState = {
        cursor,
        committedAtMs,
        sessions: new Map(previous?.sessions ?? []),
        pendingBatches: [],
      };
      await this.#persist(next);
      this.#state = next;
    });
  }

  async registerSyncBatch(
    input: MatrixRecoveryBatchInput,
  ): Promise<ReadonlyMap<MatrixEventId, MatrixRecoveryEventStatus>> {
    return this.#enqueue(async () => {
      const current = this.#requireCheckpoint();
      const normalized = this.#validateBatchInput(input);
      const locations = recoveryLocations(current.pendingBatches);
      const statuses = new Map<MatrixEventId, MatrixRecoveryEventStatus>();
      const newByRoom = new Map<MatrixRoomId, MatrixEventId[]>();
      const seenInput = new Set<MatrixEventId>();

      for (const room of normalized.rooms) {
        const newIds: MatrixEventId[] = [];
        for (const eventId of room.eventIds) {
          if (seenInput.has(eventId)) {
            throw this.#failure("invalid-input");
          }
          seenInput.add(eventId);
          const location = locations.get(eventId);
          if (location === undefined) {
            newIds.push(eventId);
            statuses.set(eventId, "pending");
            continue;
          }
          const existing = current.pendingBatches[location.batchIndex];
          const existingRoom = existing?.rooms[location.roomIndex];
          if (existingRoom?.roomId !== room.roomId) {
            throw this.#failure("corrupt");
          }
          statuses.set(
            eventId,
            existingRoom.completedEventIds.includes(eventId) ? "completed" : "pending",
          );
        }
        if (newIds.length > 0) {
          newByRoom.set(room.roomId, newIds);
        }
      }

      const newCount = [...newByRoom.values()].reduce((total, ids) => total + ids.length, 0);
      const existingCount = countRecoveryEvents(current.pendingBatches);
      if (existingCount + newCount > MAX_PENDING_RECOVERY_EVENTS) {
        throw this.#failure("bound-exceeded");
      }

      const batches = cloneMutableBatches(current.pendingBatches);
      const matchingBatch = batches.find((batch) => batch.nextBatch === normalized.nextBatch);
      if (newCount > 0) {
        if (matchingBatch === undefined) {
          if (batches.length >= MAX_PENDING_RECOVERY_BATCHES) {
            throw this.#failure("bound-exceeded");
          }
          const fromCursor = batches.at(-1)?.nextBatch ?? current.cursor;
          batches.push({
            fromCursor,
            nextBatch: normalized.nextBatch,
            rooms: normalized.rooms
              .filter((room) => newByRoom.has(room.roomId))
              .map((room) => ({
                roomId: room.roomId,
                eventIds: [...(newByRoom.get(room.roomId) ?? [])],
                completedEventIds: [],
              })),
          });
        } else {
          for (const [roomId, eventIds] of newByRoom) {
            const room = matchingBatch.rooms.find((candidate) => candidate.roomId === roomId);
            if (room === undefined) {
              matchingBatch.rooms.push({ roomId, eventIds: [...eventIds], completedEventIds: [] });
            } else {
              room.eventIds.push(...eventIds);
            }
          }
        }
      } else if (
        matchingBatch === undefined && (
          normalized.rooms.length === 0 ||
          normalized.nextBatch !== (batches.at(-1)?.nextBatch ?? current.cursor)
        )
      ) {
        if (batches.length >= MAX_PENDING_RECOVERY_BATCHES) {
          throw this.#failure("bound-exceeded");
        }
        batches.push({
          fromCursor: batches.at(-1)?.nextBatch ?? current.cursor,
          nextBatch: normalized.nextBatch,
          rooms: [],
        });
      }

      const advanced = advanceMutableState({
        cursor: current.cursor,
        committedAtMs: current.committedAtMs,
        sessions: new Map(current.sessions),
        pendingBatches: batches,
      }, this.#now());
      const next = advanced.state;
      const changed = newCount > 0 || batches.length !== current.pendingBatches.length || advanced.changed;
      if (changed) {
        await this.#persist(next);
        this.#state = next;
      }
      return statuses;
    });
  }

  async completeSyncEvent(eventId: MatrixEventId): Promise<boolean> {
    return this.#enqueue(async () => {
      if (!isValidMatrixEventId(eventId)) {
        throw this.#failure("invalid-input");
      }
      const current = this.#state;
      if (current === undefined) {
        throw this.#failure("missing-checkpoint");
      }
      const location = recoveryLocations(current.pendingBatches).get(eventId);
      if (location === undefined) {
        return false;
      }
      const batches = cloneMutableBatches(current.pendingBatches);
      const room = batches[location.batchIndex]?.rooms[location.roomIndex];
      if (room === undefined) {
        throw this.#failure("corrupt");
      }
      if (room.completedEventIds.includes(eventId)) {
        return false;
      }
      if (room.eventIds[room.completedEventIds.length] !== eventId) {
        throw this.#failure("invalid-input");
      }
      room.completedEventIds.push(eventId);
      const advanced = advanceMutableState({
        cursor: current.cursor,
        committedAtMs: current.committedAtMs,
        sessions: new Map(current.sessions),
        pendingBatches: batches,
      }, this.#now());
      await this.#persist(advanced.state);
      this.#state = advanced.state;
      return true;
    });
  }

  async advanceRecoveryCursor(): Promise<boolean> {
    return this.#enqueue(async () => {
      const current = this.#state;
      if (current === undefined) {
        return false;
      }
      const advanced = advanceMutableState(current, this.#now());
      if (!advanced.changed) {
        return false;
      }
      await this.#persist(advanced.state);
      this.#state = advanced.state;
      return true;
    });
  }

  async setSessionMapping(roomId: MatrixRoomId, sessionId: AcpSessionId): Promise<boolean> {
    return this.#enqueue(async () => {
      this.#validateRoomId(roomId);
      this.#validateSessionId(sessionId);
      const current = this.#requireCheckpoint();
      if (current.sessions.get(roomId) === sessionId) {
        return false;
      }
      const next: InternalState = {
        cursor: current.cursor,
        committedAtMs: current.committedAtMs,
        sessions: new Map(current.sessions).set(roomId, sessionId),
        pendingBatches: cloneMutableBatches(current.pendingBatches),
      };
      await this.#persist(next);
      this.#state = next;
      return true;
    });
  }

  async removeSessionMapping(roomId: MatrixRoomId): Promise<boolean> {
    return this.#enqueue(async () => {
      this.#validateRoomId(roomId);
      const current = this.#state;
      if (current === undefined || !current.sessions.has(roomId)) {
        return false;
      }
      const sessions = new Map(current.sessions);
      sessions.delete(roomId);
      const next: InternalState = {
        cursor: current.cursor,
        committedAtMs: current.committedAtMs,
        sessions,
        pendingBatches: cloneMutableBatches(current.pendingBatches),
      };
      await this.#persist(next);
      this.#state = next;
      return true;
    });
  }

  async pruneSessionMappings(allowedRooms: readonly MatrixRoomId[]): Promise<readonly MatrixRoomId[]> {
    return this.#enqueue(async () => {
      if (!Array.isArray(allowedRooms)) {
        throw this.#failure("invalid-input");
      }
      const allowed = new Set<MatrixRoomId>();
      for (const roomId of allowedRooms) {
        this.#validateRoomId(roomId);
        allowed.add(roomId);
      }
      const current = this.#state;
      if (current === undefined) {
        return [];
      }
      const removed = [...current.sessions.keys()]
        .filter((roomId) => !allowed.has(roomId))
        .sort((left, right) => left.localeCompare(right));
      if (removed.length === 0) {
        return [];
      }
      const sessions = new Map(current.sessions);
      for (const roomId of removed) {
        sessions.delete(roomId);
      }
      const next: InternalState = {
        cursor: current.cursor,
        committedAtMs: current.committedAtMs,
        sessions,
        pendingBatches: cloneMutableBatches(current.pendingBatches),
      };
      await this.#persist(next);
      this.#state = next;
      return removed;
    });
  }

  async discardSessionMappings(): Promise<boolean> {
    return this.#enqueue(async () => {
      const current = this.#state;
      if (current === undefined || current.sessions.size === 0) {
        return false;
      }
      const next: InternalState = {
        cursor: current.cursor,
        committedAtMs: current.committedAtMs,
        sessions: new Map(),
        pendingBatches: cloneMutableBatches(current.pendingBatches),
      };
      await this.#persist(next);
      this.#state = next;
      return true;
    });
  }

  /**
   * Wait for the serialized mutation tail. A mutation updates the in-memory
   * view only after its temporary file, descriptor, replacement, and state
   * directory fsyncs have completed.
   */
  async flush(): Promise<void> {
    await this.#tail;
  }

  async #load(): Promise<void> {
    let exists: boolean;
    try {
      const stat = await fs.lstat(this.statePath);
      exists = true;
      this.#validateStatePathStat(stat);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        exists = false;
      } else if (error instanceof BridgeStateError) {
        throw error;
      } else {
        throw this.#failure("read");
      }
    }
    if (!exists) {
      this.#emit("debug", "private-state-absent");
      return;
    }

    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(this.statePath, STATE_FILE_FLAGS);
      const stat = await handle.stat();
      this.#validateStatePathStat(stat);
      const bytes = await handle.readFile();
      let source: string;
      try {
        source = new TextDecoder("utf8", { fatal: true }).decode(bytes);
      } catch {
        throw this.#failure("corrupt");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(source) as unknown;
      } catch {
        throw this.#failure("corrupt");
      }
      const state = this.#parseState(parsed);
      this.#state = {
        cursor: state.cursor,
        committedAtMs: state.committedAtMs,
        sessions: new Map(state.sessions),
        pendingBatches: cloneMutableBatches(state.pendingBatches),
      };
      this.#emit("debug", "private-state-loaded", {
        mappingCount: state.sessions.size,
        pendingBatchCount: state.pendingBatches.length,
      });
    } catch (error) {
      if (error instanceof BridgeStateError) {
        throw error;
      }
      throw this.#failure("read");
    } finally {
      await closeQuietly(handle);
    }
  }

  async #persist(state: InternalState): Promise<void> {
    const document = this.#serializeState(state);
    const temporaryPath = join(
      this.#stateDir,
      `.${BRIDGE_STATE_FILE_NAME}.${randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    let renamed = false;
    let stage: BridgeStateFailureCategory = "write";
    try {
      await this.#assertTargetSafeForRename();
      await this.#inject("write");
      handle = await fs.open(temporaryPath, TEMP_FILE_FLAGS, 0o600);
      await handle.chmod(0o600);
      this.#validateStatePathStat(await handle.stat());
      await handle.writeFile(document, "utf8");
      stage = "file-fsync";
      await this.#inject("file-fsync");
      await handle.sync();
      await closeQuietly(handle);
      handle = undefined;
      stage = "rename";
      await this.#inject("rename");
      await fs.rename(temporaryPath, this.statePath);
      renamed = true;
      stage = "directory-fsync";
      await this.#inject("directory-fsync");
      await this.#syncDirectory();
    } catch (error) {
      if (error instanceof BridgeStateError) {
        this.#emitFailure(error);
        throw error;
      }
      const failure = this.#failure(stage);
      this.#emitFailure(failure);
      throw failure;
    } finally {
      await closeQuietly(handle);
      if (!renamed) {
        await unlinkQuietly(temporaryPath);
      }
    }
  }

  async #syncDirectory(): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(this.#stateDir, constants.O_RDONLY | DIRECTORY_FLAG);
      await handle.sync();
    } finally {
      await closeQuietly(handle);
    }
  }

  async #assertTargetSafeForRename(): Promise<void> {
    try {
      const stat = await fs.lstat(this.statePath);
      this.#validateStatePathStat(stat);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return;
      }
      if (error instanceof BridgeStateError) {
        throw error;
      }
      throw this.#failure("unsafe-path");
    }
  }

  async #discardCrashLeftTemporaryFiles(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.#stateDir);
    } catch {
      return;
    }
    const prefix = `.${BRIDGE_STATE_FILE_NAME}.`;
    for (const name of names) {
      if (name.startsWith(prefix) && name.endsWith(".tmp")) {
        await unlinkQuietly(join(this.#stateDir, name));
      }
    }
  }

  #parseState(value: unknown): ParsedState {
    if (!isRecord(value)) {
      throw this.#failure("corrupt");
    }
    if (value.schemaVersion !== BRIDGE_STATE_SCHEMA_VERSION) {
      throw this.#failure("unsupported-version");
    }
    if (!hasExactKeys(value, ["schemaVersion", "identity", "cursor", "committedAtMs", "sessions", "pendingBatches"])) {
      throw this.#failure("corrupt");
    }
    const identity = this.#parseIdentity(value.identity);
    this.#assertIdentity(identity);
    const cursor = value.cursor === null ? undefined : this.#parseCursor(value.cursor);
    const committedAtMs = value.committedAtMs === null ? undefined : this.#parseCommitTime(value.committedAtMs);
    if ((cursor === undefined) !== (committedAtMs === undefined)) {
      throw this.#failure("corrupt");
    }
    const sessions = this.#parseSessions(value.sessions);
    const pendingBatches = this.#parsePendingBatches(value.pendingBatches, cursor);
    return {
      identity,
      cursor,
      committedAtMs,
      sessions,
      pendingBatches,
    };
  }

  #parseIdentity(value: unknown): MatrixCheckpointIdentity {
    if (!isRecord(value) || !hasExactKeys(value, ["homeserver", "userId", "deviceId"])) {
      throw this.#failure("corrupt");
    }
    if (typeof value.homeserver !== "string" || typeof value.userId !== "string" || typeof value.deviceId !== "string") {
      throw this.#failure("corrupt");
    }
    const identity = { homeserver: value.homeserver, userId: value.userId, deviceId: value.deviceId };
    this.#validateIdentity(identity);
    return identity;
  }

  #parseSessions(value: unknown): Map<MatrixRoomId, AcpSessionId> {
    if (!isRecord(value)) {
      throw this.#failure("corrupt");
    }
    const sessions = new Map<MatrixRoomId, AcpSessionId>();
    for (const [roomId, sessionId] of Object.entries(value)) {
      this.#validateRoomIdForParse(roomId);
      this.#validateSessionIdForParse(sessionId);
      sessions.set(roomId, sessionId);
    }
    return sessions;
  }

  #parsePendingBatches(
    value: unknown,
    cursor: MatrixSyncCursor | undefined,
  ): RecoveryBatchMutable[] {
    if (!Array.isArray(value) || value.length > MAX_PENDING_RECOVERY_BATCHES) {
      throw this.#failure(Array.isArray(value) ? "bound-exceeded" : "corrupt");
    }
    if (value.length > 0 && cursor === undefined) {
      throw this.#failure("corrupt");
    }
    const batches: RecoveryBatchMutable[] = [];
    const eventIds = new Set<MatrixEventId>();
    let expectedFrom = cursor;
    let totalEvents = 0;
    for (const rawBatch of value) {
      if (!isRecord(rawBatch) || !hasExactKeys(rawBatch, ["fromCursor", "nextBatch", "rooms"])) {
        throw this.#failure("corrupt");
      }
      const fromCursor = this.#parseCursor(rawBatch.fromCursor);
      const nextBatch = this.#parseCursor(rawBatch.nextBatch);
      if (expectedFrom !== fromCursor) {
        throw this.#failure("corrupt");
      }
      if (!Array.isArray(rawBatch.rooms)) {
        throw this.#failure("corrupt");
      }
      const rooms: RecoveryRoomMutable[] = [];
      const roomIds = new Set<MatrixRoomId>();
      for (const rawRoom of rawBatch.rooms) {
        if (!isRecord(rawRoom) || !hasExactKeys(rawRoom, ["roomId", "eventIds", "completedEventIds"])) {
          throw this.#failure("corrupt");
        }
        const roomId = rawRoom.roomId;
        this.#validateRoomIdForParse(roomId);
        if (roomIds.has(roomId) || !Array.isArray(rawRoom.eventIds)) {
          throw this.#failure("corrupt");
        }
        roomIds.add(roomId);
        const roomEventIds: MatrixEventId[] = [];
        const roomEventIdSet = new Set<MatrixEventId>();
        for (const eventId of rawRoom.eventIds) {
          this.#validateEventIdForParse(eventId);
          if (roomEventIdSet.has(eventId) || eventIds.has(eventId)) {
            throw this.#failure("corrupt");
          }
          roomEventIdSet.add(eventId);
          eventIds.add(eventId);
          roomEventIds.push(eventId);
        }
        totalEvents += roomEventIds.length;
        if (totalEvents > MAX_PENDING_RECOVERY_EVENTS) {
          throw this.#failure("bound-exceeded");
        }
        const completedEventIds: MatrixEventId[] = [];
        if (!Array.isArray(rawRoom.completedEventIds)) {
          throw this.#failure("corrupt");
        }
        const completedSet = new Set<MatrixEventId>();
        for (const eventId of rawRoom.completedEventIds) {
          this.#validateEventIdForParse(eventId);
          if (completedSet.has(eventId) || !roomEventIdSet.has(eventId)) {
            throw this.#failure("corrupt");
          }
          completedSet.add(eventId);
          completedEventIds.push(eventId);
        }
        if (!completedEventIds.every((eventId, index) => roomEventIds[index] === eventId)) {
          throw this.#failure("corrupt");
        }
        rooms.push({ roomId, eventIds: roomEventIds, completedEventIds });
      }
      batches.push({ fromCursor, nextBatch, rooms });
      expectedFrom = nextBatch;
    }
    return batches;
  }

  #validateBatchInput(input: MatrixRecoveryBatchInput): MatrixRecoveryBatchInput {
    if (!isRecord(input)) {
      throw this.#failure("invalid-input");
    }
    this.#validateCursor(input.nextBatch);
    if (!Array.isArray(input.rooms)) {
      throw this.#failure("invalid-input");
    }
    const rooms: { roomId: MatrixRoomId; eventIds: MatrixEventId[] }[] = [];
    const roomIds = new Set<MatrixRoomId>();
    for (const room of input.rooms) {
      if (!isRecord(room) || typeof room.roomId !== "string" || !Array.isArray(room.eventIds)) {
        throw this.#failure("invalid-input");
      }
      this.#validateRoomId(room.roomId);
      if (roomIds.has(room.roomId)) {
        throw this.#failure("invalid-input");
      }
      roomIds.add(room.roomId);
      const eventIds: MatrixEventId[] = [];
      for (const eventId of room.eventIds) {
        this.#validateEventId(eventId);
        eventIds.push(eventId);
      }
      rooms.push({ roomId: room.roomId, eventIds });
    }
    return { nextBatch: input.nextBatch, rooms };
  }

  #assertIdentity(identity: MatrixCheckpointIdentity): void {
    if (!identitiesEqual(identity, this.#identity)) {
      throw this.#failure("identity-mismatch");
    }
  }

  #validateIdentity(identity: MatrixCheckpointIdentity): void {
    if (!isRecord(identity) || typeof identity.homeserver !== "string" || !isSafeHomeserver(identity.homeserver)) {
      throw this.#failure("invalid-input");
    }
    if (typeof identity.userId !== "string" || !isMatrixId(identity.userId, "@")) {
      throw this.#failure("invalid-input");
    }
    if (typeof identity.deviceId !== "string" || !/^[A-Za-z0-9._=-]+$/u.test(identity.deviceId)) {
      throw this.#failure("invalid-input");
    }
  }

  #validateCursor(cursor: unknown): asserts cursor is MatrixSyncCursor {
    if (typeof cursor !== "string" || cursor.length === 0) {
      throw this.#failure("invalid-input");
    }
  }

  #parseCursor(cursor: unknown): MatrixSyncCursor {
    try {
      this.#validateCursor(cursor);
      return cursor;
    } catch (error) {
      if (error instanceof BridgeStateError) {
        throw this.#failure("corrupt");
      }
      throw error;
    }
  }

  #validateCommitTime(committedAtMs: unknown): asserts committedAtMs is number {
    if (typeof committedAtMs !== "number" || !Number.isSafeInteger(committedAtMs) || committedAtMs < 0) {
      throw this.#failure("invalid-input");
    }
  }

  #parseCommitTime(committedAtMs: unknown): number {
    try {
      this.#validateCommitTime(committedAtMs);
      return committedAtMs;
    } catch (error) {
      if (error instanceof BridgeStateError) {
        throw this.#failure("corrupt");
      }
      throw error;
    }
  }

  #validateRoomId(roomId: unknown): asserts roomId is MatrixRoomId {
    if (typeof roomId !== "string" || !isMatrixId(roomId, "!")) {
      throw this.#failure("invalid-input");
    }
  }

  #validateRoomIdForParse(roomId: unknown): asserts roomId is MatrixRoomId {
    try {
      this.#validateRoomId(roomId);
    } catch (error) {
      if (error instanceof BridgeStateError) {
        throw this.#failure("corrupt");
      }
      throw error;
    }
  }

  #validateEventId(eventId: unknown): asserts eventId is MatrixEventId {
    if (!isValidMatrixEventId(eventId)) {
      throw this.#failure("invalid-input");
    }
  }

  #validateEventIdForParse(eventId: unknown): asserts eventId is MatrixEventId {
    try {
      this.#validateEventId(eventId);
    } catch (error) {
      if (error instanceof BridgeStateError) {
        throw this.#failure("corrupt");
      }
      throw error;
    }
  }

  #validateSessionId(sessionId: unknown): asserts sessionId is AcpSessionId {
    // Control characters are forbidden in persisted identifiers.
    // eslint-disable-next-line no-control-regex -- reject ASCII control characters
    if (typeof sessionId !== "string" || sessionId.length === 0 || /[\u0000-\u001F\u007F]/u.test(sessionId)) {
      throw this.#failure("invalid-input");
    }
  }

  #validateSessionIdForParse(sessionId: unknown): asserts sessionId is AcpSessionId {
    try {
      this.#validateSessionId(sessionId);
    } catch (error) {
      if (error instanceof BridgeStateError) {
        throw this.#failure("corrupt");
      }
      throw error;
    }
  }

  #validateStatePathStat(stat: Stats): void {
    try {
      validatePrivateStateFileMetadata(stat);
    } catch (error) {
      if (error instanceof ConfigurationError) {
        const category = error.message.includes("regular files") ? "unsafe-path" : "permissions";
        throw this.#failure(category);
      }
      throw this.#failure("read");
    }
  }

  #requireCheckpoint(): InternalState & { readonly cursor: MatrixSyncCursor; readonly committedAtMs: number } {
    if (this.#state?.cursor === undefined || this.#state.committedAtMs === undefined) {
      throw this.#failure("missing-checkpoint");
    }
    return this.#state as InternalState & { readonly cursor: MatrixSyncCursor; readonly committedAtMs: number };
  }

  #serializeState(state: InternalState): string {
    const sessions = Object.fromEntries(
      [...state.sessions.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );
    const pendingBatches = state.pendingBatches.map((batch) => ({
      fromCursor: batch.fromCursor,
      nextBatch: batch.nextBatch,
      rooms: batch.rooms.map((room) => ({
        roomId: room.roomId,
        eventIds: [...room.eventIds],
        completedEventIds: [...room.completedEventIds],
      })),
    }));
    return `${JSON.stringify({
      schemaVersion: BRIDGE_STATE_SCHEMA_VERSION,
      identity: this.#identity,
      cursor: state.cursor ?? null,
      committedAtMs: state.committedAtMs ?? null,
      sessions,
      pendingBatches,
    })}\n`;
  }

  async #inject(point: BridgeStateFaultPoint): Promise<void> {
    await this.#faultInjector?.(point);
  }

  #failure(category: BridgeStateFailureCategory): BridgeStateError {
    return new BridgeStateError(category, this.statePath);
  }

  #emit(level: "debug" | "error", event: string, fields: Record<string, string | number | boolean> = {}): void {
    try {
      this.#diagnostics?.emit(level, event, { path: this.statePath, ...fields });
    } catch {
      // Diagnostics must never change state semantics.
    }
  }

  #emitFailure(error: BridgeStateError): void {
    this.#emit("error", "private-state-failure", { category: error.category });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation, operation);
    this.#tail = run.then(() => {}, () => {});
    return run;
  }
}

function cloneMutableBatches(batches: readonly RecoveryBatchMutable[]): RecoveryBatchMutable[] {
  return batches.map((batch) => ({
    fromCursor: batch.fromCursor,
    nextBatch: batch.nextBatch,
    rooms: batch.rooms.map((room) => ({
      roomId: room.roomId,
      eventIds: [...room.eventIds],
      completedEventIds: [...room.completedEventIds],
    })),
  }));
}

function cloneBatch(batch: RecoveryBatchMutable): MatrixRecoveryBatch {
  return {
    fromCursor: batch.fromCursor,
    nextBatch: batch.nextBatch,
    rooms: batch.rooms.map((room) => ({
      roomId: room.roomId,
      eventIds: [...room.eventIds],
      completedEventIds: [...room.completedEventIds],
    })),
  };
}

function countRecoveryEvents(batches: readonly RecoveryBatchMutable[]): number {
  return batches.reduce(
    (total, batch) => total + batch.rooms.reduce((roomTotal, room) => roomTotal + room.eventIds.length, 0),
    0,
  );
}

function recoveryLocations(
  batches: readonly RecoveryBatchMutable[],
): Map<MatrixEventId, RecoveryEventLocation> {
  const locations = new Map<MatrixEventId, RecoveryEventLocation>();
  for (const [batchIndex, batch] of batches.entries()) {
    for (const [roomIndex, room] of batch.rooms.entries()) {
      for (const eventId of room.eventIds) {
        locations.set(eventId, { batchIndex, roomIndex });
      }
    }
  }
  return locations;
}

function advanceMutableState(
  current: InternalState,
  committedAtMs: number,
): { readonly state: InternalState; readonly changed: boolean } {
  if (current.cursor === undefined || current.committedAtMs === undefined) {
    return { state: current, changed: false };
  }
  const pendingBatches = cloneMutableBatches(current.pendingBatches);
  let cursor = current.cursor;
  let changed = false;
  while (pendingBatches.length > 0) {
    const first = pendingBatches[0]!;
    const complete = first.rooms.every((room) => arraysEqual(room.completedEventIds, room.eventIds));
    if (!complete) {
      break;
    }
    cursor = first.nextBatch;
    pendingBatches.shift();
    changed = true;
  }
  if (!changed) {
    return { state: current, changed: false };
  }
  return {
    state: {
      cursor,
      committedAtMs,
      sessions: new Map(current.sessions),
      pendingBatches,
    },
    changed: true,
  };
}

function arraysEqual(left: readonly MatrixEventId[], right: readonly MatrixEventId[]): boolean {
  return left.length === right.length && left.every((eventId, index) => eventId === right[index]);
}

function identitiesEqual(left: MatrixCheckpointIdentity, right: MatrixCheckpointIdentity): boolean {
  return left.homeserver === right.homeserver && left.userId === right.userId && left.deviceId === right.deviceId;
}

function emitStateFailure(diagnostics: DiagnosticSink | undefined, error: BridgeStateError): void {
  try {
    diagnostics?.emit("error", "private-state-failure", {
      path: error.statePath,
      category: error.category,
    });
  } catch {
    // Diagnostics must never change state semantics.
  }
}
