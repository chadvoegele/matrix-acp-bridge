import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDiagnostics, runSender, startBridgePair, stopBridgePair } from "../e2e-support/acp.mjs";
import { readEnvironment, repoRoot } from "../e2e-support/common.mjs";

if (process.env.E2E_LIVE_LOCK_HELD !== "1")
  throw new Error("Hold the shared live lock across provisioning, run and cleanup");
const environmentPath = process.argv[2];
if (!environmentPath) throw new Error("usage: node run.mjs ENVIRONMENT");
const environment = await readEnvironment(environmentPath);
assert.equal(environment.transport, "encrypted");
const id = randomBytes(6).toString("hex").toUpperCase();
const expectations = [1, 2, 3].map((index) => `OUTAGE_${id}_${index}`);
const flag = join(dirname(environmentPath), "outage.flag");
const preload = pathToFileURL(join(repoRoot, "agent_tests/test_matrix_outage/http-blackhole.mjs")).href;
const senderPath = join(
  repoRoot,
  environment.responseMode === "thread"
    ? "agent_tests/test_thread_sessions/encrypted-sender.mjs"
    : "agent_tests/test_encrypted_message/sender.mjs",
);
const promptCounts = new Map();
let arm = false;
let outageStart;
let restore;
let pair;
try {
  const previousOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previousOptions ?? ""} --import=${preload}`;
  process.env.MATRIX_OUTAGE_FLAG = flag;
  try {
    pair = await startBridgePair(environment, {
      onPair(value) {
        pair = value;
      },
      onOutbound(frame) {
        if (frame.method !== "session/prompt") return;
        const text = frame.params.prompt.find((part) => part.type === "text")?.text;
        promptCounts.set(text, (promptCounts.get(text) ?? 0) + 1);
      },
      onInbound(frame) {
        if (!arm || frame.params?.update?.content?.text !== expectations[1]) return;
        arm = false;
        writeFileSync(flag, "", { mode: 0o600 });
        outageStart = Date.now();
        restore = new Promise((resolve, reject) => {
          setTimeout(() => {
            rm(flag).then(resolve, reject);
          }, 60_000);
        });
        process.stdout.write("Blackholing new bridge HTTP requests for 60 seconds.\n");
      },
    });
  } finally {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
    delete process.env.MATRIX_OUTAGE_FLAG;
  }
  for (const [index, expected] of expectations.entries()) {
    if (index === 1) arm = true;
    const prompt = `Reply with exactly: ${expected}`;
    const result = await runSender({ environmentPath, senderPath, args: ["--prompt", prompt, "--expect", expected] });
    assert.equal(result.responseCount, 1);
    assert.equal(result.promptWireType, "m.room.encrypted");
    assert.equal(result.responseWireType, "m.room.encrypted");
    assert.equal(promptCounts.get(prompt), 1);
    process.stdout.write(`Encrypted exchange ${index + 1} passed.\n`);
  }
  assert.ok(outageStart);
  await restore;
  const sends = parseDiagnostics(pair.bridgeDiagnostics()).filter((entry) => entry.event === "outage-http-send");
  const blocked = sends.filter((entry) => entry.blocked && entry.stage === "start");
  assert.ok(blocked.length > 0, "must exercise a stalled outbound HTTP attempt");
  const rejectionAges = [];
  for (const first of blocked) {
    const rejected = sends.find(
      (entry) => entry.transaction === first.transaction && entry.stage === "reject" && entry.time >= first.time,
    );
    assert.ok(rejected, "stalled attempt must reject");
    rejectionAges.push(rejected.time - first.time);
    assert.ok(
      rejected.time - first.time >= 29_000 && rejected.time - first.time < 40_000,
      "HTTP deadline should be 30 seconds",
    );
    assert.ok(
      sends.some((entry) => entry.transaction === first.transaction && !entry.blocked && entry.stage === "response"),
      "retry must succeed with the original transaction",
    );
  }
  let active = 0;
  for (const entry of sends) {
    active += entry.stage === "start" ? 1 : -1;
    assert.ok(active >= 0 && active <= 1, "outbound HTTP sends must not overlap");
  }
  assert.equal(active, 0);
  await stopBridgePair(pair);
  pair = undefined;
  process.stdout.write(
    `${JSON.stringify({ event: "outage-test-passed", outageMs: 60_000, blockedSendAttempts: blocked.length, rejectionAgesMs: rejectionAges, exchanges: 3, overlappingSends: 0 })}\n`,
  );
} finally {
  if (restore) await restore;
  await rm(flag, { force: true });
  if (pair) await stopBridgePair(pair);
}
