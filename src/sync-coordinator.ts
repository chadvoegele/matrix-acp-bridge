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
  readonly #roomDispatchTails = new Map<string, Promise<void>>();
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
          emit(this.#diagnostics, "warn", "limited-matrix-timeline", { roomId: room.roomId });
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
          const history = new Map<string, InboundMatrixEvent[]>(
            [...eligible.entries()].map(([roomId, events]) => [
              roomId,
              events.filter((event) => !event.isLive),
            ]),
          );
          const live = new Map<string, InboundMatrixEvent[]>(
            [...eligible.entries()].map(([roomId, events]) => [
              roomId,
              events.filter((event) => event.isLive),
            ]),
          );
          await this.#establishBaseline(history);
          emit(this.#diagnostics, "info", "completed-event-baseline-established");
          this.#bridge.openIntake();
          this.#bridge.enableDispatch();
          this.#dispatchSelected(batch, live);
          this.#startupBatch = false;
          return;
        }

        const currentTimeline = this.#ledgerRooms(eligible);
        const selected = new Map<string, InboundMatrixEvent[]>();
        const newlyTerminal: CompletedEventRoomInput[] = [];
        let selectedCount = 0;
        let omittedCount = 0;
        const selectedLimit = Math.min(
          this.#config.limits.maxCatchupEventsPerRoom,
          1 + this.#config.limits.maxQueuedTurnsPerRoom,
        );
        for (const room of batch.rooms) {
          const events = (eligible.get(room.roomId) ?? []).filter((event) => event.eventId !== undefined);
          const unseen = events.filter((event) => !this.#stateStore.isEventCompleted(room.roomId, event.eventId!));
          const keep = unseen.slice(Math.max(0, unseen.length - selectedLimit));
          const keepIds = new Set(keep.map((event) => event.eventId));
          const omitted = unseen.filter((event) => !keepIds.has(event.eventId));
          selected.set(room.roomId, keep);
          if (omitted.length > 0) {
            newlyTerminal.push({
              roomId: room.roomId,
              eventIds: omitted.flatMap((event) => event.eventId === undefined ? [] : [event.eventId]),
            });
            omittedCount += omitted.length;
            emit(this.#diagnostics, "warn", "initial-sync-events-omitted", {
              roomId: room.roomId,
              omittedCount: omitted.length,
            });
          }
          selectedCount += keep.length;
        }
        await this.#compact(currentTimeline, newlyTerminal);
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

  async #establishBaseline(eligible: ReadonlyMap<string, readonly InboundMatrixEvent[]>): Promise<void> {
    try {
      await this.#stateStore.establishInitialBaseline(this.#ledgerRooms(eligible));
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
      let terminalTail = this.#roomDispatchTails.get(room.roomId) ?? Promise.resolve();
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
        terminalTail = terminalTail.then(() => this.#dispatchEvent(selectedEvent));
      }
      this.#roomDispatchTails.set(room.roomId, terminalTail);
      void terminalTail.catch(() => {});
    }
  }

  async #dispatchEvent(event: InboundMatrixEvent): Promise<void> {
    const eventId = event.eventId;
    if (eventId === undefined || this.#dispatchedEventIds.has(eventId)) {
      return;
    }
    this.#rememberDispatched(eventId);
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
  ): CompletedEventRoomInput[] {
    return [...events.entries()].map(([roomId, roomEvents]) => ({
      roomId,
      eventIds: roomEvents
        .map((event) => event.eventId)
        .filter((eventId): eventId is string => eventId !== undefined),
    }));
  }

  #rememberDispatched(eventId: string): void {
    this.#dispatchedEventIds.add(eventId);
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
