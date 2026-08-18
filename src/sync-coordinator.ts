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
import type { BridgeStateStore } from "./bridge-state.js";
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

/**
 * Authorize the batch before durable registration. Rejected events and events
 * omitted by catch-up policy are intentionally absent from the ledger: they
 * are not agent work and therefore cannot hold the recovery cursor.
 */
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
      const decision = authorizer.authorize(event);
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

      const checkpoint = this.#stateStore.getCheckpoint();
      if (this.#startupBatch && checkpoint === undefined && batch.phase === "initial") {
        // Initial history is deliberately outside the recovery cursor. This
        // is the only cursor write that may precede an event ledger.
        await this.#commitInitialCursor(batch.nextBatch);
        emit(this.#diagnostics, "info", "first-cursor-established");
        this.#bridge.openIntake();
        this.#bridge.enableDispatch();
        // A live event can arrive after PREPARED but before the initial
        // response is handed to the coordinator. It is not initial history;
        // register it against the established boundary before dispatch. The
        // equal boundary is intentional: the event was delivered in the
        // initial response, so completion removes this zero-distance ledger.
        const live = eligibleEvents(
          this.#roomsFrom(batch).map((room) => ({
            ...room,
            timeline: room.timeline.filter((event) =>
              event.isLive &&
              event.isCatchUp !== true &&
              event.timeline?.isCatchUp !== true,
            ),
          })),
          this.#config,
          this.#diagnostics,
          this.#clock,
          false,
        );
        if ([...live.values()].some((events) => events.length > 0)) {
          await this.#registerAndDispatch(batch, live);
        }
        this.#startupBatch = false;
        return;
      }

      if (this.#startupBatch) {
        const committedAtMs = checkpoint?.committedAtMs ?? this.#clock.now();
        const now = this.#clock.now();
        let ageMs = now - committedAtMs;
        if (ageMs < 0) {
          ageMs = 0;
          emit(this.#diagnostics, "warn", "clock-skew-during-catch-up");
        }
        emit(this.#diagnostics, "info", "catch-up-started", { elapsedMs: ageMs });

        const ageLimitMs = this.#config.limits.maxCatchupAgeSeconds * 1000;
        const selectedLimit = Math.min(
          this.#config.limits.maxCatchupEventsPerRoom,
          1 + this.#config.limits.maxQueuedTurnsPerRoom,
        );
        const eligible = eligibleEvents(this.#roomsFrom(batch), this.#config, this.#diagnostics, this.#clock, true);
        const selected = new Map<string, InboundMatrixEvent[]>();
        let selectedCount = 0;
        let omittedCount = 0;
        for (const room of batch.rooms) {
          const events = eligible.get(room.roomId) ?? [];
          if (ageMs > ageLimitMs) {
            omittedCount += events.length;
            selected.set(room.roomId, []);
            continue;
          }
          const keep = events.slice(Math.max(0, events.length - selectedLimit));
          const omitted = events.length - keep.length;
          omittedCount += omitted;
          if (omitted > 0) {
            emit(this.#diagnostics, "warn", "catch-up-events-omitted", {
              roomId: room.roomId,
              omittedCount: omitted,
            });
          }
          selectedCount += keep.length;
          selected.set(room.roomId, keep);
        }
        if (ageMs > ageLimitMs) {
          const total = [...eligible.values()].reduce((count, events) => count + events.length, 0);
          omittedCount = total;
          emit(this.#diagnostics, "warn", "catch-up-skipped-age", { elapsedMs: ageMs, omittedCount });
        }

        await this.#registerAndDispatch(batch, selected);
        emit(this.#diagnostics, "info", "catch-up-finished", { selectedCount, omittedCount });
        this.#bridge.openIntake();
        this.#bridge.enableDispatch();
        this.#startupBatch = false;
        return;
      }

      const eligible = eligibleEvents(this.#roomsFrom(batch), this.#config, this.#diagnostics, this.#clock, false);
      await this.#registerAndDispatch(batch, eligible);
    } finally {
      this.#handling = false;
    }
  }

  async #registerAndDispatch(
    batch: MatrixSyncBatch,
    selected: ReadonlyMap<string, readonly InboundMatrixEvent[]>,
  ): Promise<void> {
    const priorPending = new Set(
      this.#stateStore
        .getPendingRecoveryBatches()
        .flatMap((recoveryBatch) => recoveryBatch.rooms.flatMap((room) => room.eventIds)),
    );
    const registration = await this.#register(batch, selected);
    // Registration is the authoritative intake gate. No selected event is
    // handed to the bridge until this durable state transition has succeeded.
    const recoveryOrder = new Map<string, string[]>();
    for (const recoveryBatch of this.#stateStore.getPendingRecoveryBatches()) {
      for (const recoveryRoom of recoveryBatch.rooms) {
        const eventIds = recoveryOrder.get(recoveryRoom.roomId) ?? [];
        eventIds.push(...recoveryRoom.eventIds);
        recoveryOrder.set(recoveryRoom.roomId, eventIds);
      }
    }
    this.#bridge.openIntake();
    for (const room of batch.rooms) {
      const selectedById = new Map(
        (selected.get(room.roomId) ?? [])
          .filter((event): event is InboundMatrixEvent & { readonly eventId: string } => event.eventId !== undefined)
          .map((event) => [event.eventId, event]),
      );
      const timelineById = new Map(
        room.timeline
          .filter((event): event is InboundMatrixEvent & { readonly eventId: string } => event.eventId !== undefined)
          .map((event) => [event.eventId, event]),
      );
      const orderedEventIds = (recoveryOrder.get(room.roomId) ?? [])
        .filter((eventId) => timelineById.has(eventId));
      const orderedEventIdSet = new Set(orderedEventIds);
      for (const eventId of timelineById.keys()) {
        if (!orderedEventIdSet.has(eventId)) orderedEventIds.push(eventId);
      }
      let terminalTail = this.#roomDispatchTails.get(room.roomId) ?? Promise.resolve();
      let admissionGate: Promise<void> | undefined;
      for (const eventId of orderedEventIds) {
        const event = timelineById.get(eventId);
        if (event === undefined) {
          continue;
        }
        const selectedEvent = selectedById.get(eventId);
        if (selectedEvent !== undefined) {
          if (registration.get(eventId) !== "completed") {
            // Admit selected events immediately unless an earlier pending
            // event in this batch must first be completed as omitted. This
            // preserves bridge queue depth without allowing a later terminal
            // completion to violate the durable room FIFO.
            if (admissionGate !== undefined) {
              await admissionGate;
              admissionGate = undefined;
            }
            const terminal = this.#dispatchEvent(selectedEvent);
            terminalTail = terminalTail.then(() => terminal);
          }
          continue;
        }
        if (priorPending.has(eventId)) {
          // A previously registered event can be rejected or omitted by a
          // later restart's policy/age/volume decision. Resolve that old
          // ledger entry in room order so it cannot strand the cursor.
          terminalTail = terminalTail.then(() => this.#completeOmittedEvent(eventId));
          admissionGate = terminalTail;
        }
      }
      this.#roomDispatchTails.set(room.roomId, terminalTail);
      void terminalTail.catch(() => {});
    }
    try {
      await this.#stateStore.advanceRecoveryCursor();
    } catch (error) {
      this.#stateFailure(error, "advance-cursor");
      throw new Error("Private bridge state failure");
    }
  }

  async #register(
    batch: MatrixSyncBatch,
    selected: ReadonlyMap<string, readonly InboundMatrixEvent[]>,
  ): Promise<ReadonlyMap<string, "pending" | "completed">> {
    try {
      return await this.#stateStore.registerSyncBatch({
        nextBatch: batch.nextBatch,
        rooms: batch.rooms.map((room) => ({
          roomId: room.roomId,
          eventIds: (selected.get(room.roomId) ?? [])
            .map((event) => event.eventId)
            .filter((eventId): eventId is string => eventId !== undefined),
        })),
      });
    } catch (error) {
      this.#stateFailure(error, "register-batch");
      throw new Error("Private bridge state failure");
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
        await this.#stateStore.completeSyncEvent(eventId);
      } catch (error) {
        this.#stateFailure(error, "complete-event");
        throw new Error("Private bridge state failure");
      }
    };
    await this.#bridge.handleTimelineEvent(event, terminalCompletion).then(
      () => {
        // Compatibility for embedding bridges that return only after their
        // terminal response but do not consume the optional callback. A
        // callback-aware bridge may also resolve when fatal shutdown abandons
        // a turn, which must remain incomplete for restart.
        if (!terminalCalled && this.#bridge.consumesTerminalCompletion !== true) {
          return terminalCompletion();
        }
      },
      () => {
        // An interrupted turn is intentionally left incomplete for restart.
      },
    );
  }

  async #completeOmittedEvent(eventId: string): Promise<void> {
    try {
      await this.#stateStore.completeSyncEvent(eventId);
    } catch (error) {
      this.#stateFailure(error, "complete-omitted-event");
      throw new Error("Private bridge state failure");
    }
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

  #roomsFrom(batch: MatrixSyncBatch): readonly MatrixSyncRoomBatch[] {
    return batch.rooms;
  }

  async #commitInitialCursor(cursor: string): Promise<void> {
    try {
      await this.#stateStore.commitCursor(cursor, this.#clock.now());
    } catch (error) {
      this.#stateFailure(error, "commit-initial-cursor");
      throw new Error("Private bridge state failure");
    }
  }

  #stateFailure(error: unknown, operation: string): void {
    emit(this.#diagnostics, "error", "state-checkpoint-failure", {
      operation,
      ...(error instanceof BridgeStateError ? { reason: error.category } : {}),
    });
    const fatal: FatalError = {
      code: "state",
      message: "Private bridge state failure",
    };
    this.#onFatal(fatal);
  }
}
