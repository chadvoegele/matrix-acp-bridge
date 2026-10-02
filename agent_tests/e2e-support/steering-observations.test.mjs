import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSteeringBaseline,
  assertSteeringHealthy,
  assertSteeringIdleNotices,
  assertSteeringDeviceBaseline,
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
