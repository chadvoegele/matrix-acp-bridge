import assert from "node:assert/strict";
import test from "node:test";

import { createCancellationController } from "./cancellation.js";

void test("cancellation notifies listeners once and supports unsubscribe", () => {
  const cancellation = createCancellationController();
  const reasons: Array<string | undefined> = [];
  const unsubscribe = cancellation.signal.onCancel((reason) => reasons.push(reason));
  cancellation.signal.onCancel((reason) => reasons.push(reason));
  unsubscribe();

  cancellation.cancel("shutdown");
  cancellation.cancel("ignored");

  assert.equal(cancellation.signal.cancelled, true);
  assert.equal(cancellation.signal.reason, "shutdown");
  assert.deepEqual(reasons, ["shutdown"]);
});

void test("a listener added after cancellation is called immediately", () => {
  const cancellation = createCancellationController();
  cancellation.cancel("deadline");
  let reason: string | undefined;

  cancellation.signal.onCancel((value) => {
    reason = value;
  });

  assert.equal(reason, "deadline");
});
