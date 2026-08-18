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
