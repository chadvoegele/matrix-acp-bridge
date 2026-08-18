import assert from "node:assert/strict";
import test from "node:test";

import {
  createRestartPersistenceObserver,
  describeLoadFailure,
} from "./restart-persistence-observer.mjs";

test("correlates a session/load result with its request ID", () => {
  const observer = createRestartPersistenceObserver();
  observer.outbound({ id: 1, method: "session/load" });
  observer.outbound({ id: 2, method: "session/prompt" });

  observer.inbound({ id: 2, result: {} });
  assert.equal(observer.loadOutcome, undefined);

  observer.inbound({ id: 1, result: {} });
  assert.deepEqual(observer.loadOutcome, { kind: "success" });
});

test("normalizes a session/load JSON-RPC error to its numeric code", () => {
  const observer = createRestartPersistenceObserver();
  observer.outbound({ id: 1, method: "session/load" });
  observer.inbound({ id: 1, error: { code: -32_000, message: "private detail" } });

  assert.deepEqual(observer.loadOutcome, { kind: "error", code: -32_000 });
  assert.equal(describeLoadFailure(observer.loadOutcome), "session/load returned JSON-RPC error code -32000");
});

test("does not expose an invalid or unnumbered load error", () => {
  const observer = createRestartPersistenceObserver();
  observer.outbound({ id: 1, method: "session/load" });
  observer.inbound({ id: 1, error: { message: "private detail" } });
  assert.deepEqual(observer.loadOutcome, { kind: "error" });
  assert.equal(
    describeLoadFailure(observer.loadOutcome),
    "session/load returned a JSON-RPC error without a numeric code",
  );

  observer.outbound({ id: 2, method: "session/load" });
  observer.inbound({ id: 2 });
  assert.deepEqual(observer.loadOutcome, { kind: "invalid" });
  assert.equal(describeLoadFailure(observer.loadOutcome), "session/load response did not contain a result");
});
