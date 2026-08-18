import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeEarlyCursorState,
  orderedPlaintextEventIds,
  plaintextSenderEventIds,
} from "../unencrypted-e2e/early-cursor-fixture.mjs";

test("orders only eligible plaintext sender IDs through the held event", () => {
  const events = [
    { event_id: "$ignored", sender: "@other:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "hidden" } },
    { event_id: "$first", sender: "@sender:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "first" } },
    { event_id: "$reply", sender: "@bridge:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "hidden" } },
    { event_id: "$held", sender: "@sender:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "second" } },
    { event_id: "$later", sender: "@sender:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "later" } },
  ];
  assert.deepEqual(
    orderedPlaintextEventIds(events, { senderUserId: "@sender:example.test", heldEventId: "$held" }),
    ["$first", "$held"],
  );
  assert.deepEqual(
    plaintextSenderEventIds(events, { senderUserId: "@sender:example.test" }),
    ["$first", "$held", "$later"],
  );
  assert.equal(orderedPlaintextEventIds(events.slice(0, 3), {
    senderUserId: "@sender:example.test",
    heldEventId: "$held",
  }), undefined);
});

test("normalizes the complete explicit-ID recovery ledger without changing other ledgers", () => {
  const state = {
    schemaVersion: 11,
    identity: { homeserver: "https://matrix.example.test", userId: "@bridge:example.test", deviceId: "DEVICE" },
    cursor: "cursor-after-first",
    committedAtMs: 20,
    sessions: { "!room:example.test": "session" },
    pendingBatches: [
      {
        fromCursor: "cursor-after-first",
        nextBatch: "cursor-next",
        rooms: [
          { roomId: "!room:example.test", eventIds: ["$held", "$later"], completedEventIds: [] },
          { roomId: "!other:example.test", eventIds: ["$unrelated"], completedEventIds: [] },
        ],
      },
      {
        fromCursor: "cursor-next",
        nextBatch: "cursor-final",
        rooms: [{ roomId: "!room:example.test", eventIds: ["$moved"], completedEventIds: [] }],
      },
    ],
  };

  const normalized = normalizeEarlyCursorState({
    state,
    initialCursor: "cursor-initial",
    roomId: "!room:example.test",
    heldEventId: "$held",
    orderedEventIds: ["$first", "$moved", "$held", "$later"],
    committedAtMs: 30,
  });

  assert.deepEqual(normalized.pendingBatches[0].rooms[0], {
    roomId: "!room:example.test",
    eventIds: ["$first", "$moved", "$held", "$later"],
    completedEventIds: ["$first", "$moved"],
  });
  assert.deepEqual(normalized.pendingBatches[1].rooms[0], {
    roomId: "!room:example.test",
    eventIds: [],
    completedEventIds: [],
  });
  assert.equal(normalized.pendingBatches[0].fromCursor, "cursor-initial");
  assert.equal(normalized.cursor, "cursor-initial");
  assert.equal(normalized.committedAtMs, 30);
  assert.equal(state.cursor, "cursor-after-first");
  assert.deepEqual(state.pendingBatches[1].rooms[0].eventIds, ["$moved"]);
});

test("rejects a held event that is not the exact next event", () => {
  assert.throws(() => normalizeEarlyCursorState({
    state: {
      cursor: "cursor",
      pendingBatches: [{
        fromCursor: "cursor",
        nextBatch: "next",
        rooms: [{ roomId: "!room:example.test", eventIds: ["$held"], completedEventIds: ["$other"] }],
      }],
    },
    initialCursor: "cursor",
    roomId: "!room:example.test",
    heldEventId: "$held",
    orderedEventIds: ["$held"],
    committedAtMs: 1,
  }), /next pending room event/u);
});
