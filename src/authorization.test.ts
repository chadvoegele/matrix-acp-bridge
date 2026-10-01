import assert from "node:assert/strict";
import test from "node:test";

import {
  createInboundAuthorizer,
  INBOUND_REJECTION_REASONS,
  OVERSIZED_RESPONSE_TEXT,
  stripReplyFallback,
  type InboundAuthorizationDecision,
} from "./authorization.js";
import { parseConfigText } from "./config.js";
import { StderrDiagnosticSink } from "./diagnostics.js";
import type { InboundMatrixEvent } from "./matrix-client.js";
import { FakeClock } from "./test-support/fake-clock.js";

const ROOM_ID = "!allowed:example.org";
const OTHER_ROOM_ID = "!other:example.org";
const ALICE = "@alice:example.org";
const BOB = "@bob:example.org";
const BRIDGE = "@bridge:example.org";

function makeEvent(overrides: Partial<InboundMatrixEvent> = {}): InboundMatrixEvent {
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

function options(overrides: Partial<Parameters<typeof createInboundAuthorizer>[0]> = {}) {
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
  const decision = authorizeInboundEvent(makeEvent({ content: { msgtype: "m.text", body } }), options());

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
    reasonOf(authorizeInboundEvent(makeEvent({ roomId: OTHER_ROOM_ID }), options())),
    INBOUND_REJECTION_REASONS.roomNotAllowed,
  );
  assert.equal(
    reasonOf(authorizeInboundEvent(makeEvent({ sender: "@mallory:example.org" }), options())),
    INBOUND_REJECTION_REASONS.senderNotAllowed,
  );
  assert.equal(
    reasonOf(authorizeInboundEvent(makeEvent({ sender: BRIDGE }), options({ allowedSenders: [ALICE, BRIDGE] }))),
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
    const event =
      eventId === undefined
        ? (() => {
            const missingEventId = makeEvent();
            delete (missingEventId as { eventId?: string }).eventId;
            return missingEventId;
          })()
        : makeEvent({ eventId });
    assert.equal(reasonOf(authorizeInboundEvent(event, options())), INBOUND_REJECTION_REASONS.invalidEventId);
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
          makeEvent({
            content: {
              msgtype: "m.text",
              body: "hello",
              "m.relates_to": relation,
            },
          }),
          options(),
        ),
      ),
      INBOUND_REJECTION_REASONS.invalidRelation,
    );
  }
});

void test("strips only the leading plain-text reply fallback", () => {
  assert.equal(stripReplyFallback("> quoted\n> second\n\nreply"), "reply");
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
    makeEvent({
      content: { msgtype: "m.text", body: "> very long quote\n\né" },
    }),
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

function threadEvent(relation: Record<string, unknown> = {}, body = "follow-up"): InboundMatrixEvent {
  return makeEvent({
    content: {
      msgtype: "m.text",
      body,
      "m.relates_to": { rel_type: "m.thread", event_id: "$root:example.org", ...relation },
    },
  });
}

void test("thread relations are opt-in and resolve the root independently of reply targets", () => {
  assert.equal(reasonOf(authorizeInboundEvent(threadEvent(), options())), INBOUND_REJECTION_REASONS.invalidRelation);
  assert.equal(
    reasonOf(authorizeInboundEvent(threadEvent(), options({ responseMode: "room" }))),
    INBOUND_REJECTION_REASONS.invalidRelation,
  );
  for (const sender of [ALICE, BOB]) {
    for (const flag of [undefined, false, true]) {
      for (const reply of [undefined, { event_id: "$later:example.org" }]) {
        const relation = {
          ...(flag === undefined ? {} : { is_falling_back: flag }),
          ...(reply === undefined ? {} : { "m.in_reply_to": reply }),
        };
        const decision = authorizeInboundEvent(
          { ...threadEvent(relation), sender },
          options({ responseMode: "thread" }),
        );
        assert.equal(decision.accepted, true);
        assert.equal(decision.event.threadRootEventId, "$root:example.org");
        assert.deepEqual(decision.event.inReplyTo, reply === undefined ? undefined : { eventId: "$later:example.org" });
      }
    }
  }
});

void test("thread validation rejects malformed IDs, field types, edits and unsupported shapes", () => {
  const invalid: unknown[] = [
    { rel_type: "m.thread" },
    { event_id: "$root" },
    { rel_type: "m.replace", event_id: "$root" },
    { rel_type: "m.annotation", event_id: "$root", key: "a" },
    { "m.thread": { event_id: "$root" } },
    { rel_type: "m.thread", event_id: "$root", extra: true },
    null,
    [],
    undefined,
  ];
  for (const eventId of [undefined, null, 123, "root", "$", "$bad id", "$bad\n", `$${"é".repeat(128)}`]) {
    invalid.push({ rel_type: "m.thread", event_id: eventId });
  }
  for (const flag of [undefined, null, "true", 1, [], {}]) {
    invalid.push({ rel_type: "m.thread", event_id: "$root", is_falling_back: flag });
  }
  for (const reply of [undefined, null, [], {}, { event_id: "$" }, { event_id: 1 }, { event_id: "$ok", extra: true }]) {
    invalid.push({ rel_type: "m.thread", event_id: "$root", "m.in_reply_to": reply });
  }
  for (const relation of invalid) {
    assert.equal(
      reasonOf(
        authorizeInboundEvent(
          makeEvent({
            content: { msgtype: "m.text", body: "hello", "m.relates_to": relation },
          }),
          options({ responseMode: "thread" }),
        ),
      ),
      INBOUND_REJECTION_REASONS.invalidRelation,
    );
  }
  for (const eventId of ["$historical:example.org", "$modern/_-opaque"]) {
    const decision = authorizeInboundEvent(threadEvent({ event_id: eventId }), options({ responseMode: "thread" }));
    assert.equal(decision.accepted, true);
    assert.equal(decision.event.threadRootEventId, eventId);
  }
});

void test("thread bodies strip reply fallbacks only when a validated reply is present", () => {
  const quoted = "> <@bob:example.org> quoted\r\n> second line\r\n\r\n  reply  \r\n";
  for (const flag of [undefined, false, true]) {
    const flags = flag === undefined ? {} : { is_falling_back: flag };
    const ordinaryQuote = authorizeInboundEvent(threadEvent(flags, quoted), options({ responseMode: "thread" }));
    assert.equal(ordinaryQuote.accepted, true);
    assert.equal(ordinaryQuote.event.body, quoted);
    const reply = authorizeInboundEvent(
      threadEvent({ ...flags, "m.in_reply_to": { event_id: "$later" } }, quoted),
      options({ responseMode: "thread" }),
    );
    assert.equal(reply.accepted, true);
    assert.equal(reply.event.body, "  reply  \r\n");
  }
  const ordinaryReply = authorizeInboundEvent(
    makeEvent({
      content: { msgtype: "m.text", body: quoted, "m.relates_to": { "m.in_reply_to": { event_id: "$later" } } },
    }),
    options({ responseMode: "thread" }),
  );
  assert.equal(ordinaryReply.accepted, true);
  assert.equal(ordinaryReply.event.threadRootEventId, undefined);
  assert.equal(ordinaryReply.event.body, "  reply  \r\n");
});

void test("thread compatibility and explicit replies preserve ordinary Markdown quotes", () => {
  for (const flag of [undefined, false, true]) {
    for (const body of ["> quoted text", "> quoted text\n\nDiscuss the quote", "> quoted\n> another line\n\n/reset"]) {
      const decision = authorizeInboundEvent(
        threadEvent(
          { ...(flag === undefined ? {} : { is_falling_back: flag }), "m.in_reply_to": { event_id: "$later" } },
          body,
        ),
        options({ responseMode: "thread" }),
      );
      assert.equal(decision.accepted, true);
      assert.equal(decision.event.body, body);
    }
  }
  const emoteFallback = authorizeInboundEvent(
    threadEvent({ "m.in_reply_to": { event_id: "$later" } }, "> * <@bob:example.org> waves\n\nHello"),
    options({ responseMode: "thread" }),
  );
  assert.equal(emoteFallback.accepted, true);
  assert.equal(emoteFallback.event.body, "Hello");
});

void test("oversized decisions expose only authorized validated routing", () => {
  const authorizer = createInboundAuthorizer(options({ responseMode: "thread", maxInputBytes: 2 }));
  for (const event of [threadEvent({}, "large"), makeEvent({ content: { msgtype: "m.text", body: "large" } })]) {
    const decision = authorizer.authorize(event);
    assert.equal(decision.kind, "oversized");
    assert.equal(decision.routing.roomId, ROOM_ID);
    assert.equal(decision.routing.eventId, "$event:example.org");
    assert.equal(
      decision.routing.threadRootEventId,
      event.content?.["m.relates_to"] === undefined ? undefined : "$root:example.org",
    );
    assert.equal("body" in decision.routing, false);
  }
  const normalized = authorizer.authorize(
    threadEvent(
      { "m.in_reply_to": { event_id: "$later" }, is_falling_back: true },
      "> <@bob:example.org> long fallback\n\né",
    ),
  );
  assert.equal(normalized.accepted, true);
  for (const overrides of [
    { sender: "@mallory:example.org" },
    { sender: BRIDGE },
    { roomId: OTHER_ROOM_ID },
    { isRedacted: true },
    { isLive: false },
    { type: "m.room.redaction" },
  ]) {
    const decision = authorizer.authorize({ ...threadEvent({}, "large"), ...overrides });
    assert.equal(decision.kind, "rejected");
    assert.equal("routing" in decision, false);
    assert.equal("response" in decision, false);
  }
});

void test("authorizer reads response mode from bridge configuration and rejects invalid modes", () => {
  const config = parseConfigText(`
state_dir = "/tmp/state"
[matrix]
homeserver = "https://matrix.example.org"
user_id = "${BRIDGE}"
device_id = "BRIDGE"
access_token_file = "/tmp/token"
allowed_rooms = ["${ROOM_ID}"]
allowed_senders = ["${ALICE}"]
encryption = "disabled"
response_mode = "thread"
[acp]
cwd = "/tmp"
`);
  assert.equal(createInboundAuthorizer(config).authorize(threadEvent()).accepted, true);
  assert.throws(() => createInboundAuthorizer(options({ responseMode: "invalid" as "room" })), /responseMode/u);
});
