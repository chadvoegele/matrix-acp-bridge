import assert from "node:assert/strict";
import { test } from "node:test";

import { assertRawSteeringEncryption, collectRawRoomEvents, collectRawRoomWindow } from "./steering-raw-wire.mjs";

function pages(values) {
  let index = 0;
  return async () => values[index++];
}

const event = (id, type, timestamp = 100) => ({ event_id: id, sender: "bridge", type, origin_server_ts: timestamp });

test("raw boundary audit includes startup and shutdown plaintext hidden by SDK filtering", async () => {
  const raw = await collectRawRoomEvents(
    "baseline",
    pages([
      { chunk: [event("shutdown", "m.room.message"), event("reply", "m.room.encrypted")], end: "next" },
      { chunk: [event("startup", "m.room.message"), event("baseline", "m.room.message")], end: "old" },
    ]),
  );
  assert.deepEqual(
    raw.map((item) => item.event_id),
    ["startup", "reply", "shutdown"],
  );
  assert.throws(() => assertRawSteeringEncryption(raw, ["bridge"], ["reply"]), /plaintext/u);
  assertRawSteeringEncryption([event("reply", "m.room.encrypted")], ["bridge"], ["reply"]);
  assert.throws(() => assertRawSteeringEncryption([], ["bridge"], ["reply"]), /unexpected/u);
  assert.throws(
    () =>
      assertRawSteeringEncryption(
        [event("reply", "m.room.encrypted"), event("hidden", "m.room.encrypted")],
        ["bridge"],
        ["reply"],
      ),
    /unexpected/u,
  );
});

test("raw boundary audit fails closed on missing boundary and repeated pagination", async () => {
  await assert.rejects(collectRawRoomEvents("missing", pages([{ chunk: [], end: "end" }])), /boundary/u);
  await assert.rejects(
    collectRawRoomEvents(
      "missing",
      pages([
        { chunk: [event("one", "m.room.encrypted")], end: "same" },
        { chunk: [event("two", "m.room.encrypted")], end: "same" },
      ]),
    ),
    /cursor/u,
  );
});

test("retained raw window audit excludes older history but includes the complete bounded interval", async () => {
  const raw = await collectRawRoomWindow(
    80,
    120,
    pages([
      { chunk: [event("later", "m.room.message", 130), event("last", "m.room.encrypted", 120)], end: "next" },
      { chunk: [event("first", "m.room.encrypted", 80), event("older", "m.room.message", 79)], end: "old" },
    ]),
  );
  assert.deepEqual(
    raw.map((item) => item.event_id),
    ["first", "last"],
  );
  assertRawSteeringEncryption(raw, ["bridge"], ["first", "last"]);
});
