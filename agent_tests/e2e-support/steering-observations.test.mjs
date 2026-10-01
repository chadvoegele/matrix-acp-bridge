import assert from "node:assert/strict";
import test from "node:test";
import { assertSteeringBaseline, assertSteeringHealthy } from "./steering-observations.mjs";

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
