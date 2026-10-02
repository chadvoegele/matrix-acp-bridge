import assert from "node:assert/strict";

export function assertSteeringBaseline(frames) {
  assert.equal(
    frames.filter(
      ({ direction, frame }) =>
        direction === "out" &&
        ["session/new", "session/load", "session/prompt", "_session/steering"].includes(frame.method),
    ).length,
    0,
    "startup created or recovered ACP work; use a clean baseline before live scenarios",
  );
  assert.equal(
    frames.filter(({ direction, frame }) => direction === "in" && frame.method === "session/update").length,
    0,
    "startup emitted unexpected ACP session activity",
  );
}

export function assertSteeringHealthy(frames, events, bridgeUserId) {
  assert.equal(
    frames.filter(({ direction, frame }) => direction === "in" && frame.error !== undefined).length,
    0,
    "unexpected ACP error across startup, scenarios, or shutdown",
  );
  assert.equal(
    events.filter(
      (event) =>
        event.sender === bridgeUserId &&
        /\[agent (?:error|timed out|cancelled the request)\]/u.test(event.content?.body ?? ""),
    ).length,
    0,
    "unexpected Matrix failure across startup, scenarios, or shutdown",
  );
}
