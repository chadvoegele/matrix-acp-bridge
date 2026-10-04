import assert from "node:assert/strict";
import test from "node:test";

import { MAX_COMPLETED_EVENT_IDS_PER_ROOM } from "../../dist/bridge-state.js";
import { assertCompletedEventLedger } from "./completed-event-ledger.mjs";

test("live recovery accepts completed IDs retained beyond the initial-sync window", () => {
  const ids = Array.from({ length: 102 }, (_, index) => `$event-${index}`);
  assert.equal(assertCompletedEventLedger(ids, "restart"), ids);
});

test("live recovery enforces the durable ledger limit rather than the sync window", () => {
  const ids = Array.from({ length: MAX_COMPLETED_EVENT_IDS_PER_ROOM }, (_, index) => `$event-${index}`);
  assert.equal(assertCompletedEventLedger(ids, "restart"), ids);
  assert.throws(() => assertCompletedEventLedger([...ids, "$overflow"], "restart"), /unbounded/u);
});

test("live recovery rejects missing, malformed, and duplicate completed IDs", () => {
  for (const ids of [undefined, {}, ["$same", "$same"], [""], [42]]) {
    assert.throws(() => assertCompletedEventLedger(ids, "restart"), /completed-ID ledger/u);
  }
});
