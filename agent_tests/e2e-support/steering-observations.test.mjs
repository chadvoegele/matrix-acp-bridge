import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSteeringBaseline,
  assertSteeringHealthy,
  assertSteeringIdleNotices,
  assertSteeringDeviceBaseline,
  selectEventsSinceInput,
  collectAgentMessages,
  effectiveMatrixReplies,
} from "./steering-observations.mjs";

test("startup guard rejects session creation even before a prompt starts", () => {
  assert.throws(() => assertSteeringBaseline([{ direction: "out", frame: { method: "session/new" } }]));
  assertSteeringBaseline([{ direction: "out", frame: { method: "initialize" } }]);
});

test("health guard catches RPC errors outside tracked scenario prompts", () => {
  assert.throws(() =>
    assertSteeringHealthy(
      [{ direction: "in", phase: "shutdown", frame: { id: 9, error: { code: -32_603 } } }],
      [],
      "bridge",
    ),
  );
});

test("health guard catches historical msg3 thread failure outside reply snapshot", () => {
  const events = [
    {
      sender: "bridge",
      originServerTs: 1,
      content: { body: "[agent error]", "m.relates_to": { rel_type: "m.thread", event_id: "old-msg3" } },
    },
  ];
  assert.throws(() => assertSteeringHealthy([], events, "bridge"));
  assertSteeringHealthy([], [{ ...events[0], sender: "other" }], "bridge");
});

test("live idle notice counts preserve default-selected silence in both response modes", () => {
  const notice = { content: { body: "No running turn; message queued as a prompt." } };
  const reply = { content: { body: "agent reply" } };
  assertSteeringIdleNotices([reply, notice], "room");
  assertSteeringIdleNotices([reply, notice, notice], "thread");
  assert.throws(() => assertSteeringIdleNotices([notice, notice], "room"));
  assert.throws(() => assertSteeringIdleNotices([notice, notice, notice], "thread"));
});

test("startup guard rejects session activity even without a captured request", () => {
  assert.throws(() =>
    assertSteeringBaseline([
      { direction: "in", frame: { method: "session/update", params: { update: { sessionUpdate: "tool_call" } } } },
    ]),
  );
});

test("live mode isolation rejects a new state or response mode on an already used device", () => {
  const baseline = {
    version: 1,
    homeserver: "https://matrix.example.org",
    userId: "@bridge:example.org",
    deviceId: "test-device",
    stateDir: "/private/room-state",
    responseMode: "room",
  };
  assertSteeringDeviceBaseline(null, baseline);
  assertSteeringDeviceBaseline({ ...baseline }, baseline);
  assert.throws(() => assertSteeringDeviceBaseline(baseline, { ...baseline, stateDir: "/private/fresh-state" }));
  assert.throws(() => assertSteeringDeviceBaseline(baseline, { ...baseline, responseMode: "thread" }));
  assert.throws(() => assertSteeringDeviceBaseline(baseline, { ...baseline, deviceId: "different-device" }));
});

test("reset observation excludes delayed older notices without hiding new idle notices or RPC errors", () => {
  const notice = {
    sender: "bridge",
    originServerTs: 99,
    content: { body: "No running turn; message queued as a prompt." },
  };
  const newNotice = { ...notice, originServerTs: 101 };
  const input = { originServerTs: 100 };
  assert.deepEqual(selectEventsSinceInput([notice, input], input), [input]);
  const current = selectEventsSinceInput([notice, input, newNotice], input);
  assert.deepEqual(current, [input, newNotice]);
  assert.equal(current.filter((event) => event.content?.body === notice.content.body).length, 1);
  assert.throws(() => selectEventsSinceInput([notice], {}), /controlled input/u);
  assert.throws(() => selectEventsSinceInput([{}], input), /observed event/u);
  assert.throws(() => assertSteeringHealthy([{ direction: "in", frame: { error: {} } }], current, "bridge"));
});

test("steering observations accumulate response IDs across tools, thoughts, prompt completion and sessions", () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- Local wire fixture.
  const chunk = (sessionId, sessionUpdate, messageId, text) => ({
    direction: "in",
    frame: {
      method: "session/update",
      params: { sessionId, update: { sessionUpdate, messageId, content: { type: "text", text } } },
    },
  });
  const frames = [
    chunk("first", "agent_message_chunk", "shared", "before "),
    chunk("first", "agent_thought_chunk", "shared", "thought"),
    {
      direction: "in",
      frame: { method: "session/update", params: { sessionId: "first", update: { sessionUpdate: "tool_call" } } },
    },
    { direction: "in", frame: { id: 1, result: { stopReason: "end_turn" } } },
    chunk("second", "agent_message_chunk", "shared", "independent"),
    chunk("first", "agent_message_chunk", "shared", "after\n"),
    chunk("first", "agent_message_chunk", "next", "next response"),
  ];
  assert.deepEqual(collectAgentMessages(frames), [
    { sessionId: "first", messageId: "shared", text: "before after\n" },
    { sessionId: "first", messageId: "next", text: "next response" },
    { sessionId: "second", messageId: "shared", text: "independent" },
  ]);
  for (const kind of ["agent_message_chunk", "agent_thought_chunk"]) {
    for (const id of [undefined, "", "\u0000 ", 4])
      assert.throws(() => collectAgentMessages([chunk("first", kind, id, "private")]), /usable response ID/u);
  }
});

test("steering observations assess final replacements while retaining original routing and raw wire events", () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- Local Matrix fixture.
  const content = (body) => ({ msgtype: "m.text", body, "m.relates_to": { rel_type: "m.thread", event_id: "$root" } });
  const original = { eventId: "$original", content: content("before"), isEncrypted: true };
  const replacement = (id, target, body) => ({
    eventId: id,
    content: {
      body: `* ${body}`,
      "m.new_content": content(body),
      "m.relates_to": { rel_type: "m.replace", event_id: target },
    },
    isEncrypted: true,
  });
  const events = [
    original,
    replacement("$edit1", "$original", "before after"),
    replacement("$edit2", "$original", "final"),
    original,
  ];
  assert.deepEqual(effectiveMatrixReplies(events), [{ ...original, content: content("final") }]);
  assert.equal(events.length, 4);
  assert.equal(original.content.body, "before");
  assert.throws(
    () => effectiveMatrixReplies([original, replacement("$wrong", "$edit1", "bad")]),
    /unobserved original/u,
  );
  assert.throws(
    () =>
      effectiveMatrixReplies([
        original,
        { eventId: "$bad", content: { "m.relates_to": { rel_type: "m.replace", event_id: "$original" } } },
      ]),
    /effective content/u,
  );
});
