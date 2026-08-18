import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { provisionEnvironment } from "./common.mjs";

test("provisions with an in-memory password without persisting it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "matrix-acp-e2e-support-"));
  const password = "test-password-never-persisted";
  const requestBodies = [];
  context.after(async () => rm(root, { recursive: true, force: true }));
  context.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    requestBodies.push(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "test-access-token",
        device_id: body.device_id,
        user_id: body.identifier.user,
      }),
    };
  });

  const environmentPath = join(root, "environment.json");
  await provisionEnvironment({
    homeserver: "https://matrix.example.test",
    roomId: "!room:example.test",
    acpCwd: "/tmp",
    acpCommand: ["test-acp"],
    privateRoot: join(root, "private"),
    environmentPath,
    roles: [{
      name: "sender",
      userId: "@sender:example.test",
      deviceId: "TESTDEVICE",
      password,
      displayName: "Test sender",
    }],
    makeConfig: () => "",
    message: "Provisioned test device.",
  });

  assert.equal(requestBodies.length, 1);
  assert.equal(requestBodies[0].password, password);
  assert.doesNotMatch(await readFile(environmentPath, "utf8"), new RegExp(password));
});
