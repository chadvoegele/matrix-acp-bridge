import assert from "node:assert/strict";
import { assertThreadResponse } from "./thread-sessions.mjs";

export function effectiveContent(event) {
  return event.content?.["m.new_content"] ?? event.content;
}

export function assertUnifiedStream(events, marker, rootEventId, threadMode) {
  const originals = events.filter((event) => event.content?.["m.relates_to"]?.rel_type !== "m.replace");
  const edits = events.filter((event) => event.content?.["m.relates_to"]?.rel_type === "m.replace");
  const text = originals.filter((event) => event.content.body.startsWith(`UNIFIED_${marker} `));
  assert.equal(text.length, 1, "progressive text must have exactly one original");
  const progressive = edits.filter((event) => event.content["m.relates_to"].event_id === text[0].eventId);
  assert(progressive.some((event) => effectiveContent(event).body === `UNIFIED_${marker} **prefix suffix**`));
  assert(
    progressive.some((event) => effectiveContent(event).body === `UNIFIED_${marker} **prefix suffix** after tool`),
  );
  assert(
    progressive.some((event) => effectiveContent(event).formatted_body.includes("<strong>prefix suffix</strong>")),
  );
  assert.equal(originals.filter((event) => event.content.body === `UNIFIED_DONE_${marker}`).length, 1);
  for (let index = 0; index < 12; index++) {
    assert.equal(originals.filter((event) => event.content.body === `SEQUENTIAL_${marker}_${index}`).length, 1);
  }
  const batches = originals.filter((event) => event.content.body.includes(`unified-${marker}-`));
  assert(batches.length > 0, "unsolicited activity original missing");
  assert.equal(originals.length, 14 + batches.length, "unexpected duplicate text or empty-response fallback");
  assert(
    batches.every((event) => !event.content.formatted_body.includes("Past agent events")),
    "initial activity collapsed",
  );
  const latest = new Map(originals.map((event) => [event.eventId, event.content]));
  for (const event of edits) {
    const content = effectiveContent(event);
    const target = event.content["m.relates_to"].event_id;
    assert(latest.has(target), "edit targets another conversation or an unobserved original");
    assert.equal(event.content.body, `* ${content.body}`);
    latest.set(target, content);
  }
  const activity = batches.map((event) => latest.get(event.eventId));
  assert(
    activity.every((content) => content.formatted_body.includes("Past agent events")),
    "final activity not collapsed",
  );
  const body = activity.map((content) => content.body).join("\n");
  assert.match(body, /\[completed\].*first/u);
  assert.match(body, /\[failed\].*second/u);
  assert(events.indexOf(text[0]) < events.indexOf(batches[0]), "preceding text followed activity");
  for (const event of events) {
    const content = effectiveContent(event);
    assert.equal(content.format, "org.matrix.custom.html");
    assert(!content.formatted_body.includes("<script"));
    assert(Buffer.byteLength(JSON.stringify(event.content)) <= 32_768);
    if (threadMode) assertThreadResponse(content, rootEventId, rootEventId);
    else assert.equal(content["m.relates_to"], undefined, "room output acquired a thread relation");
  }
}
