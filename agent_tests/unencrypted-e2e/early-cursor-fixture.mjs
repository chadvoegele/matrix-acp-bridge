function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Select eligible plaintext sender IDs from one Matrix timeline. */
export function plaintextSenderEventIds(events, { senderUserId }) {
  assert(Array.isArray(events), "Matrix timeline must be an array");
  assert(typeof senderUserId === "string" && senderUserId.length > 0,
    "sender user ID is required");

  const eventIds = [];
  for (const event of events) {
    if (event?.type !== "m.room.message" || event.sender !== senderUserId ||
        event.content?.msgtype !== "m.text" || typeof event.content.body !== "string" ||
        typeof event.event_id !== "string") {
      continue;
    }
    eventIds.push(event.event_id);
  }
  return eventIds;
}

/**
 * Select eligible plaintext sender IDs from one Matrix timeline, preserving
 * Matrix order and stopping at the held event. Bodies are inspected only to
 * recognize m.text events and are never returned.
 */
export function orderedPlaintextEventIds(events, { senderUserId, heldEventId }) {
  assert(typeof heldEventId === "string" && heldEventId.length > 0,
    "held event ID is required");
  const eventIds = plaintextSenderEventIds(events, { senderUserId });
  const heldIndex = eventIds.indexOf(heldEventId);
  return heldIndex === -1 ? undefined : eventIds.slice(0, heldIndex + 1);
}

/**
 * Recast captured private state into the valid crash boundary exercised by
 * the early-cursor test. Every selected event before the held event is an exact
 * completed-ID prefix in the first recovery batch; the held event is next and
 * later selected events remain pending in Matrix order. The input is cloned so
 * callers only write the returned ignored state file.
 */
export function normalizeEarlyCursorState({
  state,
  initialCursor,
  roomId,
  heldEventId,
  orderedEventIds,
  committedAtMs,
}) {
  assert(state !== null && typeof state === "object", "captured state is required");
  assert(typeof initialCursor === "string" && initialCursor.length > 0,
    "initial cursor is required");
  assert(typeof roomId === "string" && roomId.length > 0, "room ID is required");
  assert(typeof heldEventId === "string" && heldEventId.length > 0,
    "held event ID is required");
  assert(Array.isArray(orderedEventIds) && orderedEventIds.length > 0,
    "ordered event IDs are required");
  assert(typeof committedAtMs === "number" && Number.isSafeInteger(committedAtMs) && committedAtMs >= 0,
    "checkpoint time is invalid");
  assert(new Set(orderedEventIds).size === orderedEventIds.length,
    "ordered event IDs must be unique");
  const heldOrderedIndex = orderedEventIds.indexOf(heldEventId);
  assert(heldOrderedIndex !== -1,
    "ordered event IDs must include the held event");

  const normalized = structuredClone(state);
  assert(Array.isArray(normalized.pendingBatches) && normalized.pendingBatches.length > 0,
    "captured state has no pending recovery batches");

  let heldLocation;
  for (let batchIndex = 0; batchIndex < normalized.pendingBatches.length; batchIndex += 1) {
    const batch = normalized.pendingBatches[batchIndex];
    for (let roomIndex = 0; roomIndex < batch.rooms.length; roomIndex += 1) {
      const room = batch.rooms[roomIndex];
      const eventIndex = room.eventIds.indexOf(heldEventId);
      if (eventIndex === -1) continue;
      assert(heldLocation === undefined, "held event appears more than once");
      heldLocation = { batchIndex, roomIndex, eventIndex };
      assert(room.roomId === roomId, "held event is in the wrong room");
      assert(eventIndex === room.completedEventIds.length,
        "held event is not the next pending room event");
    }
  }
  assert(heldLocation !== undefined, "held event is absent from captured state");
  assert(heldLocation.batchIndex === 0,
    "held event must be in the earliest recovery batch");

  const movedIds = new Set(orderedEventIds);
  for (const batch of normalized.pendingBatches) {
    for (const room of batch.rooms) {
      if (room.roomId !== roomId) continue;
      for (const eventId of room.eventIds) {
        assert(movedIds.has(eventId),
          "captured target-room event is absent from the Matrix timeline");
      }
    }
  }
  for (const batch of normalized.pendingBatches) {
    for (const room of batch.rooms) {
      room.eventIds = room.eventIds.filter((eventId) => !movedIds.has(eventId));
      room.completedEventIds = room.completedEventIds.filter((eventId) => !movedIds.has(eventId));
    }
  }

  const firstBatch = normalized.pendingBatches[0];
  const targetRoom = firstBatch.rooms.find((room) => room.roomId === roomId);
  assert(targetRoom !== undefined, "captured state has no target room in the earliest batch");
  const suffix = targetRoom.eventIds.filter((eventId) => !movedIds.has(eventId));
  targetRoom.eventIds = [...orderedEventIds, ...suffix];
  targetRoom.completedEventIds = orderedEventIds.slice(0, heldOrderedIndex);

  normalized.cursor = initialCursor;
  normalized.committedAtMs = committedAtMs;
  firstBatch.fromCursor = initialCursor;

  let expectedFrom = normalized.cursor;
  const allEventIds = new Set();
  for (const batch of normalized.pendingBatches) {
    assert(batch.fromCursor === expectedFrom, "normalized cursor chain is invalid");
    expectedFrom = batch.nextBatch;
    for (const room of batch.rooms) {
      assert(room.completedEventIds.every((eventId, index) => room.eventIds[index] === eventId),
        "normalized completed IDs are not an exact FIFO prefix");
      for (const eventId of room.eventIds) {
        assert(!allEventIds.has(eventId), "normalized recovery IDs are duplicated");
        allEventIds.add(eventId);
      }
    }
  }
  assert(targetRoom.completedEventIds.length === targetRoom.eventIds.indexOf(heldEventId),
    "normalized held event is not the next pending event");

  return normalized;
}
