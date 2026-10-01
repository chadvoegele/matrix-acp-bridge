import { RateLimitedDiagnosticSink } from "./diagnostics.js";
import type { Clock } from "./clock.js";
import type { BridgeConfig, EncryptionMode, ResponseMode } from "./config.js";
import type { ThreadRoutingMetadata } from "./conversation-identity.js";
import type { DiagnosticFields, DiagnosticSink } from "./diagnostics.js";
import type { InboundMatrixEvent, MatrixEventId, MatrixRoomId, MatrixUserId } from "./matrix-client.js";
import { isValidMatrixEventId } from "./matrix-validation.js";
import { hasOwn, isRecord } from "./object-validation.js";
import { utf8ByteLength } from "./text-utils.js";

export interface InReplyToRelation {
  readonly eventId: MatrixEventId;
}

/** Validated addressing, available only after the full authorization policy. */
export interface NormalizedInboundRouting extends ThreadRoutingMetadata {
  readonly roomId: MatrixRoomId;
  readonly eventId: MatrixEventId;
  readonly sender: MatrixUserId;
  readonly inReplyTo?: InReplyToRelation;
}

/** An event after authorization and reply-fallback normalization. */
export interface NormalizedInboundEvent extends NormalizedInboundRouting {
  readonly body: string;
}

export const OVERSIZED_RESPONSE_TEXT = "Your message is too large.";

export const INBOUND_REJECTION_REASONS = {
  roomNotAllowed: "room-not-allowed",
  senderNotAllowed: "sender-not-allowed",
  selfEvent: "self-event",
  notLive: "not-live",
  redacted: "redacted",
  encrypted: "encrypted",
  unsupportedEventType: "unsupported-event-type",
  invalidEventId: "invalid-event-id",
  invalidContent: "invalid-content",
  invalidRelation: "invalid-relation",
  emptyBody: "empty-body",
  oversized: "oversized",
} as const;

export type InboundRejectionReason = (typeof INBOUND_REJECTION_REASONS)[keyof typeof INBOUND_REJECTION_REASONS];

export interface InboundAuthorizationOptions {
  readonly allowedRooms: Iterable<MatrixRoomId>;
  readonly allowedSenders: Iterable<MatrixUserId>;
  /** The authenticated Matrix user ID used by the bridge. */
  readonly bridgeUserId: MatrixUserId;
  readonly maxInputBytes: number;
  /** Strict wire-encryption mode at the adapter/policy boundary. */
  readonly encryption?: EncryptionMode;
  readonly responseMode?: ResponseMode;
  readonly diagnostics?: DiagnosticSink;
  readonly clock?: Clock;
}

export type InboundAuthorizationConfig = InboundAuthorizationOptions | BridgeConfig;

export interface AcceptedInboundDecision {
  readonly accepted: true;
  readonly kind: "accepted";
  readonly event: NormalizedInboundEvent;
}

export interface RejectedInboundDecision {
  readonly accepted: false;
  readonly kind: "rejected";
  readonly reason: Exclude<InboundRejectionReason, "oversized">;
}

export interface OversizedInboundDecision {
  readonly accepted: false;
  readonly kind: "oversized";
  readonly reason: typeof INBOUND_REJECTION_REASONS.oversized;
  /** Safe error routing without admitting a conversation or retaining its body. */
  readonly routing: NormalizedInboundRouting;
  readonly response: {
    readonly kind: "oversized";
    readonly text: typeof OVERSIZED_RESPONSE_TEXT;
  };
}

export type InboundAuthorizationDecision = AcceptedInboundDecision | RejectedInboundDecision | OversizedInboundDecision;

interface ResolvedAuthorizationOptions {
  readonly allowedRooms: ReadonlySet<MatrixRoomId>;
  readonly allowedSenders: ReadonlySet<MatrixUserId>;
  readonly bridgeUserId: MatrixUserId;
  readonly maxInputBytes: number;
  readonly encryption: EncryptionMode;
  readonly responseMode: ResponseMode;
  readonly diagnostics?: DiagnosticSink;
  readonly clock?: Clock;
}

interface RecordLike {
  readonly [key: string]: unknown;
}

const cachedDiagnosticSinks = new WeakMap<object, RateLimitedDiagnosticSink>();

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function iterableToSet(values: Iterable<string>, name: string): ReadonlySet<string> {
  if (typeof values === "string" || values === null || values === undefined) {
    throw new TypeError(`${name} must be an iterable of strings`);
  }

  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      throw new TypeError(`${name} must contain only strings`);
    }
    result.add(value);
  }
  return result;
}

function resolveOptions(options: InboundAuthorizationConfig): ResolvedAuthorizationOptions {
  const candidate = options as Partial<InboundAuthorizationOptions> & {
    readonly matrix?: BridgeConfig["matrix"];
    readonly limits?: BridgeConfig["limits"];
  };

  const matrix = candidate.matrix;
  const limits = candidate.limits;
  const allowedRooms = candidate.allowedRooms ?? matrix?.allowedRooms;
  const allowedSenders = candidate.allowedSenders ?? matrix?.allowedSenders;
  const bridgeUserId = candidate.bridgeUserId ?? matrix?.userId;
  const maxInputBytes = candidate.maxInputBytes ?? limits?.maxInputBytes;
  const encryption = candidate.encryption ?? matrix?.encryption ?? "disabled";
  const responseMode = candidate.responseMode ?? matrix?.responseMode ?? "room";

  if (allowedRooms === undefined) {
    throw new TypeError("allowedRooms is required");
  }
  if (allowedSenders === undefined) {
    throw new TypeError("allowedSenders is required");
  }
  if (bridgeUserId === undefined || typeof bridgeUserId !== "string") {
    throw new TypeError("bridgeUserId is required");
  }
  if (maxInputBytes === undefined || !Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0) {
    throw new RangeError("maxInputBytes must be a positive safe integer");
  }
  if (encryption !== "disabled" && encryption !== "required") {
    throw new TypeError("encryption must be either disabled or required");
  }

  if (responseMode !== "room" && responseMode !== "thread") {
    throw new TypeError("responseMode must be either room or thread");
  }

  return {
    allowedRooms: iterableToSet(allowedRooms, "allowedRooms"),
    allowedSenders: iterableToSet(allowedSenders, "allowedSenders"),
    bridgeUserId,
    maxInputBytes,
    encryption,
    responseMode,
    ...(candidate.diagnostics === undefined ? {} : { diagnostics: candidate.diagnostics }),
    ...(candidate.clock === undefined ? {} : { clock: candidate.clock }),
  };
}

function diagnosticSinkFor(sink: DiagnosticSink | undefined, clock: Clock | undefined): DiagnosticSink | undefined {
  if (sink === undefined) {
    return undefined;
  }
  if (sink instanceof RateLimitedDiagnosticSink) {
    return sink;
  }

  // Authorizer instances are stateful with respect to their injected
  // diagnostic sink, so repeated events receive the same bucket.
  const existing = cachedDiagnosticSinks.get(sink);
  if (existing !== undefined) {
    return existing;
  }

  const limited = new RateLimitedDiagnosticSink(sink, clock === undefined ? {} : { clock });
  cachedDiagnosticSinks.set(sink, limited);
  return limited;
}

type ValidatedRelation =
  | { readonly valid: false }
  | ({ readonly valid: true; readonly inReplyTo?: InReplyToRelation } & ThreadRoutingMetadata);

/**
 * Supported shapes are an exact ordinary reply, or m.thread with required
 * rel_type/event_id and optional boolean is_falling_back and exact reply.
 * is_falling_back distinguishes a compatibility target from a deliberate
 * reply; either reply shape can carry a rich-reply body fallback.
 */
function relationFromContent(content: RecordLike, responseMode: ResponseMode): ValidatedRelation {
  if (!hasOwn(content, "m.relates_to")) {
    return { valid: true };
  }

  const relatesTo = content["m.relates_to"];
  if (!isRecord(relatesTo)) {
    return { valid: false };
  }

  const isThread = responseMode === "thread" && relatesTo.rel_type === "m.thread";
  if (isThread) {
    const allowedKeys = new Set(["rel_type", "event_id", "is_falling_back", "m.in_reply_to"]);
    if (
      !hasOwn(relatesTo, "rel_type") ||
      !hasOwn(relatesTo, "event_id") ||
      !Reflect.ownKeys(relatesTo).every((key) => typeof key === "string" && allowedKeys.has(key)) ||
      !isValidMatrixEventId(relatesTo.event_id) ||
      (hasOwn(relatesTo, "is_falling_back") && typeof relatesTo.is_falling_back !== "boolean")
    ) {
      return { valid: false };
    }
  } else if (!hasExactlyOwnKeys(relatesTo, ["m.in_reply_to"])) {
    return { valid: false };
  }

  let inReplyTo: InReplyToRelation | undefined;
  if (hasOwn(relatesTo, "m.in_reply_to")) {
    const reply = relatesTo["m.in_reply_to"];
    if (!isRecord(reply) || !hasExactlyOwnKeys(reply, ["event_id"]) || !isValidMatrixEventId(reply.event_id)) {
      return { valid: false };
    }
    inReplyTo = { eventId: reply.event_id };
  }
  return {
    valid: true,
    ...(isThread ? { threadRootEventId: relatesTo.event_id as MatrixEventId } : {}),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
  };
}

function hasExactlyOwnKeys(value: RecordLike, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

/**
 * Remove the Matrix plain-text reply fallback from a body.
 *
 * Only the initial lines beginning with the protocol's `> ` prefix are
 * removed.  One following empty line is the fallback/body separator; its line
 * ending is removed as part of the fallback.  The remainder is returned
 * byte-for-byte, including leading/trailing spaces and extra newlines.
 */
export function stripReplyFallback(body: string): string {
  if (!body.startsWith("> ")) {
    return body;
  }

  let offset = 0;
  let removedLine = false;
  while (offset < body.length) {
    if (!body.startsWith("> ", offset)) {
      break;
    }
    removedLine = true;

    const lineBreak = findLineBreak(body, offset);
    if (lineBreak === undefined) {
      offset = body.length;
      break;
    }
    offset = lineBreak.end;
  }

  if (!removedLine) {
    return body;
  }

  // The standard fallback has one blank separator line.  Consume exactly one
  // such line, leaving any additional blank lines as user text.
  const separator = findLineBreak(body, offset);
  if (separator !== undefined && separator.start === offset) {
    offset = separator.end;
  }
  return body.slice(offset);
}

interface LineBreak {
  readonly start: number;
  readonly end: number;
}

function findLineBreak(value: string, from: number): LineBreak | undefined {
  for (let index = from; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\n") {
      return { start: index, end: index + 1 };
    }
    if (character === "\r") {
      return value[index + 1] === "\n" ? { start: index, end: index + 2 } : { start: index, end: index + 1 };
    }
  }
  return undefined;
}

function diagnosticFieldsFor(event: unknown, reason: InboundRejectionReason): DiagnosticFields {
  const record = isRecord(event) ? event : {};
  return {
    eventId: stringValue(record.eventId),
    reason,
    roomId: stringValue(record.roomId),
    sender: stringValue(record.sender),
  };
}

function isStateEvent(event: RecordLike): boolean {
  return hasOwn(event, "stateKey") && event.stateKey !== undefined;
}

export class InboundAuthorizer {
  readonly #options: ResolvedAuthorizationOptions;

  readonly #diagnostics: DiagnosticSink | undefined;

  constructor(options: InboundAuthorizationConfig) {
    this.#options = resolveOptions(options);
    this.#diagnostics = diagnosticSinkFor(this.#options.diagnostics, this.#options.clock);
  }

  authorize(event: InboundMatrixEvent): InboundAuthorizationDecision {
    const record = isRecord(event) ? event : undefined;
    if (record === undefined) {
      return this.#reject(event, INBOUND_REJECTION_REASONS.invalidContent);
    }

    if (typeof record.roomId !== "string" || !this.#options.allowedRooms.has(record.roomId)) {
      return this.#reject(event, INBOUND_REJECTION_REASONS.roomNotAllowed);
    }

    if (typeof record.sender !== "string" || record.sender === this.#options.bridgeUserId) {
      return typeof record.sender === "string"
        ? this.#reject(event, INBOUND_REJECTION_REASONS.selfEvent)
        : this.#reject(event, INBOUND_REJECTION_REASONS.senderNotAllowed);
    }
    if (!this.#options.allowedSenders.has(record.sender)) {
      return this.#reject(event, INBOUND_REJECTION_REASONS.senderNotAllowed);
    }

    if (record.isLive !== true) {
      return this.#reject(event, INBOUND_REJECTION_REASONS.notLive);
    }
    if (record.isRedacted !== false) {
      return this.#reject(event, INBOUND_REJECTION_REASONS.redacted);
    }
    const wireEncrypted = record.isEncrypted === true || record.isPlaintext === false;
    if (this.#options.encryption === "required") {
      if (record.isEncrypted !== true || record.isDecrypted !== true) {
        return this.#reject(event, INBOUND_REJECTION_REASONS.encrypted);
      }
    } else if (wireEncrypted || record.isDecrypted === false) {
      return this.#reject(event, INBOUND_REJECTION_REASONS.encrypted);
    }
    if (record.type !== "m.room.message" || isStateEvent(record)) {
      return this.#reject(event, INBOUND_REJECTION_REASONS.unsupportedEventType);
    }
    if (!isValidMatrixEventId(record.eventId)) {
      return this.#reject(event, INBOUND_REJECTION_REASONS.invalidEventId);
    }
    if (!isRecord(record.content)) {
      return this.#reject(event, INBOUND_REJECTION_REASONS.invalidContent);
    }

    const content = record.content;
    if (
      !hasOwn(content, "msgtype") ||
      content.msgtype !== "m.text" ||
      !hasOwn(content, "body") ||
      typeof content.body !== "string"
    ) {
      return this.#reject(event, INBOUND_REJECTION_REASONS.invalidContent);
    }

    const relation = relationFromContent(content, this.#options.responseMode);
    if (!relation.valid) {
      return this.#reject(event, INBOUND_REJECTION_REASONS.invalidRelation);
    }

    // Thread compatibility replies often have m.in_reply_to without a quoted
    // fallback. Require the Matrix sender envelope before removing quote lines;
    // otherwise ordinary Markdown blockquotes would be lost. Room replies keep
    // their established normalization behavior.
    const hasReplyFallback =
      relation.inReplyTo !== undefined &&
      (relation.threadRootEventId === undefined || /^> (?:\* )?<@[^\s<>]+:[^\s<>]+>/u.test(content.body));
    const body = hasReplyFallback ? stripReplyFallback(content.body) : content.body;
    const routing: NormalizedInboundRouting = {
      roomId: record.roomId,
      eventId: record.eventId,
      sender: record.sender,
      ...(relation.inReplyTo === undefined ? {} : { inReplyTo: relation.inReplyTo }),
      ...(relation.threadRootEventId === undefined ? {} : { threadRootEventId: relation.threadRootEventId }),
    };
    if (body.trim().length === 0) {
      return this.#reject(event, INBOUND_REJECTION_REASONS.emptyBody);
    }
    if (utf8ByteLength(body) > this.#options.maxInputBytes) {
      this.#diagnose(event, INBOUND_REJECTION_REASONS.oversized);
      return {
        accepted: false,
        kind: "oversized",
        reason: INBOUND_REJECTION_REASONS.oversized,
        routing,
        response: {
          kind: "oversized",
          text: OVERSIZED_RESPONSE_TEXT,
        },
      };
    }

    const normalized: NormalizedInboundEvent = { ...routing, body };
    return { accepted: true, kind: "accepted", event: normalized };
  }

  #reject(event: unknown, reason: Exclude<InboundRejectionReason, "oversized">): RejectedInboundDecision {
    this.#diagnose(event, reason);
    return { accepted: false, kind: "rejected", reason };
  }

  #diagnose(event: unknown, reason: InboundRejectionReason): void {
    this.#diagnostics?.warn("inbound-rejected", diagnosticFieldsFor(event, reason));
  }
}

export function createInboundAuthorizer(options: InboundAuthorizationConfig): InboundAuthorizer {
  return new InboundAuthorizer(options);
}

export { isValidMatrixEventId } from "./matrix-validation.js";
