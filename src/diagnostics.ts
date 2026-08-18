import { stderr } from "node:process";

import { systemClock } from "./clock.js";
import type { Clock } from "./clock.js";
import type { Unsubscribe } from "./cancellation.js";

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";
export type DiagnosticValue = string | number | boolean | null;
export type DiagnosticFields = Readonly<Record<string, DiagnosticValue>>;

export interface DiagnosticRecord {
  readonly timestamp: string;
  readonly level: DiagnosticLevel;
  readonly event: string;
  readonly fields: DiagnosticFields;
}

export interface DiagnosticSink {
  emit(level: DiagnosticLevel, event: string, fields?: DiagnosticFields): void;
  debug(event: string, fields?: DiagnosticFields): void;
  info(event: string, fields?: DiagnosticFields): void;
  warn(event: string, fields?: DiagnosticFields): void;
  error(event: string, fields?: DiagnosticFields): void;
}

export type FatalErrorCode =
  | "startup"
  | "acp_transport"
  | "acp_protocol"
  | "matrix_transport"
  | "matrix_invariant"
  | "state"
  | "shutdown";

export interface FatalError {
  readonly code: FatalErrorCode;
  readonly message: string;
}

export type FatalErrorListener = (error: FatalError) => void;

export interface FatalErrorSource {
  onFatalError(listener: FatalErrorListener): Unsubscribe;
}

export type DiagnosticWriter = (line: string) => void;

export interface StderrDiagnosticSinkOptions {
  readonly clock?: Clock;
  /** Injected by tests; the default writes only to process stderr. */
  readonly writeLine?: DiagnosticWriter;
}

export interface RateLimitedDiagnosticSinkOptions {
  readonly clock?: Clock;
  /** Maximum number of diagnostics emitted immediately for one key. */
  readonly burst?: number;
  /** Time needed to refill one token. */
  readonly refillIntervalMs?: number;
}

const DEFAULT_DIAGNOSTIC_BURST = 5;
const DEFAULT_DIAGNOSTIC_REFILL_INTERVAL_MS = 60_000;

function defaultWriter(line: string): void {
  stderr.write(`${line}\n`);
}

function orderedFields(fields: DiagnosticFields): DiagnosticFields {
  return Object.fromEntries(
    Object.entries(fields).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * A deliberately narrow, structured logger.  Fields are scalar-only so raw
 * Matrix content, tokens, and ACP error objects cannot be accidentally
 * serialized through this boundary.  The default writer never touches
 * stdout.
 */
export class StderrDiagnosticSink implements DiagnosticSink {
  readonly #clock: Clock;
  readonly #writeLine: DiagnosticWriter;

  constructor(options: StderrDiagnosticSinkOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#writeLine = options.writeLine ?? defaultWriter;
  }

  emit(level: DiagnosticLevel, event: string, fields: DiagnosticFields = {}): void {
    const record: DiagnosticRecord = {
      timestamp: new Date(this.#clock.now()).toISOString(),
      level,
      event,
      fields: orderedFields(fields),
    };
    this.#writeLine(JSON.stringify(record));
  }

  debug(event: string, fields?: DiagnosticFields): void {
    if (fields === undefined) {
      this.emit("debug", event);
    } else {
      this.emit("debug", event, fields);
    }
  }

  info(event: string, fields?: DiagnosticFields): void {
    if (fields === undefined) {
      this.emit("info", event);
    } else {
      this.emit("info", event, fields);
    }
  }

  warn(event: string, fields?: DiagnosticFields): void {
    if (fields === undefined) {
      this.emit("warn", event);
    } else {
      this.emit("warn", event, fields);
    }
  }

  error(event: string, fields?: DiagnosticFields): void {
    if (fields === undefined) {
      this.emit("error", event);
    } else {
      this.emit("error", event, fields);
    }
  }
}

export function createStderrDiagnosticSink(
  options: StderrDiagnosticSinkOptions = {},
): DiagnosticSink {
  return new StderrDiagnosticSink(options);
}

interface DiagnosticBucket {
  tokens: number;
  lastRefillAt: number;
  suppressedCount: number;
}

function requirePositiveFiniteNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function rateLimitKey(fields: DiagnosticFields): string | undefined {
  const roomId = fields.roomId;
  const reason = fields.reason;
  if (typeof roomId !== "string" || typeof reason !== "string") {
    return undefined;
  }

  // Length prefixes make the key unambiguous even if an identifier contains
  // the separator.  The values remain metadata-only scalar fields.
  return `${roomId.length}:${roomId}\u0000${reason.length}:${reason}`;
}

/**
 * Token-bucket wrapper for structured diagnostics.
 *
 * Diagnostics carrying both `roomId` and `reason` are limited independently
 * for each pair.  Other diagnostics pass through unchanged.  A suppressed
 * count is attached to the first later diagnostic that obtains a token.
 */
export class RateLimitedDiagnosticSink implements DiagnosticSink {
  readonly #delegate: DiagnosticSink;
  readonly #clock: Clock;
  readonly #burst: number;
  readonly #refillIntervalMs: number;
  readonly #buckets = new Map<string, DiagnosticBucket>();

  constructor(
    delegate: DiagnosticSink,
    options: RateLimitedDiagnosticSinkOptions = {},
  ) {
    this.#delegate = delegate;
    this.#clock = options.clock ?? systemClock;
    this.#burst = requirePositiveFiniteNumber(
      options.burst ?? DEFAULT_DIAGNOSTIC_BURST,
      "diagnostic burst",
    );
    this.#refillIntervalMs = requirePositiveFiniteNumber(
      options.refillIntervalMs ?? DEFAULT_DIAGNOSTIC_REFILL_INTERVAL_MS,
      "diagnostic refill interval",
    );
  }

  emit(level: DiagnosticLevel, event: string, fields: DiagnosticFields = {}): void {
    const key = rateLimitKey(fields);
    if (key === undefined) {
      this.#delegate.emit(level, event, fields);
      return;
    }

    const now = this.#clock.now();
    const bucket = this.#buckets.get(key) ?? {
      tokens: this.#burst,
      lastRefillAt: now,
      suppressedCount: 0,
    };
    this.#refill(bucket, now);

    if (bucket.tokens < 1) {
      bucket.suppressedCount += 1;
      this.#buckets.set(key, bucket);
      return;
    }

    bucket.tokens -= 1;
    const suppressedCount = bucket.suppressedCount;
    bucket.suppressedCount = 0;
    this.#buckets.set(key, bucket);

    if (suppressedCount === 0) {
      this.#delegate.emit(level, event, fields);
      return;
    }

    this.#delegate.emit(level, event, {
      ...fields,
      suppressedCount,
    });
  }

  debug(event: string, fields?: DiagnosticFields): void {
    this.emit("debug", event, fields ?? {});
  }

  info(event: string, fields?: DiagnosticFields): void {
    this.emit("info", event, fields ?? {});
  }

  warn(event: string, fields?: DiagnosticFields): void {
    this.emit("warn", event, fields ?? {});
  }

  error(event: string, fields?: DiagnosticFields): void {
    this.emit("error", event, fields ?? {});
  }

  #refill(bucket: DiagnosticBucket, now: number): void {
    if (!Number.isFinite(now)) {
      return;
    }

    const elapsed = now - bucket.lastRefillAt;
    if (elapsed <= 0) {
      return;
    }

    bucket.tokens = Math.min(
      this.#burst,
      bucket.tokens + elapsed / this.#refillIntervalMs,
    );
    bucket.lastRefillAt = now;
  }
}

export function createRateLimitedDiagnosticSink(
  delegate: DiagnosticSink,
  options: RateLimitedDiagnosticSinkOptions = {},
): DiagnosticSink {
  return new RateLimitedDiagnosticSink(delegate, options);
}
