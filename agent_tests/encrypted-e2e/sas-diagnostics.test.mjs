import assert from "node:assert/strict";
import { test } from "node:test";

import { SasBridgeDiagnostics } from "./sas-diagnostics.mjs";

test("reports an early bridge exit without exposing process output", () => {
  const diagnostics = new SasBridgeDiagnostics();
  diagnostics.accept(Buffer.from("sensitive Matrix response\n"));
  diagnostics.stderrSeen = true;
  assert.equal(diagnostics.reason, undefined);
  const summary = diagnostics.summary(1, null);
  assert.equal(summary, "exit=1, signal=none, diagnostic=none, stdout=seen, stderr=seen");
  assert.doesNotMatch(summary, /sensitive/u);
});

test("parses split and unterminated structured verification failures", () => {
  const diagnostics = new SasBridgeDiagnostics();
  diagnostics.accept(Buffer.from('{"event":"crypto-verification-failed","fields":{"reason":"proto'));
  diagnostics.accept(Buffer.from('col","secret":"never log me"}}'));
  diagnostics.finish();
  assert.equal(diagnostics.reason, "protocol");
  assert.equal(diagnostics.lastEvent, "crypto-verification-failed");
  assert.doesNotMatch(diagnostics.summary(1, "SIGTERM"), /never log me/u);
});

test("classifies startup errors and rejects untrusted diagnostic values", () => {
  const diagnostics = new SasBridgeDiagnostics();
  diagnostics.accept(
    Buffer.from('\u001B[31m{"event":"startup-failed","fields":{"reason":"private token"}}\u001B[0m\r\n'),
  );
  assert.equal(diagnostics.reason, "startup");
  diagnostics.accept(Buffer.from('{"event":"crypto-verification-failed","fields":{"reason":"private token"}}\n'));
  assert.equal(diagnostics.reason, "unknown");
  assert.equal(
    diagnostics.summary(9999, "private signal"),
    "exit=unknown, signal=none, diagnostic=crypto-verification-failed, stdout=seen, stderr=absent",
  );
});
