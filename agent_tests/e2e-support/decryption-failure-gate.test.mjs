import assert from "node:assert/strict";
import test from "node:test";

import { installLiveDecryptionFailureHandler } from "../encrypted-e2e/decryption-failure-gate.mjs";

test("ignores startup decryption failures and rejects live failures", () => {
  let onFailure;
  let rejection;
  const adapter = {
    onDecryptionFailure(listener) {
      onFailure = listener;
      return () => {};
    },
  };
  const beginLiveExchange = installLiveDecryptionFailureHandler(adapter, (error) => {
    rejection = error;
  });

  onFailure();
  assert.equal(rejection, undefined);

  beginLiveExchange();
  onFailure();
  assert.equal(rejection?.message, "Matrix sender saw an undecryptable event");
});
