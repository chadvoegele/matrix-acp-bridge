import assert from "node:assert/strict";
import test from "node:test";

import { FakeClock } from "./test-support/fake-clock.js";

void test("fake clock runs timers in due-time and insertion order", () => {
  const clock = new FakeClock(100);
  const calls: string[] = [];

  clock.setTimeout(() => calls.push("late"), 20);
  clock.setTimeout(() => calls.push("first"), 10);
  clock.setTimeout(() => calls.push("second"), 10);

  clock.advanceBy(10);
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(clock.now(), 110);

  clock.advanceBy(10);
  assert.deepEqual(calls, ["first", "second", "late"]);
  assert.equal(clock.pendingTimerCount, 0);
});

void test("fake clock supports cancellation and timers created by callbacks", () => {
  const clock = new FakeClock();
  const calls: string[] = [];
  const cancelled = clock.setTimeout(() => calls.push("cancelled"), 1);
  clock.clearTimeout(cancelled);
  clock.setTimeout(() => {
    calls.push("parent");
    clock.setTimeout(() => calls.push("child"), 5);
  }, 2);

  clock.advanceBy(7);

  assert.deepEqual(calls, ["parent", "child"]);
});
