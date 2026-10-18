import assert from "node:assert/strict";
import { isUsableMessageId } from "../../dist/acp-activity-update.js";

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

export function assertSteeringIdleNotices(replies, responseMode) {
  // Explicit /steer while idle emits one notice. Thread mode additionally
  // starts an independent explicit /steer conversation. Default-selected
  // msg1 silently becomes a prompt and must never add a notice.
  assert.equal(
    replies.filter((event) => event.content.body === "No running turn; message queued as a prompt.").length,
    responseMode === "thread" ? 2 : 1,
    "idle notices must correspond only to explicit steering",
  );
}

export function assertSteeringDeviceBaseline(previous, current) {
  if (previous === null) return;
  for (const key of ["version", "homeserver", "userId", "deviceId", "stateDir", "responseMode"]) {
    assert.ok(
      previous[key] === current[key],
      "temporary device already has a different steering baseline; provision new devices for a new mode or state",
    );
  }
}

export function selectEventsSinceInput(events, input) {
  assert.ok(Number.isFinite(input?.originServerTs), "controlled input requires a server timestamp");
  for (const event of events) {
    assert.ok(Number.isFinite(event.originServerTs), "observed event requires a server timestamp");
  }
  return events.filter((event) => event.originServerTs >= input.originServerTs);
}

export function collectAgentMessages(frames) {
  const sessions = new Map();
  for (const { direction, frame } of frames) {
    const update = frame.params?.update;
    if (
      direction !== "in" ||
      frame.method !== "session/update" ||
      update?.content?.type !== "text" ||
      typeof update.content.text !== "string"
    )
      continue;
    if (!["agent_message_chunk", "agent_thought_chunk"].includes(update.sessionUpdate)) continue;
    if (update._meta?.piAcp?.notify && typeof update._meta.piAcp.notify === "object") continue;
    assert.ok(isUsableMessageId(update.messageId), "real agent emitted text or thought without a usable response ID");
    if (update.sessionUpdate === "agent_thought_chunk") continue;
    const sessionId = frame.params.sessionId;
    const messages = sessions.get(sessionId) ?? new Map();
    sessions.set(sessionId, messages);
    const message = messages.get(update.messageId) ?? { sessionId, messageId: update.messageId, text: "" };
    message.text += update.content.text;
    messages.set(update.messageId, message);
  }
  return [...sessions.values()].flatMap((messages) => [...messages.values()]).filter((message) => message.text.trim());
}

export function effectiveMatrixReplies(events) {
  const originals = new Map();
  for (const event of events) {
    const relation = event.content?.["m.relates_to"];
    if (relation?.rel_type !== "m.replace") {
      if (!originals.has(event.eventId)) originals.set(event.eventId, event);
      continue;
    }
    const original = originals.get(relation.event_id);
    assert.ok(original, "replacement targets an unobserved original reply");
    assert.ok(event.content["m.new_content"], "replacement has no effective content");
    originals.set(original.eventId, { ...original, content: event.content["m.new_content"] });
  }
  return [...originals.values()];
}
