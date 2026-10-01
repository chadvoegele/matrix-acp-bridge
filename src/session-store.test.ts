import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionStore } from "./session-store.js";

void test("the in-memory session store isolates rooms", () => {
  const store = new InMemorySessionStore();

  store.set({ roomId: "!one:example", sessionId: "session-one" });
  store.set({ roomId: "!two:example", sessionId: "session-two" });

  assert.deepEqual(store.get("!one:example"), {
    roomId: "!one:example",
    sessionId: "session-one",
  });
  assert.deepEqual(store.get("!two:example"), {
    roomId: "!two:example",
    sessionId: "session-two",
  });
  assert.equal(store.get("!missing:example"), undefined);
});

void test("setting a room replaces only that room and entries are a snapshot", () => {
  const store = new InMemorySessionStore();
  store.set({ roomId: "!one:example", sessionId: "old" });
  store.set({ roomId: "!two:example", sessionId: "two" });

  const entries = [...store.entries()];
  store.set({ roomId: "!one:example", sessionId: "new" });

  assert.deepEqual(entries, [
    { roomId: "!one:example", sessionId: "old" },
    { roomId: "!two:example", sessionId: "two" },
  ]);
  assert.deepEqual(store.get("!one:example"), {
    roomId: "!one:example",
    sessionId: "new",
  });
  assert.equal(store.delete("!one:example"), true);
  assert.equal(store.delete("!one:example"), false);
});

void test("clear removes all in-memory state", () => {
  const store = new InMemorySessionStore();
  store.set({ roomId: "!one:example", sessionId: "one" });
  store.clear();

  assert.deepEqual([...store.entries()], []);
});

void test("room and thread records isolate roots and duplicate roots in different rooms", () => {
  const store = new InMemorySessionStore();
  const one = { kind: "thread", roomId: "!one:example", threadRootEventId: "$same" } as const;
  const two = { kind: "thread", roomId: "!two:example", threadRootEventId: "$same" } as const;
  const other = { ...one, threadRootEventId: "$other" };
  store.set({ roomId: one.roomId, sessionId: "room-session" });
  store.setConversationRecord({ ...one, sessionId: "one-session" });
  store.setConversationRecord({ ...two, sessionId: "two-session" });
  store.setConversationRecord(other);
  assert.deepEqual(store.getConversationRecord(one), { ...one, sessionId: "one-session" });
  assert.deepEqual(store.getConversationRecord(two), { ...two, sessionId: "two-session" });
  assert.deepEqual(store.getConversationRecord(other), other);
  assert.deepEqual([...store.entries()], [{ roomId: one.roomId, sessionId: "room-session" }]);
  const before = [...store.conversationEntries()];
  assert.equal(store.resetConversation(one), true);
  assert.deepEqual(store.getConversationRecord(one), one);
  assert.equal(store.resetConversation(one), false);
  assert.equal(store.resetConversation({ ...one, threadRootEventId: "$unknown" }), false);
  assert.equal(store.getConversationRecord({ ...one, threadRootEventId: "$unknown" }), undefined);
  assert.equal(before.length, 4);
  assert.equal(before[1]?.sessionId, "one-session");
  assert.equal(store.delete(one.roomId), true);
  assert.deepEqual(store.getConversationRecord(one), one);
  assert.equal(store.deleteConversation(two), true);
  store.clear();
  assert.deepEqual([...store.conversationEntries()], []);
});
