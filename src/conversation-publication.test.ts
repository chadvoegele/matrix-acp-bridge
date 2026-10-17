import assert from "node:assert/strict";
import test from "node:test";

import { ConversationPublication, type PublicationFailure } from "./conversation-publication.js";

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

void test("publication capacity must be a positive safe integer", () => {
  for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new ConversationPublication(capacity, () => {}), /maximumPending/u);
  }
});

void test("pending keys coalesce in place while distinct keys retain FIFO order", async () => {
  const queue = new ConversationPublication(2, () => assert.fail("unexpected failure"));
  const gate = createGate();
  const calls: string[] = [];
  queue.enqueue({}, () => gate.promise);
  await Promise.resolve();
  const key = {};
  const record = (value: string) => async () => {
    calls.push(value);
  };
  assert.equal(queue.enqueue(key, record("obsolete")), true);
  assert.equal(queue.enqueue({}, record("last")), true);
  assert.equal(queue.enqueue(key, record("replacement")), true);
  assert.equal(queue.pendingCount, 3);
  gate.release();
  await queue.waitForIdle();
  assert.deepEqual(calls, ["replacement", "last"]);
  assert.equal(queue.pendingCount, 0);
  queue.enqueue({}, record("restarted"));
  await queue.waitForIdle();
  assert.equal(calls.at(-1), "restarted");
});

void test("capacity rejection stops intake, notifies once and drops pending operations", async () => {
  const failures: PublicationFailure[] = [];
  const queue = new ConversationPublication(1, (reason) => failures.push(reason));
  const gate = createGate();
  queue.enqueue({}, () => gate.promise);
  await Promise.resolve();
  queue.enqueue({}, async () => assert.fail("pending work survived stop"));
  assert.equal(
    queue.enqueue({}, async () => {}),
    false,
  );
  assert.equal(
    queue.enqueue({}, async () => {}),
    false,
  );
  assert.deepEqual(failures, ["capacity"]);
  assert.equal(queue.stopped, true);
  gate.release();
  await queue.waitForIdle();
  assert.equal(queue.pendingCount, 0);
});

void test("delivery exceptions notify failure and waitForIdle settles after cleanup", async () => {
  const failures: PublicationFailure[] = [];
  const queue = new ConversationPublication(2, (reason) => failures.push(reason));
  let stopped = false;
  queue.onStop(() => {
    stopped = true;
  });
  queue.enqueue({}, async () => {
    throw new Error("private transport detail");
  });
  queue.enqueue({}, async () => assert.fail("pending work survived failure"));
  await queue.waitForIdle();
  assert.deepEqual(failures, ["delivery"]);
  assert.equal(stopped, true);
  assert.equal(queue.pendingCount, 0);
});

void test("stop is idempotent, subscriptions detach and late listeners are notified immediately", async () => {
  const queue = new ConversationPublication(1, () => assert.fail("explicit stop is not failure"));
  let notifications = 0;
  const detach = queue.onStop(() => assert.fail("detached listener called"));
  detach();
  queue.onStop(() => {
    notifications += 1;
  });
  queue.stop();
  queue.stop();
  queue.onStop(() => {
    notifications += 1;
  });
  assert.equal(notifications, 2);
  assert.equal(
    queue.enqueue({}, async () => assert.fail("stopped work executed")),
    false,
  );
  await queue.waitForIdle();
});
