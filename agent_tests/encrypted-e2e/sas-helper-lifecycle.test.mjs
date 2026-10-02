import assert from "node:assert/strict";
import test from "node:test";

import { dispatchSasAttempt } from "./sas-helper-lifecycle.mjs";

test("stale terminal requests and ignored aliases cannot end a waiting SAS helper", async () => {
  let verified = 0;
  let failed = 0;
  const handle = async (request) => {
    if (["cancelled", "done"].includes(request.phase) || request.alias) return;
    assert.equal(request.phase, "verified");
    return true;
  };
  const dispatch = (request) =>
    dispatchSasAttempt(
      request,
      handle,
      () => verified++,
      () => failed++,
    );
  await dispatch({ phase: "cancelled" });
  await dispatch({ phase: "done" });
  await dispatch({ phase: "requested", alias: true });
  assert.equal(verified, 0, "helper must remain alive for the actual exchange");
  assert.equal(failed, 0);
  await dispatch({ phase: "verified" });
  assert.equal(verified, 1);
});

test("only explicit protocol completion succeeds, and rejection remains a failure", async () => {
  let verified = 0;
  let failed = 0;
  const dispatch = (handle) =>
    dispatchSasAttempt(
      {},
      handle,
      () => verified++,
      () => failed++,
    );
  await dispatch(async () => false);
  await dispatch(async () => ({ phase: "verified" }));
  assert.equal(verified, 0);
  await dispatch(async () => {
    throw new Error("private protocol error");
  });
  assert.equal(failed, 1);
  await dispatch(async () => true);
  assert.equal(verified, 1);
});
