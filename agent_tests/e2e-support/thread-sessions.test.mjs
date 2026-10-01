import assert from "node:assert/strict";
import test from "node:test";

import { renderMatrixResponse } from "../../dist/response-rendering.js";
import { matrixHtmlContent } from "../../dist/matrix-message-content.js";
import { renderMatrixText } from "../../dist/matrix-text-rendering.js";
import { assertThreadResponse, ThreadSessionMonitor } from "./thread-sessions.mjs";

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
