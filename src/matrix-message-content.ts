import { MATRIX_HTML_FORMAT } from "./matrix-markdown.js";
import type { ThreadRoutingMetadata } from "./conversation-identity.js";
import { isValidMatrixEventId } from "./matrix-validation.js";

export interface MatrixOutputRouting extends ThreadRoutingMetadata {
  /** A known event in the same thread; defaults to the root when unavailable. */
  readonly threadFallbackEventId?: string;
}

export interface MatrixThreadRelation {
  readonly rel_type: "m.thread";
  readonly event_id: string;
  readonly "m.in_reply_to": { readonly event_id: string };
  readonly is_falling_back: true;
}

export interface MatrixTextMessageContent {
  readonly msgtype: "m.text";
  readonly body: string;
  readonly "m.relates_to"?: MatrixThreadRelation;
}

export interface MatrixHtmlBody {
  readonly body: string;
  readonly formattedBody: string;
}

/** Thread fallbacks are presentation metadata, never a different thread root. */
export function matrixThreadRelation(routing: MatrixOutputRouting): MatrixThreadRelation | undefined {
  const { threadRootEventId, threadFallbackEventId } = routing;
  if (threadRootEventId === undefined) {
    if (threadFallbackEventId !== undefined) throw new TypeError("thread fallback requires a thread root");
    return;
  }
  if (
    !isValidMatrixEventId(threadRootEventId) ||
    (threadFallbackEventId !== undefined && !isValidMatrixEventId(threadFallbackEventId))
  ) {
    throw new TypeError("thread routing requires valid Matrix event IDs");
  }
  return {
    rel_type: "m.thread",
    event_id: threadRootEventId,
    "m.in_reply_to": { event_id: threadFallbackEventId ?? threadRootEventId },
    is_falling_back: true,
  };
}

export function matrixTextContent(body: string, routing: MatrixOutputRouting = {}): MatrixTextMessageContent {
  const relation = matrixThreadRelation(routing);
  return { msgtype: "m.text", body, ...(relation === undefined ? {} : { "m.relates_to": relation }) };
}

/** Build the exact wire content used for both delivery and byte accounting. */
export function matrixHtmlContent(
  message: MatrixHtmlBody & MatrixOutputRouting,
  targetEventId?: string,
): Readonly<Record<string, unknown>> {
  const newContent = {
    ...matrixTextContent(message.body, message),
    format: MATRIX_HTML_FORMAT,
    formatted_body: message.formattedBody,
  } as const;
  return targetEventId === undefined
    ? newContent
    : {
        msgtype: newContent.msgtype,
        body: `* ${message.body}`,
        format: newContent.format,
        formatted_body: `* ${message.formattedBody}`,
        "m.new_content": newContent,
        "m.relates_to": { rel_type: "m.replace", event_id: targetEventId },
      };
}

export function matrixHtmlContentBytes(message: MatrixHtmlBody & MatrixOutputRouting, targetEventId?: string): number {
  return Buffer.byteLength(JSON.stringify(matrixHtmlContent(message, targetEventId)), "utf8");
}

/** Reserve the edit envelope before its target event ID is known. */
export function matrixHtmlEditContentBytes(message: MatrixHtmlBody & MatrixOutputRouting): number {
  return matrixHtmlContentBytes(message, `$${"x".repeat(254)}`);
}
