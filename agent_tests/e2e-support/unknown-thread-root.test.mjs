import assert from "node:assert/strict";
import test from "node:test";

import { createUnknownThreadRoot } from "./unknown-thread-root.mjs";

const environment = { homeserver: "https://matrix.invalid", roomId: "!room:invalid" };

test("unknown-thread fixture uses an existing top-level event from the bridge account", async () => {
  const root = await createUnknownThreadRoot(environment, "test-bridge-token", async (url, options) => {
    assert.match(url, /\/rooms\/!room%3Ainvalid\/send\/m.room.message\/mab_unknown_root_[a-f0-9]+$/u);
    assert.equal(options.method, "PUT");
    assert.equal(options.headers.authorization, "Bearer test-bridge-token");
    assert.deepEqual(JSON.parse(options.body), { msgtype: "m.text", body: "Unknown thread root fixture." });
    return { ok: true, json: async () => ({ event_id: "$existing-self-authored-root" }) };
  });
  assert.equal(root, "$existing-self-authored-root");
});

test("unknown-thread fixture rejects homeserver failures without exposing response details", async () => {
  await assert.rejects(
    createUnknownThreadRoot(environment, "test-bridge-token", async () => ({ ok: false, status: 400 })),
    /^Error: Unknown thread root creation failed: HTTP 400$/u,
  );
});

test("unknown-thread fixture requires the homeserver's event ID", async () => {
  for (const body of [{}, { event_id: "" }, { event_id: 42 }]) {
    await assert.rejects(
      createUnknownThreadRoot(environment, "test-bridge-token", async () => ({ ok: true, json: async () => body })),
      /did not return an event ID/u,
    );
  }
});

test("fixture respects server retry timing and reuses its transaction ID", async () => {
  const requests = [];
  const delays = [];
  const root = await createUnknownThreadRoot(
    environment,
    "test-token",
    async (url) => {
      requests.push(url);
      return requests.length === 1
        ? { ok: false, status: 429, json: async () => ({ retry_after_ms: 2000 }) }
        : { ok: true, json: async () => ({ event_id: "$root" }) };
    },
    async (delay) => delays.push(delay),
  );
  assert.equal(root, "$root");
  assert.deepEqual(delays, [2000]);
  assert.equal(requests[0], requests[1]);
});

test("fixture refuses unbounded or malformed rate-limit delays", async () => {
  for (const delay of [undefined, -1, "invalid", 180_001])
    await assert.rejects(
      createUnknownThreadRoot(
        environment,
        "test-token",
        async () => ({ ok: false, status: 429, json: async () => ({ retry_after_ms: delay }) }),
        async () => assert.fail("must not retry"),
      ),
      /HTTP 429/u,
    );
});
