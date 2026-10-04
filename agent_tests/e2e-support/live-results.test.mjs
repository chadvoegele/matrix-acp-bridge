import assert from "node:assert/strict";
import test from "node:test";
import { liveExitCode, runIndependentCases } from "./live-results.mjs";

test("blocked fresh setup never prevents independent cached/plaintext functional cases", async () => {
  const results = await runIndependentCases(
    [{ name: "fresh" }, { name: "plain" }, { name: "encrypted-cache" }],
    async ({ name }) => ({
      name,
      setup: name === "fresh" ? "BLOCKED" : "REUSED",
      function: name === "fresh" ? "SKIPPED" : "PASSED",
      cleanup: "PASSED",
    }),
  );
  assert.equal(results.length, 3);
  assert.equal(results[1].function, "PASSED");
  assert.equal(results[2].function, "PASSED");
  assert.equal(liveExitCode(results), 2);
});

test("aggregate distinguishes failed function, blocked setup and complete pass", () => {
  assert.equal(liveExitCode([{ setup: "PASSED", function: "PASSED", cleanup: "PASSED" }]), 0);
  assert.equal(liveExitCode([{ setup: "BLOCKED", function: "SKIPPED", cleanup: "PASSED" }]), 2);
  assert.equal(liveExitCode([{ setup: "REUSED", function: "FAILED", cleanup: "PASSED" }]), 1);
});
