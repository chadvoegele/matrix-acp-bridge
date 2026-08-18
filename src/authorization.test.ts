import assert from "node:assert/strict";
import test from "node:test";

import {
  createInboundAuthorizer,
  INBOUND_REJECTION_REASONS,
  OVERSIZED_RESPONSE_TEXT,
  stripReplyFallback,
  type InboundAuthorizationDecision,
} from "./authorization.js";
import { StderrDiagnosticSink } from "./diagnostics.js";
import type { InboundMatrixEvent } from "./matrix-client.js";
import { FakeClock } from "./test-support/fake-clock.js";

const ROOM_ID = "!allowed:example.org";
const OTHER_ROOM_ID = "!other:example.org";
const ALICE = "@alice:example.org";
const BOB = "@bob:example.org";
const BRIDGE = "@bridge:example.org";

function makeEvent(
  overrides: Partial<InboundMatrixEvent> = {},
): InboundMatrixEvent {
  return {
    roomId: ROOM_ID,
    eventId: "$event:example.org",
    sender: ALICE,
    type: "m.room.message",
    content: { msgtype: "m.text", body: "hello" },
    isLive: true,
    isRedacted: false,
    ...overrides,
  };
}

function options(
  overrides: Partial<Parameters<typeof createInboundAuthorizer>[0]> = {},
) {
  return {
    allowedRooms: [ROOM_ID],
    allowedSenders: [ALICE, BOB],
    bridgeUserId: BRIDGE,
    maxInputBytes: 16_384,
    ...overrides,
  };
}

function authorizeInboundEvent(
  event: InboundMatrixEvent,
  authorizationOptions: Parameters<typeof createInboundAuthorizer>[0],
): InboundAuthorizationDecision {
  return createInboundAuthorizer(authorizationOptions).authorize(event);
}

function reasonOf(decision: InboundAuthorizationDecision): string {
  assert.equal(decision.accepted, false);
  return decision.reason;
}

void test("accepts exact room/sender text and preserves the body exactly", () => {
  const body = "  hello\nworld  ";
  const decision = authorizeInboundEvent(
    makeEvent({ content: { msgtype: "m.text", body } }),
    options(),
  );

  assert.equal(decision.accepted, true);
  assert.deepEqual(decision.event, {
    roomId: ROOM_ID,
    eventId: "$event:example.org",
    sender: ALICE,
    body,
  });
});

void test("uses one global sender allowlist and excludes the bridge identity", () => {
  assert.equal(
    reasonOf(
      authorizeInboundEvent(
        makeEvent({ roomId: OTHER_ROOM_ID }),
        options(),
      ),
    ),
    INBOUND_REJECTION_REASONS.roomNotAllowed,
  );
  assert.equal(
    reasonOf(
      authorizeInboundEvent(
        makeEvent({ sender: "@mallory:example.org" }),
        options(),
      ),
    ),
    INBOUND_REJECTION_REASONS.senderNotAllowed,
  );
  assert.equal(
    reasonOf(
      authorizeInboundEvent(
        makeEvent({ sender: BRIDGE }),
        options({ allowedSenders: [ALICE, BRIDGE] }),
      ),
    ),
    INBOUND_REJECTION_REASONS.selfEvent,
  );
});

void test("rejects history, redacted, encrypted, state, and unsupported events", () => {
  const cases: Array<[Partial<InboundMatrixEvent>, string]> = [
    [{ isLive: false }, INBOUND_REJECTION_REASONS.notLive],
    [{ isRedacted: true }, INBOUND_REJECTION_REASONS.redacted],
    [{ isPlaintext: false }, INBOUND_REJECTION_REASONS.encrypted],
    [{ isEncrypted: true }, INBOUND_REJECTION_REASONS.encrypted],
    [{ isDecrypted: false }, INBOUND_REJECTION_REASONS.encrypted],
    [{ stateKey: "" }, INBOUND_REJECTION_REASONS.unsupportedEventType],
    [{ type: "m.room.member" }, INBOUND_REJECTION_REASONS.unsupportedEventType],
    [{ type: "m.reaction" }, INBOUND_REJECTION_REASONS.unsupportedEventType],
    [{ type: "com.example.custom" }, INBOUND_REJECTION_REASONS.unsupportedEventType],
  ];

  for (const [overrides, expectedReason] of cases) {
    assert.equal(reasonOf(authorizeInboundEvent(makeEvent(overrides), options())), expectedReason);
  }
});

void test("applies ordinary policy to authenticated clear content from required encryption", () => {
  const decision = authorizeInboundEvent(
    makeEvent({
      isPlaintext: false,
      isEncrypted: true,
      isDecrypted: true,
      content: { msgtype: "m.text", body: "clear after Rust decrypt" },
    }),
    options({ encryption: "required" }),
  );

  assert.deepEqual(decision, {
    accepted: true,
    kind: "accepted",
    event: {
      roomId: ROOM_ID,
      eventId: "$event:example.org",
      sender: ALICE,
      body: "clear after Rust decrypt",
    },
  });
});

void test("requires a live m.text event with a string body", () => {
  const invalidContents: Readonly<Record<string, unknown>>[] = [
    {},
    { msgtype: "m.notice", body: "hello" },
    { msgtype: "m.emote", body: "hello" },
    { msgtype: "m.text", body: 123 },
    { msgtype: "m.text", body: null },
  ];

  for (const content of invalidContents) {
    assert.equal(
      reasonOf(authorizeInboundEvent(makeEvent({ content }), options())),
      INBOUND_REJECTION_REASONS.invalidContent,
    );
  }
});

void test("rejects malformed event IDs and accepts historical and modern opaque IDs", () => {
  const invalidIds: Array<string | undefined> = [
    undefined,
    "event-without-sigil",
    "$",
    "$event with spaces",
    "$event\nwith-line-break",
    `$${"x".repeat(255)}`,
  ];
  for (const eventId of invalidIds) {
    const event = eventId === undefined
      ? (() => {
          const missingEventId = makeEvent();
          delete (missingEventId as { eventId?: string }).eventId;
          return missingEventId;
        })()
      : makeEvent({ eventId });
    assert.equal(
      reasonOf(authorizeInboundEvent(event, options())),
      INBOUND_REJECTION_REASONS.invalidEventId,
    );
  }

  for (const eventId of ["$opaque:example.org", "$base64/_-opaque"]) {
    const decision = authorizeInboundEvent(makeEvent({ eventId }), options());
    assert.equal(decision.accepted, true);
    assert.equal(decision.event.eventId, eventId);
  }
});

void test("accepts only the exact in-reply-to relation shape", () => {
  const valid = authorizeInboundEvent(
    makeEvent({
      content: {
        msgtype: "m.text",
        body: "> <@bob:example.org> quoted\n> second line\n\n  reply  \n",
        "m.relates_to": {
          "m.in_reply_to": { event_id: "$quoted:example.org" },
        },
      },
    }),
    options(),
  );
  assert.equal(valid.accepted, true);
  assert.deepEqual(valid.event.inReplyTo, { eventId: "$quoted:example.org" });
  assert.equal(valid.event.body, "  reply  \n");

  const malformedRelations: unknown[] = [
    { "m.replace": { event_id: "$old:example.org" } },
    { "m.thread": { event_id: "$thread:example.org" } },
    {
      "m.in_reply_to": { event_id: "$quoted:example.org" },
      rel_type: "m.thread",
    },
    { "m.in_reply_to": { event_id: "$quoted:example.org", extra: true } },
    { "m.in_reply_to": { event_id: "not-an-event-id" } },
    { "m.in_reply_to": "not-an-object" },
    null,
    [],
    undefined,
  ];
  for (const relation of malformedRelations) {
    assert.equal(
      reasonOf(
        authorizeInboundEvent(
          makeEvent({ content: { msgtype: "m.text", body: "hello", "m.relates_to": relation } }),
          options(),
        ),
      ),
      INBOUND_REJECTION_REASONS.invalidRelation,
    );
  }
});

void test("strips only the leading plain-text reply fallback", () => {
  assert.equal(
    stripReplyFallback("> quoted\n> second\n\nreply"),
    "reply",
  );
  assert.equal(stripReplyFallback("> quoted\nreply"), "reply");
  assert.equal(stripReplyFallback("> quoted\n\n\nreply"), "\nreply");
  assert.equal(stripReplyFallback("  > not a fallback\nreply"), "  > not a fallback\nreply");

  const relationFree = authorizeInboundEvent(
    makeEvent({ content: { msgtype: "m.text", body: "> quote\n\nreply" } }),
    options(),
  );
  assert.equal(relationFree.accepted, true);
  assert.equal(relationFree.event.body, "> quote\n\nreply");
});

void test("rejects empty normalized text and measures UTF-8 bytes after stripping", () => {
  for (const body of ["", " \t\n"]) {
    assert.equal(
      reasonOf(authorizeInboundEvent(makeEvent({ content: { msgtype: "m.text", body } }), options())),
      INBOUND_REJECTION_REASONS.emptyBody,
    );
  }
  assert.equal(
    reasonOf(
      authorizeInboundEvent(
        makeEvent({
          content: {
            msgtype: "m.text",
            body: "> quote\n\n \t",
            "m.relates_to": {
              "m.in_reply_to": { event_id: "$quoted:example.org" },
            },
          },
        }),
        options(),
      ),
    ),
    INBOUND_REJECTION_REASONS.emptyBody,
  );

  const twoBytes = authorizeInboundEvent(
    makeEvent({ content: { msgtype: "m.text", body: "é" } }),
    options({ maxInputBytes: 2 }),
  );
  assert.equal(twoBytes.accepted, true);

  const oversized = authorizeInboundEvent(
    makeEvent({ content: { msgtype: "m.text", body: "> very long quote\n\né" } }),
    options({ maxInputBytes: 1 }),
  );
  assert.equal(oversized.accepted, false);
  assert.equal(oversized.kind, "oversized");
  assert.equal(oversized.response.text, OVERSIZED_RESPONSE_TEXT);
});

void test("diagnostics contain only metadata and report suppressed counts", () => {
  const lines: string[] = [];
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const diagnostics = new StderrDiagnosticSink({
    clock,
    writeLine: (line) => lines.push(line),
  });
  const authorizer = createInboundAuthorizer(options({ diagnostics, clock }));

  const invalid = makeEvent({
    content: { msgtype: "m.text", body: "do-not-log-this-secret" },
    sender: "@mallory:example.org",
  });
  for (let index = 0; index < 7; index += 1) {
    authorizer.authorize(invalid);
  }
  assert.equal(lines.length, 5);

  clock.advanceBy(60_000);
  authorizer.authorize(invalid);
  assert.equal(lines.length, 6);

  const records = lines.map((line) => JSON.parse(line) as { fields: Record<string, unknown> });
  assert.deepEqual(records[5]!.fields, {
    eventId: "$event:example.org",
    reason: INBOUND_REJECTION_REASONS.senderNotAllowed,
    roomId: ROOM_ID,
    sender: "@mallory:example.org",
    suppressedCount: 2,
  });
  const serialized = lines.join("\n");
  assert.doesNotMatch(serialized, /do-not-log-this-secret/u);
  assert.doesNotMatch(serialized, /m\.text/u);
  assert.doesNotMatch(serialized, /content|token|body/u);
});
