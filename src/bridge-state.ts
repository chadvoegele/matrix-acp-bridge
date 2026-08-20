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
  MatrixUserId,
} from "./matrix-client.js";

export interface MatrixBridgeIdentity {
  readonly homeserver: string;
  readonly userId: MatrixUserId;
  readonly deviceId: MatrixDeviceId;
}

/** Event IDs grouped by the Matrix room that owns them. */
export interface CompletedEventRoomInput {
  readonly roomId: MatrixRoomId;
  readonly eventIds: readonly MatrixEventId[];
}

export interface CompletedEventRoomsInput {
  readonly rooms: readonly CompletedEventRoomInput[];
}

export type CompletedEventLedgerInput =
  | readonly CompletedEventRoomInput[]
  | CompletedEventRoomsInput
  | ReadonlyMap<MatrixRoomId, readonly MatrixEventId[]>
  | Readonly<Record<MatrixRoomId, readonly MatrixEventId[]>>;

export interface CompletedEventCompactionInput {
  readonly currentTimeline: CompletedEventLedgerInput;
  readonly newlyCompletedEventIds?: CompletedEventLedgerInput;
}

/** A read-only view of the private bridge-state document. */
export interface BridgeStateSnapshot {
  readonly schemaVersion: number;
  readonly identity: MatrixBridgeIdentity;
  readonly initialized: boolean;
  readonly sessionMappings: Readonly<Record<MatrixRoomId, AcpSessionId>>;
  readonly completedEventIds: Readonly<Record<MatrixRoomId, readonly MatrixEventId[]>>;
}

/**
 * Atomic durable state boundary used by the sync and session layers.
 * Implementations reject a failed mutation rather than reporting it as
 * committed; callers should treat such a failure as fatal.
 */
export interface BridgeStateStore {
  readonly statePath: string;
  getSnapshot(): BridgeStateSnapshot;
  isEventCompleted(eventId: MatrixEventId): boolean;
  isEventCompleted(roomId: MatrixRoomId, eventId: MatrixEventId): boolean;
  establishInitialBaseline(completedEventIds: CompletedEventLedgerInput): Promise<void>;
  markEventCompleted(roomId: MatrixRoomId, eventId: MatrixEventId): Promise<boolean>;
  compactCompletedEventIds(
    currentTimeline: CompletedEventLedgerInput | CompletedEventCompactionInput,
    newlyCompletedEventIds?: CompletedEventLedgerInput,
  ): Promise<void>;
  getSessionMapping(roomId: MatrixRoomId): AcpSessionId | undefined;
  getSessionMappings(): ReadonlyMap<MatrixRoomId, AcpSessionId>;
  setSessionMapping(roomId: MatrixRoomId, sessionId: AcpSessionId): Promise<boolean>;
  removeSessionMapping(roomId: MatrixRoomId): Promise<boolean>;
  pruneSessionMappings(allowedRooms: readonly MatrixRoomId[]): Promise<readonly MatrixRoomId[]>;
  discardSessionMappings(): Promise<boolean>;
  /** Wait for all mutations already accepted by this process to settle. */
  flush?(): Promise<void>;
}

export const BRIDGE_STATE_FILE_NAME = "bridge-state.json";
export const BRIDGE_STATE_SCHEMA_VERSION = 12;

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
  readonly identity: MatrixBridgeIdentity;
  readonly diagnostics?: DiagnosticSink;
  readonly faultInjector?: BridgeStateFaultInjector;
}

interface InternalState {
  readonly initialized: boolean;
  readonly sessions: Map<MatrixRoomId, AcpSessionId>;
  readonly completedEventIds: Map<MatrixRoomId, MatrixEventId[]>;
}

interface ParsedState {
  readonly identity: MatrixBridgeIdentity;
  readonly initialized: boolean;
  readonly sessions: ReadonlyMap<MatrixRoomId, AcpSessionId>;
  readonly completedEventIds: ReadonlyMap<MatrixRoomId, readonly MatrixEventId[]>;
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

  return PrivateBridgeStateStore.openValidated({ ...options, stateDir });
}

export class PrivateBridgeStateStore implements BridgeStateStore {
  readonly statePath: string;

  readonly #stateDir: string;
  readonly #identity: MatrixBridgeIdentity;
  readonly #diagnostics: DiagnosticSink | undefined;
  readonly #faultInjector: BridgeStateFaultInjector | undefined;
  #state: InternalState | undefined;
  #tail: Promise<void> = Promise.resolve();

  private constructor(
    stateDir: string,
    identity: MatrixBridgeIdentity,
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
    this.#diagnostics = diagnostics;
    this.#faultInjector = faultInjector;
  }

  static async open(options: BridgeStateStoreOptions): Promise<PrivateBridgeStateStore> {
    return openBridgeStateStore(options);
  }

  static async openValidated(
    options: BridgeStateStoreOptions & { readonly stateDir: string },
  ): Promise<PrivateBridgeStateStore> {
    const store = new PrivateBridgeStateStore(
      options.stateDir,
      options.identity,
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
    const sessions = Object.fromEntries(
      [...(state?.sessions.entries() ?? [])].sort(([left], [right]) => left.localeCompare(right)),
    ) as Record<MatrixRoomId, AcpSessionId>;
    const completedEventIds = Object.fromEntries(
      [...(state?.completedEventIds.entries() ?? [])]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([roomId, eventIds]) => [roomId, [...eventIds]]),
    ) as Record<MatrixRoomId, readonly MatrixEventId[]>;
    return {
      schemaVersion: BRIDGE_STATE_SCHEMA_VERSION,
      identity: { ...this.#identity },
      initialized: state?.initialized ?? false,
      sessionMappings: sessions,
      completedEventIds,
    };
  }

  isEventCompleted(eventId: MatrixEventId): boolean;
  isEventCompleted(roomId: MatrixRoomId, eventId: MatrixEventId): boolean;
  isEventCompleted(roomOrEventId: string, eventId?: MatrixEventId): boolean {
    if (eventId === undefined) {
      this.#validateEventId(roomOrEventId);
      return [...(this.#state?.completedEventIds.values() ?? [])].some((ids) => ids.includes(roomOrEventId));
    }
    this.#validateRoomId(roomOrEventId);
    this.#validateEventId(eventId);
    return this.#state?.completedEventIds.get(roomOrEventId)?.includes(eventId) ?? false;
  }

  /**
   * Atomically records the first initial-sync baseline. The initialized bit
   * is part of the same replacement as the event IDs, so a crash before the
   * replacement leaves the state fresh and history suppressed on retry.
   */
  async establishInitialBaseline(completedEventIds: CompletedEventLedgerInput): Promise<void> {
    return this.#enqueue(async () => {
      const baseline = this.#normalizeLedger(completedEventIds);
      const current = this.#state;
      if (current?.initialized === true) {
        return;
      }
      const nextCompleted = cloneCompletedEventIds(current?.completedEventIds);
      mergeCompletedEventIds(nextCompleted, baseline);
      const next: InternalState = {
        initialized: true,
        sessions: new Map(current?.sessions ?? []),
        completedEventIds: nextCompleted,
      };
      await this.#persist(next);
      this.#state = next;
    });
  }

  /** Persist one terminal event before its Matrix response is delivered. */
  async markEventCompleted(roomId: MatrixRoomId, eventId: MatrixEventId): Promise<boolean> {
    return this.#enqueue(async () => {
      this.#validateRoomId(roomId);
      this.#validateEventId(eventId);
      const current = this.#state;
      const existing = current?.completedEventIds.get(roomId) ?? [];
      if (existing.includes(eventId)) {
        return false;
      }
      const completedEventIds = cloneCompletedEventIds(current?.completedEventIds);
      const room = completedEventIds.get(roomId) ?? [];
      room.push(eventId);
      completedEventIds.set(roomId, room);
      const next: InternalState = {
        initialized: current?.initialized ?? false,
        sessions: new Map(current?.sessions ?? []),
        completedEventIds,
      };
      await this.#persist(next);
      this.#state = next;
      return true;
    });
  }

  /**
   * Keep the completed IDs visible in the current initial-sync window and
   * add IDs that became terminal while that window was being handled. The
   * replacement is atomic; if compaction fails, the old state can only
   * over-retain IDs and therefore remains safe for deduplication.
   */
  async compactCompletedEventIds(
    input: CompletedEventLedgerInput | CompletedEventCompactionInput,
    newlyCompletedEventIds?: CompletedEventLedgerInput,
  ): Promise<void> {
    return this.#enqueue(async () => {
      const operation = isCompactionInput(input)
        ? input
        : { currentTimeline: input, newlyCompletedEventIds };
      const currentTimeline = this.#normalizeLedger(operation.currentTimeline);
      const newlyCompleted = this.#normalizeLedger(operation.newlyCompletedEventIds ?? []);
      const current = this.#state;
      const compacted = new Map<MatrixRoomId, MatrixEventId[]>();
      for (const [roomId, eventIds] of currentTimeline) {
        const currentIds = new Set(current?.completedEventIds.get(roomId) ?? []);
        const terminalIds = new Set(newlyCompleted.get(roomId) ?? []);
        const retained = eventIds.filter((eventId) => currentIds.has(eventId) || terminalIds.has(eventId));
        const terminalOutsideWindow = [...terminalIds].filter((eventId) => !eventIds.includes(eventId));
        const result = [...retained, ...terminalOutsideWindow];
        if (result.length > 0) {
          compacted.set(roomId, result);
        }
      }
      for (const [roomId, eventIds] of newlyCompleted) {
        if (!currentTimeline.has(roomId) && eventIds.length > 0) {
          compacted.set(roomId, [...eventIds]);
        }
      }
      if (completedLedgersEqual(current?.completedEventIds, compacted)) {
        return;
      }
      const next: InternalState = {
        initialized: current?.initialized ?? false,
        sessions: new Map(current?.sessions ?? []),
        completedEventIds: compacted,
      };
      await this.#persist(next);
      this.#state = next;
    });
  }

  getSessionMapping(roomId: MatrixRoomId): AcpSessionId | undefined {
    this.#validateRoomId(roomId);
    return this.#state?.sessions.get(roomId);
  }

  getSessionMappings(): ReadonlyMap<MatrixRoomId, AcpSessionId> {
    return new Map(this.#state?.sessions ?? []);
  }

  async setSessionMapping(roomId: MatrixRoomId, sessionId: AcpSessionId): Promise<boolean> {
    return this.#enqueue(async () => {
      this.#validateRoomId(roomId);
      this.#validateSessionId(sessionId);
      const current = this.#state;
      if (current?.sessions.get(roomId) === sessionId) {
        return false;
      }
      const next: InternalState = {
        initialized: current?.initialized ?? false,
        sessions: new Map(current?.sessions ?? []).set(roomId, sessionId),
        completedEventIds: cloneCompletedEventIds(current?.completedEventIds),
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
        initialized: current.initialized,
        sessions,
        completedEventIds: cloneCompletedEventIds(current.completedEventIds),
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
        initialized: current.initialized,
        sessions,
        completedEventIds: cloneCompletedEventIds(current.completedEventIds),
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
        initialized: current.initialized,
        sessions: new Map(),
        completedEventIds: cloneCompletedEventIds(current.completedEventIds),
      };
      await this.#persist(next);
      this.#state = next;
      return true;
    });
  }

  /** Wait for the complete fsync sequence of all accepted mutations. */
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
        initialized: state.initialized,
        sessions: new Map(state.sessions),
        completedEventIds: cloneCompletedEventIds(state.completedEventIds),
      };
      this.#emit("debug", "private-state-loaded", {
        initialized: state.initialized,
        mappingCount: state.sessions.size,
        completedRoomCount: state.completedEventIds.size,
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
    if (!hasExactKeys(value, ["schemaVersion", "identity", "initialized", "sessions", "completedEventIds"])) {
      throw this.#failure("corrupt");
    }
    const identity = this.#parseIdentity(value.identity);
    this.#assertIdentity(identity);
    if (typeof value.initialized !== "boolean") {
      throw this.#failure("corrupt");
    }
    const sessions = this.#parseSessions(value.sessions);
    const completedEventIds = this.#parseCompletedEventIds(value.completedEventIds);
    return { identity, initialized: value.initialized, sessions, completedEventIds };
  }

  #parseIdentity(value: unknown): MatrixBridgeIdentity {
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

  #parseCompletedEventIds(value: unknown): Map<MatrixRoomId, MatrixEventId[]> {
    if (!isRecord(value)) {
      throw this.#failure("corrupt");
    }
    const completedEventIds = new Map<MatrixRoomId, MatrixEventId[]>();
    for (const [roomId, rawEventIds] of Object.entries(value)) {
      this.#validateRoomIdForParse(roomId);
      if (!Array.isArray(rawEventIds)) {
        throw this.#failure("corrupt");
      }
      const eventIds: MatrixEventId[] = [];
      const seen = new Set<MatrixEventId>();
      for (const eventId of rawEventIds) {
        this.#validateEventIdForParse(eventId);
        if (seen.has(eventId)) {
          throw this.#failure("corrupt");
        }
        seen.add(eventId);
        eventIds.push(eventId);
      }
      if (eventIds.length > 0) {
        completedEventIds.set(roomId, eventIds);
      }
    }
    return completedEventIds;
  }

  #normalizeLedger(input: CompletedEventLedgerInput): Map<MatrixRoomId, MatrixEventId[]> {
    const entries: Array<readonly [unknown, unknown]> = [];
    if (Array.isArray(input)) {
      for (const room of input) {
        if (!isRecord(room) || typeof room.roomId !== "string" || !Array.isArray(room.eventIds)) {
          throw this.#failure("invalid-input");
        }
        entries.push([room.roomId, room.eventIds]);
      }
    } else if (isRecord(input) && Object.hasOwn(input, "rooms")) {
      if (!Array.isArray(input.rooms)) {
        throw this.#failure("invalid-input");
      }
      for (const room of input.rooms) {
        if (!isRecord(room) || typeof room.roomId !== "string" || !Array.isArray(room.eventIds)) {
          throw this.#failure("invalid-input");
        }
        entries.push([room.roomId, room.eventIds]);
      }
    } else if (input instanceof Map) {
      for (const [roomId, eventIds] of input) {
        entries.push([roomId, eventIds]);
      }
    } else if (isRecord(input)) {
      for (const [roomId, eventIds] of Object.entries(input)) {
        entries.push([roomId, eventIds]);
      }
    } else {
      throw this.#failure("invalid-input");
    }

    const result = new Map<MatrixRoomId, MatrixEventId[]>();
    for (const [rawRoomId, rawEventIds] of entries) {
      this.#validateRoomId(rawRoomId);
      if (!Array.isArray(rawEventIds) || result.has(rawRoomId)) {
        throw this.#failure("invalid-input");
      }
      const eventIds: MatrixEventId[] = [];
      const seen = new Set<MatrixEventId>();
      for (const eventId of rawEventIds) {
        this.#validateEventId(eventId);
        if (seen.has(eventId)) {
          throw this.#failure("invalid-input");
        }
        seen.add(eventId);
        eventIds.push(eventId);
      }
      if (eventIds.length > 0) {
        result.set(rawRoomId, eventIds);
      }
    }
    return result;
  }

  #assertIdentity(identity: MatrixBridgeIdentity): void {
    if (!identitiesEqual(identity, this.#identity)) {
      throw this.#failure("identity-mismatch");
    }
  }

  #validateIdentity(identity: MatrixBridgeIdentity): void {
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

  #serializeState(state: InternalState): string {
    const sessions = Object.fromEntries(
      [...state.sessions.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );
    const completedEventIds = Object.fromEntries(
      [...state.completedEventIds.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([roomId, eventIds]) => [roomId, [...eventIds]]),
    );
    return `${JSON.stringify({
      schemaVersion: BRIDGE_STATE_SCHEMA_VERSION,
      identity: this.#identity,
      initialized: state.initialized,
      sessions,
      completedEventIds,
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

function isCompactionInput(value: unknown): value is CompletedEventCompactionInput {
  return isRecord(value) && Object.hasOwn(value, "currentTimeline");
}

function cloneCompletedEventIds(
  source: ReadonlyMap<MatrixRoomId, readonly MatrixEventId[]> | undefined,
): Map<MatrixRoomId, MatrixEventId[]> {
  return new Map(
    [...(source?.entries() ?? [])].map(([roomId, eventIds]) => [roomId, [...eventIds]]),
  );
}

function mergeCompletedEventIds(
  target: Map<MatrixRoomId, MatrixEventId[]>,
  source: ReadonlyMap<MatrixRoomId, readonly MatrixEventId[]>,
): void {
  for (const [roomId, eventIds] of source) {
    const existing = target.get(roomId) ?? [];
    const seen = new Set(existing);
    for (const eventId of eventIds) {
      if (!seen.has(eventId)) {
        existing.push(eventId);
        seen.add(eventId);
      }
    }
    if (existing.length > 0) {
      target.set(roomId, existing);
    }
  }
}

function completedLedgersEqual(
  left: ReadonlyMap<MatrixRoomId, readonly MatrixEventId[]> | undefined,
  right: ReadonlyMap<MatrixRoomId, readonly MatrixEventId[]>,
): boolean {
  if ((left?.size ?? 0) !== right.size) {
    return false;
  }
  for (const [roomId, eventIds] of right) {
    const previous = left?.get(roomId);
    if (previous === undefined || previous.length !== eventIds.length ||
        !previous.every((eventId, index) => eventId === eventIds[index])) {
      return false;
    }
  }
  return true;
}

function identitiesEqual(left: MatrixBridgeIdentity, right: MatrixBridgeIdentity): boolean {
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
