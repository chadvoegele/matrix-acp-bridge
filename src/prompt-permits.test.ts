import assert from "node:assert/strict";
import test from "node:test";
import { PromptPermits } from "./prompt-permits.js";

void test("prompt permits enforce FIFO capacity and idempotent release", async () => {
  const permits = new PromptPermits(1);
  const release = await permits.acquire();
  assert.ok(release);
  const order: string[] = [];
  const second = permits.acquire().then((next) => {
    order.push("second");
    return next;
  });
  const third = permits.acquire().then((next) => {
    order.push("third");
    return next;
  });
  await Promise.resolve();
  assert.deepEqual(order, []);
  release();
  release();
  const releaseSecond = await second;
  assert.ok(releaseSecond);
  assert.deepEqual(order, ["second"]);
  releaseSecond();
  const releaseThird = await third;
  assert.ok(releaseThird);
  assert.deepEqual(order, ["second", "third"]);
  releaseThird();
});

void test("cancelling permit waiters settles all without consuming released capacity", async () => {
  const permits = new PromptPermits(1);
  const release = await permits.acquire();
  assert.ok(release);
  const second = permits.acquire();
  const third = permits.acquire();
  permits.cancelWaiters();
  permits.cancelWaiters();
  assert.deepEqual(await Promise.all([second, third]), [undefined, undefined]);
  release();
  const nextRelease = await permits.acquire();
  assert.ok(nextRelease);
  nextRelease();
});

void test("prompt capacity rejects invalid configuration before scheduling", () => {
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new PromptPermits(limit), RangeError);
  }
});
