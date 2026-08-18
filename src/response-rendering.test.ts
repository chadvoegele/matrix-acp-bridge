import assert from "node:assert/strict";
import test from "node:test";

import {
  computeMatrixTransactionId,
  joinTextAndStatus,
  OUTPUT_TRUNCATION_MARKER,
  renderMatrixResponse,
  RESPONSE_TEXT,
  splitMatrixResponseText,
  truncateAgentText,
} from "./response-rendering.js";
import type { RenderableResponse } from "./response-rendering.js";
import type { RenderedMatrixPart } from "./response-rendering.js";

const ROOM_ID = "!room:example.org";
const EVENT_ID = "$event:example.org";
const LIMITS = {
  maxOutputBytes: 256,
  maxMatrixMessageBytes: 128,
};

function render(
  outcome: RenderableResponse,
  limits: typeof LIMITS = LIMITS,
): RenderedMatrixPart[] {
  return renderMatrixResponse({
    roomId: ROOM_ID,
    inboundEventId: EVENT_ID,
    outcome,
    ...limits,
  });
}

void test("renders every response kind with exact fallback and status text", () => {
  const cases: Array<[
    RenderableResponse,
    string,
    string,
  ]> = [
    [{ kind: "empty" }, "empty", RESPONSE_TEXT.empty],
    [{ kind: "busy" }, "busy", RESPONSE_TEXT.busy],
    [{ kind: "oversized" }, "oversized", RESPONSE_TEXT.oversized],
    [{ kind: "timeout" }, "timeout", RESPONSE_TEXT.timeout],
    [{ kind: "max_tokens" }, "max_tokens", RESPONSE_TEXT.max_tokens],
    [{ kind: "max_turn_requests" }, "max_turn_requests", RESPONSE_TEXT.max_turn_requests],
    [{ kind: "refusal" }, "refusal", RESPONSE_TEXT.refusal],
    [{ kind: "cancelled" }, "cancelled", RESPONSE_TEXT.cancelled],
    [{ kind: "error" }, "error", RESPONSE_TEXT.error],
  ];

  for (const [outcome, responseKind, body] of cases) {
    const [part] = render(outcome);
    assert.ok(part);
    assert.equal(part.responseKind, responseKind);
    assert.equal(part.partNumber, 1);
    assert.equal(part.partCount, 1);
    assert.deepEqual(part.content, { msgtype: "m.text", body });
    assert.equal(
      part.transactionId,
      computeMatrixTransactionId({
        roomId: ROOM_ID,
        inboundEventId: EVENT_ID,
        responseKind: responseKind as RenderedMatrixPart["responseKind"],
        oneBasedPartNumber: 1,
      }),
    );
  }

  const successful = render({ kind: "turn", stopReason: "end_turn", text: "answer" });
  assert.equal(successful[0]?.responseKind, "agent");
  assert.equal(successful[0]?.content.body, "answer");

  const emptyTurn = render({ kind: "turn", stopReason: "end_turn" });
  assert.equal(emptyTurn[0]?.responseKind, "empty");
  assert.equal(emptyTurn[0]?.content.body, RESPONSE_TEXT.empty);

  const methodError = render({ kind: "method_error", operation: "session_prompt", fatal: false });
  assert.equal(methodError[0]?.responseKind, "error");
  assert.equal(methodError[0]?.content.body, RESPONSE_TEXT.error);
});

void test("joins non-end stop status after agent text and keeps status outside the output limit", () => {
  const partial = "partial output";
  const response = render({
    kind: "turn",
    stopReason: "max_tokens",
    text: partial,
  });
  assert.equal(
    response[0]?.content.body,
    joinTextAndStatus(partial, RESPONSE_TEXT.max_tokens),
  );

  const markerBytes = Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, "utf8");
  const maxOutputBytes = markerBytes + 3;
  const truncated = render(
    {
      kind: "turn",
      stopReason: "max_turn_requests",
      text: "aé🙂x".repeat(10),
    },
    { maxOutputBytes, maxMatrixMessageBytes: 128 },
  );
  assert.equal(
    truncated[0]?.content.body,
    `aé${OUTPUT_TRUNCATION_MARKER}\n\n${RESPONSE_TEXT.max_turn_requests}`,
  );
  assert.equal(
    Buffer.byteLength(`aé${OUTPUT_TRUNCATION_MARKER}`, "utf8"),
    maxOutputBytes,
  );
});

void test("truncates only at valid UTF-8 code-point boundaries", () => {
  const markerBytes = Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, "utf8");
  const maxOutputBytes = markerBytes + 3;
  const result = truncateAgentText("aé🙂x".repeat(5), maxOutputBytes);

  assert.equal(result, `aé${OUTPUT_TRUNCATION_MARKER}`);
  assert.equal(Buffer.byteLength(result, "utf8"), maxOutputBytes);
  assert.equal(Buffer.from(result, "utf8").toString("utf8"), result);
});

function removePrefix(body: string): string {
  return body.replace(/^\[\d+\/\d+\]\n/u, "");
}

function assertBoundedAndReconstruct(parts: readonly RenderedMatrixPart[], original: string, maxBytes: number): void {
  assert.ok(parts.length > 1);
  assert.equal(parts.every((part) => Buffer.byteLength(part.content.body, "utf8") <= maxBytes), true);
  assert.equal(parts.map((part) => removePrefix(part.content.body)).join(""), original);
  assert.equal(new Set(parts.map((part) => part.partCount)).size, 1);
  assert.deepEqual(
    parts.map((part) => part.partNumber),
    parts.map((_, index) => index + 1),
  );
}

void test("prefers the last fitting paragraph boundary, then a line boundary", () => {
  const paragraphText = "one\n\ntwo\nthree\nfour";
  const paragraphParts = splitMatrixResponseText(paragraphText, 14);
  assert.equal(removePrefix(paragraphParts[0]!), "one\n\n");
  assertBoundedAndReconstruct(
    paragraphParts.map((body, index) => ({
      roomId: ROOM_ID,
      inboundEventId: EVENT_ID,
      responseKind: "agent" as const,
      partNumber: index + 1,
      partCount: paragraphParts.length,
      transactionId: "unused",
      content: { msgtype: "m.text" as const, body },
    })),
    paragraphText,
    14,
  );

  const lineText = "one\ntwo\nthree";
  const lineParts = splitMatrixResponseText(lineText, 10);
  assert.equal(removePrefix(lineParts[0]!), "one\n");
  assertBoundedAndReconstruct(
    lineParts.map((body, index) => ({
      roomId: ROOM_ID,
      inboundEventId: EVENT_ID,
      responseKind: "agent" as const,
      partNumber: index + 1,
      partCount: lineParts.length,
      transactionId: "unused",
      content: { msgtype: "m.text" as const, body },
    })),
    lineText,
    10,
  );
});

void test("uses extended grapheme boundaries and falls back to code points for an oversized grapheme", () => {
  const combiningText = "e\u0301e\u0301ZZZZ";
  const combiningParts = splitMatrixResponseText(combiningText, 9);
  assert.equal(removePrefix(combiningParts[0]!), "e\u0301");
  assertBoundedAndReconstruct(
    combiningParts.map((body, index) => ({
      roomId: ROOM_ID,
      inboundEventId: EVENT_ID,
      responseKind: "agent" as const,
      partNumber: index + 1,
      partCount: combiningParts.length,
      transactionId: "unused",
      content: { msgtype: "m.text" as const, body },
    })),
    combiningText,
    9,
  );

  const emojiText = "👩‍💻👩‍💻X";
  const emojiParts = splitMatrixResponseText(emojiText, 17);
  assert.equal(removePrefix(emojiParts[0]!), "👩‍💻");
  assertBoundedAndReconstruct(
    emojiParts.map((body, index) => ({
      roomId: ROOM_ID,
      inboundEventId: EVENT_ID,
      responseKind: "agent" as const,
      partNumber: index + 1,
      partCount: emojiParts.length,
      transactionId: "unused",
      content: { msgtype: "m.text" as const, body },
    })),
    emojiText,
    17,
  );

  const oversizedGrapheme = "👨‍👩‍👧x";
  const codePointParts = splitMatrixResponseText(oversizedGrapheme, 10);
  assert.equal(removePrefix(codePointParts[0]!), "👨");
  assertBoundedAndReconstruct(
    codePointParts.map((body, index) => ({
      roomId: ROOM_ID,
      inboundEventId: EVENT_ID,
      responseKind: "agent" as const,
      partNumber: index + 1,
      partCount: codePointParts.length,
      transactionId: "unused",
      content: { msgtype: "m.text" as const, body },
    })),
    oversizedGrapheme,
    10,
  );
});

void test("iterates when prefixes change the part count and emits relation-free Matrix text", () => {
  const value = "x".repeat(11);
  const parts = render(
    { kind: "agent", text: value },
    { maxOutputBytes: 64, maxMatrixMessageBytes: 10 },
  );
  assert.equal(parts.length, 3);
  assertBoundedAndReconstruct(parts, value, 10);
  assert.equal(parts[0]?.content.msgtype, "m.text");
  for (const part of parts) {
    assert.deepEqual(Object.keys(part.content).sort(), ["body", "msgtype"]);
    assert.equal(part.transactionId.startsWith("mab1_"), true);
  }
});

void test("uses the canonical JSON tuple for deterministic transaction IDs", () => {
  assert.equal(
    computeMatrixTransactionId({
      roomId: ROOM_ID,
      inboundEventId: EVENT_ID,
      responseKind: "agent",
      oneBasedPartNumber: 1,
    }),
    "mab1_AUyQeJqh_xKho8-ZzxDfnikDgu-XUqt8e_3j8IHRsTE",
  );
  assert.equal(
    computeMatrixTransactionId(ROOM_ID, EVENT_ID, "agent", 1),
    "mab1_AUyQeJqh_xKho8-ZzxDfnikDgu-XUqt8e_3j8IHRsTE",
  );
});
