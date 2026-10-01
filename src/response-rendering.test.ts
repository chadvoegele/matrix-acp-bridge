import assert from "node:assert/strict";
import test from "node:test";

import { matrixHtmlContentBytes } from "./matrix-message-content.js";
import { renderMatrixText } from "./matrix-text-rendering.js";

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

function render(outcome: RenderableResponse, limits: typeof LIMITS = LIMITS): RenderedMatrixPart[] {
  return renderMatrixResponse({
    roomId: ROOM_ID,
    inboundEventId: EVENT_ID,
    outcome,
    ...limits,
  });
}

void test("renders every response kind with exact fallback and status text", () => {
  const cases: Array<[RenderableResponse, string, string]> = [
    [{ kind: "empty" }, "empty", RESPONSE_TEXT.empty],
    [{ kind: "busy" }, "busy", RESPONSE_TEXT.busy],
    [{ kind: "oversized" }, "oversized", RESPONSE_TEXT.oversized],
    [{ kind: "reset" }, "reset", RESPONSE_TEXT.reset],
    [{ kind: "unknown_thread" }, "unknown_thread", RESPONSE_TEXT.unknown_thread],
    [{ kind: "thread_reset_guidance" }, "thread_reset_guidance", RESPONSE_TEXT.thread_reset_guidance],
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

  const successful = render({
    kind: "turn",
    stopReason: "end_turn",
    text: "answer",
  });
  assert.equal(successful[0]?.responseKind, "agent");
  assert.equal(successful[0]?.content.body, "answer");

  const emptyTurn = render({ kind: "turn", stopReason: "end_turn" });
  assert.equal(emptyTurn[0]?.responseKind, "empty");
  assert.equal(emptyTurn[0]?.content.body, RESPONSE_TEXT.empty);

  const methodError = render({
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  assert.equal(methodError[0]?.responseKind, "error");
  assert.equal(methodError[0]?.content.body, RESPONSE_TEXT.error);
});

void test("synthetic descriptors ignore supplied text and reject unknown or inherited response kinds", () => {
  for (const kind of ["empty", "busy", "oversized", "reset", "unknown_thread", "thread_reset_guidance"] as const) {
    assert.equal(render({ kind, text: "must not replace guidance" })[0]?.content.body, RESPONSE_TEXT[kind]);
  }
  for (const kind of ["unsupported", "toString", "constructor", "__proto__"]) {
    assert.throws(() => render({ kind } as RenderableResponse), /unsupported response kind/u);
  }
});

void test("joins non-end stop status after agent text and keeps status outside the output limit", () => {
  const partial = "partial output";
  const response = render({
    kind: "turn",
    stopReason: "max_tokens",
    text: partial,
  });
  assert.equal(response[0]?.content.body, joinTextAndStatus(partial, RESPONSE_TEXT.max_tokens));

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
  assert.equal(truncated[0]?.content.body, `aé${OUTPUT_TRUNCATION_MARKER}\n\n${RESPONSE_TEXT.max_turn_requests}`);
  assert.equal(Buffer.byteLength(`aé${OUTPUT_TRUNCATION_MARKER}`, "utf8"), maxOutputBytes);
});

void test("truncates only at valid UTF-8 code-point boundaries", () => {
  const markerBytes = Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, "utf8");
  const maxOutputBytes = markerBytes + 3;
  const result = truncateAgentText("aé🙂x".repeat(5), maxOutputBytes);

  assert.equal(result, `aé${OUTPUT_TRUNCATION_MARKER}`);
  assert.equal(Buffer.byteLength(result, "utf8"), maxOutputBytes);
  assert.equal(Buffer.from(result, "utf8").toString("utf8"), result);
});

function partPayloadBytes(part: RenderedMatrixPart): number {
  return matrixHtmlContentBytes({
    ...part,
    body: part.content.body,
    formattedBody: part.formattedBody ?? renderMatrixText(part.content.body).formattedBody,
  });
}

function removePrefix(body: string): string {
  return body.replace(/^\[\d+\/\d+\]\n/u, "");
}

function assertBoundedAndReconstruct(parts: readonly RenderedMatrixPart[], original: string, maxBytes: number): void {
  assert.ok(parts.length > 1);
  assert.equal(
    parts.every((part) => Buffer.byteLength(part.content.body, "utf8") <= maxBytes),
    true,
  );
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
  const parts = render({ kind: "agent", text: value }, { maxOutputBytes: 64, maxMatrixMessageBytes: 10 });
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

void test("thread multipart output and retries retain routing and budget the complete Markdown payload", () => {
  const request = {
    roomId: ROOM_ID,
    inboundEventId: EVENT_ID,
    threadRootEventId: "$root",
    threadFallbackEventId: EVENT_ID,
    outcome: { kind: "agent" as const, text: "**<&😀>**\n\n".repeat(100) },
    maxOutputBytes: 10_000,
    maxMatrixMessageBytes: 512,
  };
  const parts = renderMatrixResponse(request);
  assert.ok(parts.length > 1);
  assert.equal(parts.map((part) => removePrefix(part.content.body)).join(""), request.outcome.text);
  for (const part of parts) {
    assert.equal(part.threadRootEventId, "$root");
    assert.equal(part.threadFallbackEventId, EVENT_ID);
    assert.deepEqual(part.content["m.relates_to"], {
      rel_type: "m.thread",
      event_id: "$root",
      "m.in_reply_to": { event_id: EVENT_ID },
      is_falling_back: true,
    });
    assert.ok(partPayloadBytes(part) <= 512);
  }
  assert.deepEqual(renderMatrixResponse(request), parts);
  const ids = new Set(parts.map((part) => part.transactionId));
  for (const alternate of [
    { ...request, roomId: "!different:example.org" },
    { ...request, threadRootEventId: "$different-root" },
    { ...request, outcome: { kind: "cancelled" as const, text: request.outcome.text } },
  ]) {
    assert.equal(
      renderMatrixResponse(alternate).some((part) => ids.has(part.transactionId)),
      false,
    );
  }
});

void test("thread multipart packing keeps a complete link at the exact payload boundary", () => {
  const link = "[" + "a".repeat(378) + "](https://example.org)";
  const text = link + " " + "z".repeat(3000);
  const parts = renderMatrixResponse({
    roomId: ROOM_ID,
    inboundEventId: "$reply",
    threadRootEventId: "$root",
    threadFallbackEventId: "$reply",
    outcome: { kind: "agent", text },
    maxOutputBytes: 10_000,
    maxMatrixMessageBytes: 1043,
  });
  assert.equal(removePrefix(parts[0]!.content.body), link);
  assert.match(parts[0]!.formattedBody!, /<a href="https:\/\/example.org">/u);
  assert.equal(parts.map(({ content }) => removePrefix(content.body)).join(""), text);
  for (const part of parts) assert.ok(partPayloadBytes(part) <= 1043);
  assert.deepEqual(
    renderMatrixResponse({
      roomId: ROOM_ID,
      inboundEventId: "$reply",
      threadRootEventId: "$root",
      threadFallbackEventId: "$reply",
      outcome: { kind: "agent", text },
      maxOutputBytes: 10_000,
      maxMatrixMessageBytes: 1043,
    }),
    parts,
  );
});

void test("multipart labels do not turn intact indented code blocks into paragraphs", () => {
  const text = "Before.\n\n    code <one>\n    code <two>\n\n" + "Following paragraph.\n\n".repeat(30);
  const parts = renderMatrixResponse({
    roomId: ROOM_ID,
    inboundEventId: EVENT_ID,
    threadRootEventId: "$root",
    outcome: { kind: "agent", text },
    maxOutputBytes: 4096,
    maxMatrixMessageBytes: 512,
  });
  assert.ok(parts.length > 1);
  assert.ok(parts.some(({ formattedBody }) => formattedBody?.includes("<pre><code>code &lt;one&gt;")));
  assert.equal(parts.map(({ content }) => removePrefix(content.body)).join(""), text);
  for (const part of parts) {
    assert.ok(matrixHtmlContentBytes({ ...part, body: part.content.body, formattedBody: part.formattedBody! }) <= 512);
  }
});

void test("thread response exact payload limits include JSON escaping, HTML and relations", () => {
  const routing = { threadRootEventId: `$${"r".repeat(254)}`, threadFallbackEventId: "$fallback" };
  const text = '<&😀"\\'.repeat(12);
  const exact = matrixHtmlContentBytes({ ...renderMatrixText(text), ...routing });
  const request = {
    roomId: ROOM_ID,
    inboundEventId: EVENT_ID,
    ...routing,
    outcome: { kind: "agent" as const, text },
    maxOutputBytes: 4096,
    maxMatrixMessageBytes: exact,
  };
  assert.equal(renderMatrixResponse(request).length, 1);
  const split = renderMatrixResponse({ ...request, maxMatrixMessageBytes: exact - 1 });
  assert.ok(split.length > 1);
  assert.equal(split.map((part) => removePrefix(part.content.body)).join(""), text);
  for (const part of split) assert.ok(partPayloadBytes(part) < exact);
});

void test("synthetic thread errors and unthreaded reset guidance have exact text and distinct IDs", () => {
  const request = { roomId: ROOM_ID, inboundEventId: EVENT_ID, maxOutputBytes: 256, maxMatrixMessageBytes: 1024 };
  const [unknown] = renderMatrixResponse({
    ...request,
    threadRootEventId: "$unknown",
    outcome: { kind: "unknown_thread" },
  });
  const [guidance] = renderMatrixResponse({ ...request, outcome: { kind: "thread_reset_guidance" } });
  assert.equal(unknown?.content.body, "Unknown thread agent session. Please start a new thread.");
  assert.equal(unknown?.content["m.relates_to"]?.event_id, "$unknown");
  assert.equal(guidance?.content.body, "Use /reset inside a thread to reset its agent session.");
  assert.equal(guidance?.content["m.relates_to"], undefined);
  assert.notEqual(guidance?.transactionId, unknown?.transactionId);
  for (const kind of [
    "empty",
    "busy",
    "oversized",
    "reset",
    "timeout",
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "cancelled",
    "error",
  ] as const) {
    const [part] = renderMatrixResponse({ ...request, threadRootEventId: "$root", outcome: { kind } });
    assert.equal(part?.content.body, RESPONSE_TEXT[kind]);
    assert.equal(part?.content["m.relates_to"]?.event_id, "$root");
  }
});

void test("threading preserves aggregate output truncation and rejects budgets that cannot fit the envelope", () => {
  const request = {
    roomId: ROOM_ID,
    inboundEventId: EVENT_ID,
    threadRootEventId: "$root",
    outcome: { kind: "agent" as const, text: "<&😀".repeat(100) },
    maxOutputBytes: 40,
    maxMatrixMessageBytes: 1024,
  };
  const parts = renderMatrixResponse(request);
  assert.equal(
    parts.map((part) => removePrefix(part.content.body)).join(""),
    truncateAgentText(request.outcome.text, 40),
  );
  assert.ok(parts.at(-1)?.content.body.endsWith(OUTPUT_TRUNCATION_MARKER));
  assert.throws(() => renderMatrixResponse({ ...request, maxMatrixMessageBytes: 64 }), /cannot fit/);
});
