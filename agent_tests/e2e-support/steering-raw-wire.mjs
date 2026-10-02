import assert from "node:assert/strict";

import { readToken } from "./common.mjs";

export function rawRoomPageLoader(environment, roomId = environment.roomId) {
  return async (cursor, limit = 100) => {
    const url = new URL(`${environment.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`);
    url.searchParams.set("dir", "b");
    url.searchParams.set("limit", String(limit));
    if (cursor !== undefined) url.searchParams.set("from", cursor);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${await readToken(environment.sender.tokenFile)}` },
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.ok, true, "raw room audit request failed");
    const page = await response.json();
    assert.ok(Array.isArray(page.chunk), "raw room audit returned invalid events");
    return page;
  };
}

export async function captureRawRoomBoundary(loadPage) {
  const page = await loadPage(undefined, 1);
  const boundary = page.chunk[0]?.event_id ?? null;
  assert.ok(boundary === null || typeof boundary === "string");
  return boundary;
}

async function collectPages(loadPage, accept, finished) {
  const events = [];
  const cursors = new Set();
  let cursor;
  for (let index = 0; index < 100; index += 1) {
    const page = await loadPage(cursor);
    for (const event of page.chunk) {
      if (finished(event)) return events.reverse();
      if (accept(event)) events.push(event);
    }
    if (page.chunk.length === 0 || page.end === undefined) {
      assert.ok(finished(), "raw room audit did not reach its boundary");
      return events.reverse();
    }
    assert.equal(typeof page.end, "string");
    assert.ok(!cursors.has(page.end), "raw room audit pagination repeated a cursor");
    cursors.add(page.end);
    cursor = page.end;
  }
  assert.fail("raw room audit exceeded its bounded pagination");
}

export async function collectRawRoomEvents(boundary, loadPage) {
  return await collectPages(
    loadPage,
    () => true,
    (event) => (event === undefined ? boundary === null : event.event_id === boundary),
  );
}

export async function collectRawRoomWindow(start, end, loadPage) {
  assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end);
  return await collectPages(
    loadPage,
    (event) => {
      assert.ok(Number.isSafeInteger(event.origin_server_ts), "raw audit event lacks a timestamp");
      return event.origin_server_ts <= end;
    },
    (event) => event === undefined || event.origin_server_ts < start,
  );
}

export function assertRawSteeringEncryption(events, userIds, checkedEventIds = []) {
  const users = new Set(userIds);
  assert.equal(
    events.filter((event) => users.has(event.sender) && event.type === "m.room.message").length,
    0,
    "plaintext test-account output across startup, scenarios, or shutdown",
  );
  const types = new Map(events.map((event) => [event.event_id, event.type]));
  for (const id of checkedEventIds)
    assert.equal(types.get(id), "m.room.encrypted", "checked event absent from raw encrypted audit");
}
