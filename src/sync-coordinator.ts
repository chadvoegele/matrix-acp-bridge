import { createInboundAuthorizer } from "./authorization.js";
import type { BridgeConfig } from "./config.js";
import type { Clock } from "./clock.js";
import type { DiagnosticSink, FatalError } from "./diagnostics.js";
import type {
  InboundMatrixEvent,
  MatrixSyncBatch,
  MatrixSyncRoomBatch,
} from "./matrix-client.js";
import { BridgeStateError } from "./bridge-state.js";
import type { BridgeStateStore, CompletedEventRoomInput } from "./bridge-state.js";
import type { BridgeTerminalCompletion } from "./bridge.js";

export interface SyncCoordinatorBridge {
  openIntake(): void;
  enableDispatch(): void;
  /** True when the bridge invokes the callback only for terminal work. */
  readonly consumesTerminalCompletion?: boolean;
  handleTimelineEvent(event: InboundMatrixEvent, terminalCompletion?: BridgeTerminalCompletion): Promise<void>;
}

export interface MatrixSyncCoordinatorOptions {
  readonly config: BridgeConfig;
  readonly bridge: SyncCoordinatorBridge;
  readonly stateStore: BridgeStateStore;
  readonly diagnostics?: DiagnosticSink;
  readonly clock: Clock;
  readonly onFatal: (error: FatalError) => void;
}

function emit(
  sink: DiagnosticSink | undefined,
  level: "info" | "warn" | "error",
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>> = {},
): void {
  try {
    sink?.emit(level, event, fields);
  } catch {
    // Diagnostics are observational and never change sync behavior.
  }
}

/** Authorize a batch before any event is admitted to ACP or the ledger. */
function eligibleEvents(
  rooms: readonly MatrixSyncRoomBatch[],
  config: BridgeConfig,
  diagnostics: DiagnosticSink | undefined,
  clock: Clock,
  catchUp: boolean,
): Map<string, InboundMatrixEvent[]> {
  const authorizer = createInboundAuthorizer({
    allowedRooms: config.matrix.allowedRooms,
    allowedSenders: config.matrix.allowedSenders,
    bridgeUserId: config.matrix.userId,
    maxInputBytes: config.limits.maxInputBytes,
    encryption: config.matrix.encryption,
    ...(diagnostics === undefined ? {} : { diagnostics }),
    clock,
  });
  const selected = new Map<string, InboundMatrixEvent[]>();
  for (const room of rooms) {
    const values = selected.get(room.roomId) ?? [];
    for (const event of room.timeline) {
      // Initial-sync history is intentionally non-live at the Matrix adapter
      // boundary, but it still needs authorization before its ID is added to
      // the durable suppression baseline.
      const authorizationEvent = event.isLive ? event : { ...event, isLive: true };
      const decision = authorizer.authorize(authorizationEvent);
      if (decision.accepted || decision.kind === "oversized") {
        values.push(catchUp
          ? {
              ...event,
              // Initial-sync events are history at the adapter boundary, but
              // selected restart events are intentionally admitted through
              // the ordinary live authorization path.
              isLive: true,
              isCatchUp: true,
              timeline: {
                phase: "incremental",
                isCatchUp: true,
                limited: room.limited,
              },
            }
          : event);
      }
    }
    selected.set(room.roomId, values);
  }
  return selected;
}

export class MatrixSyncCoordinator {
  readonly #config: BridgeConfig;
  readonly #bridge: SyncCoordinatorBridge;
  readonly #stateStore: BridgeStateStore;
  readonly #diagnostics: DiagnosticSink | undefined;
  readonly #clock: Clock;
  readonly #onFatal: (error: FatalError) => void;
  readonly #dispatchedEventIds = new Set<string>();
  #startupBatch = true;
  #handling = false;
  #inFlight: Promise<void> | undefined;

  constructor(options: MatrixSyncCoordinatorOptions) {
    this.#config = options.config;
    this.#bridge = options.bridge;
    this.#stateStore = options.stateStore;
    this.#diagnostics = options.diagnostics;
    this.#clock = options.clock;
    this.#onFatal = options.onFatal;
  }

  handleBatch(batch: MatrixSyncBatch): Promise<void> {
    if (this.#handling) {
      return Promise.reject(new Error("Matrix sync batches overlapped"));
    }
    const operation = this.#handleBatch(batch);
    this.#inFlight = operation;
    return operation;
  }

  /** Wait for accepted sync work and every state mutation already queued. */
  async flush(): Promise<void> {
    let failure: unknown;
    let failed = false;
    try {
      await this.#inFlight;
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await this.#stateStore.flush?.();
    } catch (error) {
      if (!failed) {
        failure = error;
      }
      failed = true;
    }
    if (failed) {
      throw failure;
    }
  }

  async #handleBatch(batch: MatrixSyncBatch): Promise<void> {
    this.#handling = true;
    try {
      for (const room of batch.rooms) {
        if (room.limited) {
          emit(this.#diagnostics, "warn", "limited-matrix-timeline", {
            eventCount: room.timeline.length,
          });
        }
      }

      const eligible = eligibleEvents(
        batch.rooms,
        this.#config,
        this.#diagnostics,
        this.#clock,
        this.#startupBatch && batch.phase === "initial" && this.#stateStore.getSnapshot().initialized,
      );

      if (this.#startupBatch && batch.phase === "initial") {
        if (!this.#stateStore.getSnapshot().initialized) {
          // The whole first response is the baseline.  Events that arrived
          // while the SDK crossed PREPARED are still part of that response;
          // opening live intake does not make them new prompts.
          await this.#establishBaseline(this.#ledgerRooms(eligible, batch.rooms));
          emit(this.#diagnostics, "info", "completed-event-baseline-established");
          this.#bridge.openIntake();
          this.#bridge.enableDispatch();
          this.#startupBatch = false;
          return;
        }

        const currentTimeline = this.#ledgerRooms(eligible, batch.rooms);
        const selected = new Map<string, InboundMatrixEvent[]>();
        const newlyTerminalByRoom = new Map<string, string[]>(
          this.#terminalRooms(batch.rooms).map(({ roomId, eventIds }) => [roomId, [...eventIds]]),
        );
        let selectedCount = 0;
        let omittedCount = 0;
        const now = this.#clock.now();
        const maxAgeMs = this.#config.limits.maxCatchupAgeSeconds * 1000;
        const selectedLimit = Math.min(
          this.#config.limits.maxCatchupEventsPerRoom,
          1 + this.#config.limits.maxQueuedTurnsPerRoom,
        );
        for (const room of batch.rooms) {
          const events = (eligible.get(room.roomId) ?? []).filter((event) => event.eventId !== undefined);
          const unseen = events.filter((event) => !this.#stateStore.isEventCompleted(room.roomId, event.eventId!));
          const tooOld = unseen.filter((event) => this.#isTooOld(event, now, maxAgeMs));
          const recent = unseen.filter((event) => !this.#isTooOld(event, now, maxAgeMs));
          // The initial timeline is ordered oldest to newest.  Keep the most
          // recent bounded suffix, while dispatching that suffix in its
          // original Matrix order.
          const keep = recent.slice(Math.max(0, recent.length - selectedLimit));
          const keepIds = new Set(keep.map((event) => event.eventId));
          const omitted = unseen.filter((event) => !keepIds.has(event.eventId));
          selected.set(room.roomId, keep);
          if (omitted.length > 0) {
            const eventIds = newlyTerminalByRoom.get(room.roomId) ?? [];
            for (const event of omitted) {
              if (event.eventId !== undefined && !eventIds.includes(event.eventId)) {
                eventIds.push(event.eventId);
              }
            }
            newlyTerminalByRoom.set(room.roomId, eventIds);
            omittedCount += omitted.length;
            emit(this.#diagnostics, "warn", "initial-sync-events-omitted", {
              omittedCount: omitted.length,
              ageOmittedCount: tooOld.length,
              countOmittedCount: omitted.length - tooOld.length,
              reason: tooOld.length === omitted.length
                ? "age"
                : (tooOld.length === 0 ? "count" : "age-and-count"),
            });
          }
          selectedCount += keep.length;
        }
        await this.#compact(
          currentTimeline,
          [...newlyTerminalByRoom.entries()].map(([roomId, eventIds]) => ({ roomId, eventIds })),
        );
        emit(this.#diagnostics, "info", "initial-sync-recovery-finished", { selectedCount, omittedCount });
        this.#bridge.openIntake();
        this.#dispatchSelected(batch, selected);
        this.#bridge.enableDispatch();
        this.#startupBatch = false;
        return;
      }

      this.#bridge.openIntake();
      this.#dispatchSelected(batch, eligible);
      if (this.#startupBatch) {
        this.#bridge.enableDispatch();
        this.#startupBatch = false;
      }
    } finally {
      this.#handling = false;
    }
  }

  async #establishBaseline(ledger: readonly CompletedEventRoomInput[]): Promise<void> {
    try {
      await this.#stateStore.establishInitialBaseline(ledger);
    } catch (error) {
      this.#stateFailure(error, "establish-baseline");
      throw new Error("Private bridge state failure");
    }
  }

  async #compact(
    currentTimeline: readonly CompletedEventRoomInput[],
    newlyTerminal: readonly CompletedEventRoomInput[],
  ): Promise<void> {
    try {
      await this.#stateStore.compactCompletedEventIds(currentTimeline, newlyTerminal);
    } catch (error) {
      this.#stateFailure(error, "compact-completed-event-ledger");
      throw new Error("Private bridge state failure");
    }
  }

  #dispatchSelected(
    batch: MatrixSyncBatch,
    selected: ReadonlyMap<string, readonly InboundMatrixEvent[]>,
  ): void {
    for (const room of batch.rooms) {
      const selectedById = new Map(
        (selected.get(room.roomId) ?? [])
          .filter((event): event is InboundMatrixEvent & { readonly eventId: string } => event.eventId !== undefined)
          .map((event) => [event.eventId, event]),
      );
      for (const event of room.timeline) {
        if (event.eventId === undefined || !selectedById.has(event.eventId)) {
          continue;
        }
        if (this.#stateStore.isEventCompleted(room.roomId, event.eventId)) {
          continue;
        }
        const selectedEvent = selectedById.get(event.eventId);
        if (selectedEvent === undefined) {
          continue;
        }
        // #dispatchEvent invokes the bridge synchronously before its first
        // await. Calling each one directly admits the complete room batch to
        // the bridge FIFO without serializing on ACP completion.
        void this.#dispatchEvent(selectedEvent).catch(() => {});
      }
    }
  }

  async #dispatchEvent(event: InboundMatrixEvent): Promise<void> {
    const eventId = event.eventId;
    if (eventId === undefined) {
      return;
    }
    const dispatchKey = `${event.roomId}\u0000${eventId}`;
    if (this.#dispatchedEventIds.has(dispatchKey)) {
      return;
    }
    this.#rememberDispatched(event.roomId, eventId);
    let terminalCalled = false;
    const terminalCompletion: BridgeTerminalCompletion = async () => {
      terminalCalled = true;
      try {
        await this.#stateStore.markEventCompleted(event.roomId, eventId);
      } catch (error) {
        this.#stateFailure(error, "complete-event");
        throw new Error("Private bridge state failure");
      }
    };
    await this.#bridge.handleTimelineEvent(event, terminalCompletion).then(
      () => {
        if (!terminalCalled && this.#bridge.consumesTerminalCompletion !== true) {
          return terminalCompletion();
        }
      },
      () => {
        // An interrupted turn is intentionally left incomplete for restart.
      },
    );
  }

  #ledgerRooms(
    events: ReadonlyMap<string, readonly InboundMatrixEvent[]>,
    rooms: readonly MatrixSyncRoomBatch[] = [],
  ): CompletedEventRoomInput[] {
    const byRoom = new Map<string, string[]>();
    for (const [roomId, roomEvents] of events) {
      const eventIds = roomEvents
        .map((event) => event.eventId)
        .filter((eventId): eventId is string => eventId !== undefined);
      if (eventIds.length > 0) {
        byRoom.set(roomId, eventIds);
      }
    }
    for (const room of rooms) {
      if (room.terminalEventIds === undefined || room.terminalEventIds.length === 0) {
        continue;
      }
      const eventIds = byRoom.get(room.roomId) ?? [];
      for (const eventId of room.terminalEventIds) {
        if (!eventIds.includes(eventId)) {
          eventIds.push(eventId);
        }
      }
      byRoom.set(room.roomId, eventIds);
    }
    return [...byRoom.entries()].map(([roomId, eventIds]) => ({ roomId, eventIds }));
  }

  #terminalRooms(rooms: readonly MatrixSyncRoomBatch[]): CompletedEventRoomInput[] {
    return rooms.flatMap((room) => room.terminalEventIds === undefined || room.terminalEventIds.length === 0
      ? []
      : [{ roomId: room.roomId, eventIds: room.terminalEventIds }]);
  }

  #isTooOld(event: InboundMatrixEvent, now: number, maxAgeMs: number): boolean {
    const originServerTs = event.originServerTs;
    if (originServerTs === undefined || !Number.isFinite(originServerTs)) {
      return true;
    }
    return Math.max(0, now - originServerTs) > maxAgeMs;
  }

  #rememberDispatched(roomId: string, eventId: string): void {
    const key = `${roomId}\u0000${eventId}`;
    this.#dispatchedEventIds.add(key);
    if (this.#dispatchedEventIds.size <= 10_000) {
      return;
    }
    const oldest = this.#dispatchedEventIds.values().next().value;
    if (typeof oldest === "string") {
      this.#dispatchedEventIds.delete(oldest);
    }
  }

  #stateFailure(error: unknown, operation: string): void {
    emit(this.#diagnostics, "error", "state-ledger-failure", {
      operation,
      ...(error instanceof BridgeStateError ? { reason: error.category } : {}),
    });
    this.#onFatal({
      code: "state",
      message: "Private bridge state failure",
    });
  }
}
