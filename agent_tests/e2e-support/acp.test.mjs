import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { stopBridgePair } from "./acp.mjs";

test("teardown stops and awaits ACP even when the bridge has already failed", async () => {
  // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess uses Node EventEmitter semantics.
  const bridge = new EventEmitter();
  bridge.exitCode = 1;
  bridge.signalCode = null;
  // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess uses Node EventEmitter semantics.
  const acp = new EventEmitter();
  acp.exitCode = null;
  acp.signalCode = null;
  let terminated = false;
  let exited = false;
  acp.kill = (signal) => {
    assert.equal(signal, "SIGTERM");
    terminated = true;
    setImmediate(() => {
      acp.signalCode = signal;
      exited = true;
      acp.emit("exit", null, signal);
    });
  };
  await assert.rejects(stopBridgePair({ bridge, acp }), /bridge exited with 1/u);
  assert.equal(terminated, true);
  assert.equal(exited, true);
});
