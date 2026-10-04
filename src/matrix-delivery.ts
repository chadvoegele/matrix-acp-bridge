import { systemClock, clampTimerMilliseconds, type Clock, type TimerHandle } from "./clock.js";
import type { DiagnosticFields, DiagnosticSink } from "./diagnostics.js";
import { classifyDeliveryFailure, calculateRetryDelay } from "./matrix-retry.js";
import type { MatrixBridgeAdapter, MatrixEventId, MatrixHtmlMessage, MatrixRoomId } from "./matrix-client.js";
import type { RenderedMatrixPart } from "./response-rendering.js";

export interface DeliveryOptions {
  readonly allowDuringStop?: boolean;
  readonly retry?: boolean;
}

interface MatrixDeliveryOptions {
  readonly matrix: MatrixBridgeAdapter;
  readonly canSend: (allowDuringStop?: boolean) => boolean;
  readonly clock?: Clock;
  readonly random?: () => number;
  readonly diagnostics?: DiagnosticSink;
}

/** Serializes whole responses within a room; independent rooms can send concurrently. */
export class MatrixDelivery {
  readonly #matrix: MatrixBridgeAdapter;

  readonly #canSend: (allowDuringStop?: boolean) => boolean;

  readonly #clock: Clock;

  readonly #random: () => number;

  readonly #diagnostics: DiagnosticSink | undefined;

  readonly #roomTails = new Map<MatrixRoomId, Promise<void>>();

  readonly #retryWaits = new Set<() => void>();

  constructor(options: MatrixDeliveryOptions) {
    this.#matrix = options.matrix;
    this.#canSend = options.canSend;
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
    this.#diagnostics = options.diagnostics;
  }

  sendLive(message: MatrixHtmlMessage): Promise<MatrixEventId | undefined> {
    if (this.#matrix.sendHtmlMessage === undefined || !this.#canSend()) {
      // eslint-disable-next-line unicorn/no-useless-undefined -- resolve an absent Matrix event ID
      return Promise.resolve(undefined);
    }
    return this.#serializeRoom(message.roomId, async () => {
      let attempt = 0;
      for (;;) {
        if (!this.#canSend()) return;
        try {
          return await this.#matrix.sendHtmlMessage!(message);
        } catch (error) {
          const failure = classifyDeliveryFailure(error, this.#clock.now());
          if (!failure.retryable) {
            this.#diagnostic("matrix-live-abandoned", { kind: "delivery" });
            return;
          }
          if (!(await this.#waitForRetry(calculateRetryDelay(failure, attempt++, this.#random)))) return;
        }
      }
    });
  }

  sendParts(
    roomId: MatrixRoomId,
    parts: readonly RenderedMatrixPart[],
    options: DeliveryOptions = {},
  ): Promise<boolean> {
    if (!this.#canSend(options.allowDuringStop)) return Promise.resolve(false);
    return this.#serializeRoom(roomId, async () => {
      let attempt = 0;
      for (const part of parts) {
        for (;;) {
          if (!this.#canSend(options.allowDuringStop)) return false;
          try {
            await this.#matrix.sendMessage(part);
            attempt = 0;
            break;
          } catch (error) {
            const failure = classifyDeliveryFailure(error, this.#clock.now());
            if (options.retry === false || !failure.retryable || !this.#canSend()) {
              this.#diagnostic("matrix-response-abandoned", {
                roomId,
                eventId: part.inboundEventId,
                responseKind: part.responseKind,
                partNumber: part.partNumber,
              });
              return false;
            }
            if (!(await this.#waitForRetry(calculateRetryDelay(failure, attempt++, this.#random)))) return false;
          }
        }
      }
      return true;
    });
  }

  cancelRetries(): void {
    for (const cancel of this.#retryWaits) cancel();
  }

  #serializeRoom<T>(roomId: MatrixRoomId, operation: () => Promise<T>): Promise<T> {
    const previous = this.#roomTails.get(roomId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.#roomTails.set(roomId, tail);
    void tail.then(() => {
      if (this.#roomTails.get(roomId) === tail) this.#roomTails.delete(roomId);
    });
    return result;
  }

  #waitForRetry(delayMs: number): Promise<boolean> {
    if (!this.#canSend()) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const cancel = (): void => {
        this.#clock.clearTimeout(timer);
        this.#retryWaits.delete(cancel);
        resolve(false);
      };
      const timer: TimerHandle = this.#clock.setTimeout(() => {
        this.#retryWaits.delete(cancel);
        resolve(true);
      }, clampTimerMilliseconds(delayMs));
      this.#retryWaits.add(cancel);
    });
  }

  #diagnostic(event: string, fields: DiagnosticFields): void {
    try {
      this.#diagnostics?.emit("warn", event, fields);
    } catch {
      // Diagnostics cannot affect delivery.
    }
  }
}
