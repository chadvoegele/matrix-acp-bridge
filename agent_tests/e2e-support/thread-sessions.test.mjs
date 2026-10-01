import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderMatrixResponse } from "../../dist/response-rendering.js";
import { matrixHtmlContent } from "../../dist/matrix-message-content.js";
import { renderMatrixText } from "../../dist/matrix-text-rendering.js";
import { assertThreadResponse, ThreadSessionMonitor } from "./thread-sessions.mjs";
import { savedAcpSessionIds } from "./cleanup.mjs";

test("live thread assertions accept bridge follow-ups with distinct roots and fallback targets", () => {
  const [response] = renderMatrixResponse({
    roomId: "!room:example.org",
    inboundEventId: "$followup",
    threadRootEventId: "$root",
    threadInReplyToEventId: "$followup",
    outcome: { kind: "reset" },
    maxOutputBytes: 4096,
    maxMatrixMessageBytes: 4096,
  });
  const content = matrixHtmlContent({ ...renderMatrixText(response.content.body), ...response });
  assertThreadResponse(content, "$root", "$followup");
  assert.throws(() => assertThreadResponse(content, "$other-root", "$followup"), /thread root/u);
  assert.throws(() => assertThreadResponse(content, "$root", "$root"), /fallback reply/u);
  assert.throws(() => assertThreadResponse({}, "$root", "$followup"), /thread relation/u);
  assert.throws(
    () =>
      assertThreadResponse(
        { ...content, "m.relates_to": { ...content["m.relates_to"], is_falling_back: false } },
        "$root",
        "$followup",
      ),
    /fallback flag/u,
  );
});

test("live monitor reads ACP v1 load capability and distinguishes lazy load from fresh creation", () => {
  const monitor = new ThreadSessionMonitor();
  monitor.inspect({ id: 1, method: "initialize" }, "outbound");
  monitor.inspect({ id: 99, result: { agentCapabilities: { loadSession: true } } }, "inbound");
  assert.equal(monitor.loadSupported, false, "unmatched response changed capability");
  monitor.inspect({ id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }, "inbound");
  assert.equal(monitor.loadSupported, true);
  monitor.inspect({ id: 2, method: "session/new" }, "outbound");
  monitor.inspect({ id: 2, result: { sessionId: "original-session" } }, "inbound");
  monitor.inspect({ id: 3, method: "session/load", params: { sessionId: "original-session" } }, "outbound");
  monitor.inspect({ id: 3, result: { sessionId: "original-session" } }, "inbound");
  monitor.inspect(
    {
      id: 4,
      method: "session/prompt",
      params: { sessionId: "original-session", prompt: [{ type: "text", text: "followup" }] },
    },
    "outbound",
  );
  assert.deepEqual([...monitor.sessionIds], ["original-session"]);
  assert.deepEqual(monitor.loadedSessions, ["original-session"]);
  assert.equal(monitor.promptSessions.get("followup"), "original-session");
  monitor.inspect({ id: 5, method: "initialize" }, "outbound");
  monitor.inspect({ id: 5, result: { agentCapabilities: { sessionCapabilities: { loadSession: true } } } }, "inbound");
  assert.equal(monitor.loadSupported, false, "nonstandard capability shape must not select load scenarios");
});

test("no-load session IDs survive sender failure, concurrent creation and detached reset sessions", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-thread-session-ids-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const sessionIdsPath = join(stateDir, "e2e-session-ids.json");
  const monitor = new ThreadSessionMonitor(sessionIdsPath);
  monitor.inspect({ id: 1, method: "initialize" }, "outbound");
  monitor.inspect({ id: 1, result: { agentCapabilities: { loadSession: false } } }, "inbound");

  await assert.rejects(async () => {
    try {
      for (const id of [2, 3, 4]) monitor.inspect({ id, method: "session/new" }, "outbound");
      // Replies arrive out of order while the prior private-file write is pending.
      for (const [id, sessionId] of [
        [3, "other-thread"],
        [2, "before-reset"],
        [4, "after-reset"],
      ]) {
        monitor.inspect({ id, result: { sessionId } }, "inbound");
      }
      throw new Error("sender failed before exchange completed");
    } finally {
      await monitor.flushSessionIds();
    }
  }, /sender failed/u);

  assert.equal(monitor.loadSupported, false);
  assert.deepEqual(await savedAcpSessionIds({ bridge: { stateDir } }, [sessionIdsPath]), [
    "other-thread",
    "before-reset",
    "after-reset",
  ]);
  const sessionIdsStat = await stat(sessionIdsPath);
  assert.equal(sessionIdsStat.mode & 0o777, 0o600);
});

test("session-ID persistence errors surface when the runner flushes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "matrix-acp-thread-session-write-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blockedParent = join(directory, "file-instead-of-directory");
  await writeFile(blockedParent, "blocked");
  const monitor = new ThreadSessionMonitor(join(blockedParent, "e2e-session-ids.json"));
  monitor.inspect({ id: 1, method: "session/new" }, "outbound");
  monitor.inspect({ id: 1, result: { sessionId: "created-session" } }, "inbound");
  // Let rejection occur before flush to cover the wire tap's detached write.
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(monitor.flushSessionIds(), (error) => error.code === "EEXIST" || error.code === "ENOTDIR");
});
