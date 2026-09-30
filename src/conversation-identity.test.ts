import assert from "node:assert/strict";
import test from "node:test";

import { conversationIdentityForEvent, conversationKey, type ConversationIdentity } from "./conversation-identity.js";

const roomId = "!room:example.org";

void test("room identity is unchanged by roots and ordinary replies become new thread roots", () => {
  const topLevel = { roomId, eventId: "$top" };
  const followUp = { roomId, eventId: "$follow-up", threadRootEventId: "$top" };
  assert.deepEqual(conversationIdentityForEvent(topLevel, "room"), { kind: "room", roomId });
  assert.deepEqual(conversationIdentityForEvent(followUp, "room"), { kind: "room", roomId });
  assert.deepEqual(conversationIdentityForEvent(topLevel, "thread"), {
    kind: "thread",
    roomId,
    threadRootEventId: "$top",
  });
  assert.deepEqual(conversationIdentityForEvent(followUp, "thread"), conversationIdentityForEvent(topLevel, "thread"));
  const ordinaryReply = { ...topLevel, inReplyTo: { eventId: "$prior" } };
  assert.deepEqual(
    conversationIdentityForEvent(ordinaryReply, "thread"),
    conversationIdentityForEvent(topLevel, "thread"),
  );
});

void test("conversation keys distinguish mode, rooms, roots and opaque delimiter content", () => {
  const identities: ConversationIdentity[] = [
    { kind: "room", roomId },
    { kind: "thread", roomId, threadRootEventId: "$one" },
    { kind: "thread", roomId, threadRootEventId: "$two" },
    { kind: "thread", roomId: "!other:example.org", threadRootEventId: "$one" },
    { kind: "thread", roomId: "!a|$b:example.org", threadRootEventId: "$c" },
    { kind: "thread", roomId: "!a", threadRootEventId: "$b:example.org|$c" },
    { kind: "thread", roomId, threadRootEventId: '$opaque|:["\\' },
  ];
  assert.equal(new Set(identities.map((identity) => conversationKey(identity))).size, identities.length);
  const identity = identities[1]!;
  assert.equal(conversationKey(identity), conversationKey({ ...identity }));
});
