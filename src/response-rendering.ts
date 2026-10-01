import { createHash } from "node:crypto";

import type { MatrixEventId, MatrixRoomId } from "./matrix-client.js";
import type { AcpOutcome, AcpStopReason } from "./acp-client.js";
import { matrixHtmlContentBytes, matrixTextContent, type MatrixOutputRouting } from "./matrix-message-content.js";
import { renderMatrixText } from "./matrix-text-rendering.js";
import type { ThreadRoutingMetadata } from "./conversation-identity.js";
import { utf8ByteLength } from "./text-utils.js";

import type { MatrixTextMessageContent } from "./matrix-message-content.js";

export type MatrixTransactionId = string;

export type { MatrixTextMessageContent } from "./matrix-message-content.js";

export type MatrixResponseKind =
  | "agent"
  | "empty"
  | "busy"
  | "oversized"
  | "reset"
  | "unknown_thread"
  | "thread_reset_guidance"
  | "timeout"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"
  | "error";

export interface RenderedMatrixPart extends MatrixOutputRouting {
  readonly roomId: MatrixRoomId;
  readonly inboundEventId: MatrixEventId;
  readonly responseKind: MatrixResponseKind;
  readonly partNumber: number;
  readonly partCount: number;
  readonly transactionId: MatrixTransactionId;
  readonly content: MatrixTextMessageContent;
}

/** The marker is part of the user-visible response contract. */
export const OUTPUT_TRUNCATION_MARKER = "\n\n[output truncated]" as const;

/** Exact text used for responses that do not have agent output. */
export const RESPONSE_TEXT = {
  empty: "The agent returned no text.",
  busy: "The room queue is full. Try again later.",
  oversized: "Your message is too large.",
  reset: "Agent session reset.",
  unknown_thread: "Unknown thread agent session. Please start a new thread.",
  thread_reset_guidance: "Use /reset inside a thread to reset its agent session.",
  timeout: "[agent timed out]",
  max_tokens: "[agent reached its token limit]",
  max_turn_requests: "[agent reached its turn-request limit]",
  refusal: "[agent refused the request]",
  cancelled: "[agent cancelled the request]",
  error: "[agent error]",
} as const;

export type CollectedAgentText = string | readonly string[];

/** A synthetic outcome used for queue and lifecycle responses. */
export interface MatrixResponseDescriptor {
  readonly kind: MatrixResponseKind;
  readonly text?: CollectedAgentText;
}

export type RenderableResponse = MatrixResponseDescriptor | AcpOutcome;

export interface ResponseRenderLimits {
  readonly maxOutputBytes: number;
  readonly maxMatrixMessageBytes: number;
}

export interface ResponseRenderContext extends ResponseRenderLimits, MatrixOutputRouting {
  readonly roomId: MatrixRoomId;
  readonly inboundEventId: MatrixEventId;
}

export interface RenderMatrixResponseRequest extends ResponseRenderContext {
  readonly outcome: RenderableResponse;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function collectedText(value: CollectedAgentText | undefined): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    throw new TypeError("response text must be a string or an array of strings");
  }
  for (const chunk of value) {
    if (typeof chunk !== "string") {
      throw new TypeError("response text arrays must contain only strings");
    }
  }
  // Chunks are fragments of one agent message.  The blank-line separator is
  // reserved for joining agent text to a stop status, not for stream chunks.
  return value.join("");
}

/** Join agent text and a status using the exact protocol separator. */
export function joinTextAndStatus(text: string, status: string): string {
  if (text.length === 0) {
    return status;
  }
  return `${text}\n\n${status}`;
}

/** Join stream fragments without changing their byte-for-byte content. */
export function joinCollectedText(chunks: readonly string[]): string {
  return collectedText(chunks);
}

function codePointPrefix(value: string, maxBytes: number): string {
  let usedBytes = 0;
  let end = 0;
  for (const codePoint of value) {
    const codePointBytes = utf8ByteLength(codePoint);
    if (usedBytes + codePointBytes > maxBytes) {
      break;
    }
    usedBytes += codePointBytes;
    end += codePoint.length;
  }
  return value.slice(0, end);
}

/**
 * Bound agent output by UTF-8 bytes while keeping a valid code-point prefix.
 * The truncation marker itself is included in the aggregate limit.
 */
export function truncateAgentText(value: string, maxOutputBytes: number): string {
  assertPositiveInteger(maxOutputBytes, "maxOutputBytes");
  const markerBytes = utf8ByteLength(OUTPUT_TRUNCATION_MARKER);
  if (maxOutputBytes < markerBytes) {
    throw new RangeError(`maxOutputBytes must be at least ${markerBytes} bytes for the truncation marker`);
  }
  if (utf8ByteLength(value) <= maxOutputBytes) {
    return value;
  }
  return `${codePointPrefix(value, maxOutputBytes - markerBytes)}${OUTPUT_TRUNCATION_MARKER}`;
}

function lastParagraphBoundary(value: string, start: number, maxEnd: number): number | undefined {
  let last: number | undefined;
  let index = value.indexOf("\n\n", start);
  while (index >= 0) {
    const end = index + 2;
    if (end > maxEnd) {
      break;
    }
    if (end > start) {
      last = end;
    }
    index = value.indexOf("\n\n", index + 1);
  }
  return last;
}

function lastLineBoundary(value: string, start: number, maxEnd: number): number | undefined {
  let last: number | undefined;
  let index = value.indexOf("\n", start);
  while (index >= 0) {
    const end = index + 1;
    if (end > maxEnd) {
      break;
    }
    if (end > start) {
      last = end;
    }
    index = value.indexOf("\n", index + 1);
  }
  return last;
}

function lastGraphemeBoundary(value: string, start: number, maxEnd: number): number | undefined {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const remainder = value.slice(start);
  let last: number | undefined;
  for (const segment of segmenter.segment(remainder)) {
    const end = start + segment.index + segment.segment.length;
    if (end > maxEnd) {
      break;
    }
    if (end > start) {
      last = end;
    }
  }
  return last;
}

function codePointEnd(value: string, start: number, maxBytes: number): number {
  let usedBytes = 0;
  let end = start;
  for (const codePoint of value.slice(start)) {
    const codePointBytes = utf8ByteLength(codePoint);
    if (usedBytes + codePointBytes > maxBytes) {
      break;
    }
    usedBytes += codePointBytes;
    end += codePoint.length;
  }
  return end;
}

function fittingChunkEnd(
  value: string,
  start: number,
  maxBytes: number,
  prefix: string,
  measure: (body: string) => number,
): number {
  let maxCodePointEnd = codePointEnd(value, start, maxBytes - utf8ByteLength(prefix));
  if (measure !== utf8ByteLength) {
    const candidateText = value.slice(start, maxCodePointEnd);
    const characters = [...candidateText];
    let low = 1;
    let high = characters.length;
    let fitting = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (measure(`${prefix}${characters.slice(0, middle).join("")}`) <= maxBytes) {
        fitting = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    maxCodePointEnd = start + characters.slice(0, fitting).join("").length;
  }
  if (maxCodePointEnd === start) {
    throw new RangeError("maxMatrixMessageBytes cannot fit one Unicode code point");
  }

  // Delimiters belong to the preceding part.  Paragraph boundaries have
  // priority even when a later line boundary would fit more text.
  const boundary =
    lastParagraphBoundary(value, start, maxCodePointEnd) ??
    lastLineBoundary(value, start, maxCodePointEnd) ??
    lastGraphemeBoundary(value, start, maxCodePointEnd) ??
    maxCodePointEnd;
  // Markdown formatting may change non-monotonically at a delimiter. Keep
  // the tested prefix if the preferred boundary would exceed the wire budget.
  return measure(`${prefix}${value.slice(start, boundary)}`) <= maxBytes ? boundary : maxCodePointEnd;
}

function splitWithAssumedPartCount(
  value: string,
  maxMatrixMessageBytes: number,
  assumedPartCount: number,
  measure: (body: string) => number,
): string[] {
  const parts: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    const partNumber = parts.length + 1;
    const prefix = `[${partNumber}/${assumedPartCount}]\n`;
    if (measure(prefix) >= maxMatrixMessageBytes) {
      throw new RangeError("maxMatrixMessageBytes cannot fit a multipart prefix");
    }
    const end = fittingChunkEnd(value, offset, maxMatrixMessageBytes, prefix, measure);
    if (end <= offset) {
      throw new Error("multipart splitter failed to make progress");
    }
    parts.push(`${prefix}${value.slice(offset, end)}`);
    offset = end;
  }
  return parts;
}

/**
 * Split a rendered response into bounded Matrix bodies.  Multipart prefixes
 * are solved iteratively because their denominator contributes to capacity.
 */
export function splitMatrixResponseText(
  value: string,
  maxMatrixMessageBytes: number,
  measure: (body: string) => number = utf8ByteLength,
): string[] {
  assertPositiveInteger(maxMatrixMessageBytes, "maxMatrixMessageBytes");
  if (measure(value) <= maxMatrixMessageBytes) {
    return [value];
  }

  let assumedPartCount = Math.max(2, Math.ceil(utf8ByteLength(value) / maxMatrixMessageBytes));
  const seen = new Set<number>();

  // Prefix lengths change only when a part-count or part-number digit count
  // changes, so a fixed point is reached quickly for bounded input.
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (seen.has(assumedPartCount)) {
      break;
    }
    seen.add(assumedPartCount);
    const parts = splitWithAssumedPartCount(value, maxMatrixMessageBytes, assumedPartCount, measure);
    if (parts.length === assumedPartCount) {
      return parts;
    }
    assumedPartCount = parts.length;
  }

  // This is only a defensive fallback for an unusual prefix/count boundary.
  // The number of parts cannot exceed the number of UTF-16 code units in a
  // nonempty value when every prefix can fit at least one code point.
  const upperBound = Math.max(2, value.length);
  for (let candidate = 2; candidate <= upperBound; candidate += 1) {
    const parts = splitWithAssumedPartCount(value, maxMatrixMessageBytes, candidate, measure);
    if (parts.length === candidate) {
      return parts;
    }
  }
  throw new Error("could not stabilize multipart response count");
}

export interface TransactionIdInput extends ThreadRoutingMetadata {
  readonly roomId: MatrixRoomId;
  readonly inboundEventId: MatrixEventId;
  readonly responseKind: MatrixResponseKind;
  readonly oneBasedPartNumber: number;
}

function validateTransactionPartNumber(value: number): void {
  assertPositiveInteger(value, "oneBasedPartNumber");
}

/** Compute the stable Matrix transaction ID for one rendered response part. */
export function computeMatrixTransactionId(input: TransactionIdInput): string;

export function computeMatrixTransactionId(
  roomId: MatrixRoomId,
  inboundEventId: MatrixEventId,
  responseKind: MatrixResponseKind,
  oneBasedPartNumber: number,
): string;

export function computeMatrixTransactionId(
  inputOrRoomId: TransactionIdInput | MatrixRoomId,
  inboundEventId?: MatrixEventId,
  responseKind?: MatrixResponseKind,
  oneBasedPartNumber?: number,
): string {
  const input: TransactionIdInput =
    typeof inputOrRoomId === "string"
      ? {
          roomId: inputOrRoomId,
          inboundEventId: inboundEventId as MatrixEventId,
          responseKind: responseKind as MatrixResponseKind,
          oneBasedPartNumber: oneBasedPartNumber as number,
        }
      : inputOrRoomId;
  if (typeof input.roomId !== "string" || typeof input.inboundEventId !== "string") {
    throw new TypeError("transaction IDs require string room and event IDs");
  }
  validateTransactionPartNumber(input.oneBasedPartNumber);

  const canonicalTuple = [
    "matrix-acp-bridge-txn-v1",
    input.roomId,
    input.inboundEventId,
    input.responseKind,
    input.oneBasedPartNumber,
    ...(input.threadRootEventId === undefined ? [] : [input.threadRootEventId]),
  ];
  const digest = createHash("sha256")
    .update(Buffer.from(JSON.stringify(canonicalTuple), "utf8"))
    .digest("base64url");
  return `mab1_${digest}`;
}

interface NormalizedResponseText {
  readonly responseKind: MatrixResponseKind;
  readonly text: string;
}

function stopReasonKind(stopReason: AcpStopReason): MatrixResponseKind {
  switch (stopReason) {
    case "end_turn": {
      return "agent";
    }
    case "max_tokens": {
      return "max_tokens";
    }
    case "max_turn_requests": {
      return "max_turn_requests";
    }
    case "refusal": {
      return "refusal";
    }
    case "cancelled": {
      return "cancelled";
    }
    case "unknown": {
      return "error";
    }
  }
}

function descriptorFromOutcome(outcome: RenderableResponse): {
  readonly responseKind: MatrixResponseKind;
  readonly agentText: string;
} {
  if (outcome.kind === "turn") {
    return {
      responseKind: stopReasonKind(outcome.stopReason),
      agentText: collectedText(outcome.text),
    };
  }

  if (outcome.kind === "method_error" || outcome.kind === "transport_error" || outcome.kind === "protocol_error") {
    return { responseKind: "error", agentText: "" };
  }

  if (outcome.kind !== "agent" && !Object.hasOwn(RESPONSE_TEXT, outcome.kind)) {
    throw new TypeError(`unsupported response kind: ${String(outcome.kind)}`);
  }

  return {
    responseKind: outcome.kind,
    agentText: collectedText(outcome.text),
  };
}

function normalizeResponseText(outcome: RenderableResponse, maxOutputBytes: number): NormalizedResponseText {
  const descriptor = descriptorFromOutcome(outcome);
  const { responseKind, agentText } = descriptor;

  if (
    responseKind === "empty" ||
    responseKind === "busy" ||
    responseKind === "oversized" ||
    responseKind === "reset" ||
    responseKind === "unknown_thread" ||
    responseKind === "thread_reset_guidance"
  ) {
    return { responseKind, text: RESPONSE_TEXT[responseKind] };
  }

  const boundedAgentText = truncateAgentText(agentText, maxOutputBytes);
  if (responseKind === "agent") {
    return agentText.length === 0
      ? { responseKind: "empty", text: RESPONSE_TEXT.empty }
      : { responseKind, text: boundedAgentText };
  }

  return {
    responseKind,
    text: joinTextAndStatus(boundedAgentText, RESPONSE_TEXT[responseKind]),
  };
}

function renderFromRequest(request: RenderMatrixResponseRequest): RenderedMatrixPart[] {
  if (typeof request.roomId !== "string" || typeof request.inboundEventId !== "string") {
    throw new TypeError("responses require string room and inbound event IDs");
  }
  assertPositiveInteger(request.maxOutputBytes, "maxOutputBytes");
  assertPositiveInteger(request.maxMatrixMessageBytes, "maxMatrixMessageBytes");

  const normalized = normalizeResponseText(request.outcome, request.maxOutputBytes);
  const routing: MatrixOutputRouting = {
    ...(request.threadRootEventId === undefined ? {} : { threadRootEventId: request.threadRootEventId }),
    ...(request.threadFallbackEventId === undefined ? {} : { threadFallbackEventId: request.threadFallbackEventId }),
  };
  // Room mode keeps its established body budget and wire shape. Thread parts
  // include Markdown HTML and relations in their full serialized payload budget.
  const measure =
    request.threadRootEventId === undefined
      ? utf8ByteLength
      : (body: string): number => matrixHtmlContentBytes(renderMatrixText(body, routing));
  const bodies = splitMatrixResponseText(normalized.text, request.maxMatrixMessageBytes, measure);
  const partCount = bodies.length;

  return bodies.map((body, index) => {
    const partNumber = index + 1;
    return {
      ...routing,
      roomId: request.roomId,
      inboundEventId: request.inboundEventId,
      responseKind: normalized.responseKind,
      partNumber,
      partCount,
      transactionId: computeMatrixTransactionId({
        roomId: request.roomId,
        inboundEventId: request.inboundEventId,
        responseKind: normalized.responseKind,
        oneBasedPartNumber: partNumber,
        ...(routing.threadRootEventId === undefined ? {} : { threadRootEventId: routing.threadRootEventId }),
      }),
      content: matrixTextContent(body, routing),
    };
  });
}

export function renderMatrixResponse(request: RenderMatrixResponseRequest): RenderedMatrixPart[];

export function renderMatrixResponse(
  roomId: MatrixRoomId,
  inboundEventId: MatrixEventId,
  outcome: RenderableResponse,
  maxOutputBytes: number,
  maxMatrixMessageBytes: number,
): RenderedMatrixPart[];

export function renderMatrixResponse(outcome: RenderableResponse, context: ResponseRenderContext): RenderedMatrixPart[];

export function renderMatrixResponse(
  requestOrRoomId: RenderMatrixResponseRequest | RenderableResponse | MatrixRoomId,
  inboundEventIdOrContext?: MatrixEventId | ResponseRenderContext,
  outcome?: RenderableResponse,
  maxOutputBytes?: number,
  maxMatrixMessageBytes?: number,
): RenderedMatrixPart[] {
  if (typeof requestOrRoomId !== "string") {
    if (typeof inboundEventIdOrContext === "object" && inboundEventIdOrContext !== null) {
      return renderFromRequest({
        ...inboundEventIdOrContext,
        outcome: requestOrRoomId as RenderableResponse,
      });
    }
    return renderFromRequest(requestOrRoomId as RenderMatrixResponseRequest);
  }
  const inboundEventId = inboundEventIdOrContext as MatrixEventId | undefined;
  if (
    inboundEventId === undefined ||
    outcome === undefined ||
    maxOutputBytes === undefined ||
    maxMatrixMessageBytes === undefined
  ) {
    throw new TypeError("renderMatrixResponse requires room, event, outcome, and limits");
  }
  return renderFromRequest({
    roomId: requestOrRoomId,
    inboundEventId,
    outcome,
    maxOutputBytes,
    maxMatrixMessageBytes,
  });
}
