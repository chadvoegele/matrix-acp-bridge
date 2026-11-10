import assert from "node:assert/strict";
import test from "node:test";
import { hasBurstProgress } from "./observations.mjs";

test("initial overflow waits for actual recovery diagnostics", () => {
  assert.equal(hasBurstProgress(0, 0, 0, true), false);
  assert.equal(hasBurstProgress(0, 0, 1, false), true);
});

test("cooldown burst progresses on accepted output without requiring a droppable sentinel", () => {
  assert.equal(hasBurstProgress(1, 1, 1, false), false);
  assert.equal(hasBurstProgress(1, 1, 1, true), true);
});
