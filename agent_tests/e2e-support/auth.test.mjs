import assert from "node:assert/strict";
import { serialize } from "node:v8";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { roleAuthentication, selectAuthMode } from "./auth.mjs";
import { provisionEnvironment } from "./common.mjs";
import { cleanupEnvironment } from "./cleanup.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "matrix-token-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentialRoot = join(root, "credentials");
  await mkdir(credentialRoot, { mode: 0o700 });
  const stateDir = join(credentialRoot, "state");
  await mkdir(stateDir, { mode: 0o700 });
  const tokenFile = join(credentialRoot, "token");
  await writeFile(tokenFile, "supplied-test-token\n", { mode: 0o600 });
  const identity = {
    name: "bridge",
    userId: "@test:example.org",
    deviceId: "TEST",
    tokenFile,
    stateDir,
    ownership: "reusable",
    state: true,
    config: true,
  };
  const { openBridgeStateStore } = await import("../../dist/bridge-state.js");
  const initialStore = await openBridgeStateStore({
    stateDir,
    identity: { homeserver: "https://example.org", ...identity },
  });
  await initialStore.establishInitialBaseline([]);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    assert.ok(!url.endsWith("/login") && !url.endsWith("/logout"));
    return {
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith("/whoami")
          ? { user_id: identity.userId, device_id: identity.deviceId }
          : { device_id: identity.deviceId },
    };
  });
  const options = {
    homeserver: "https://example.org",
    roomId: "!test:example.org",
    acpCwd: "/tmp",
    acpCommand: ["test-acp"],
    privateRoot: join(root, "run"),
    environmentPath: join(root, "environment.json"),
    roles: [identity],
    makeConfig: () => "test config",
    message: "Prepared contract fixture",
  };
  return { root, identity, requests, options };
}

test("token selection is automatic, complete, and never falls back to passwords", () => {
  assert.equal(selectAuthMode({}), "cache");
  assert.equal(selectAuthMode({ E2E_BRIDGE_ACCESS_TOKEN_FILE: "/test" }), "token");
  assert.equal(selectAuthMode({ E2E_BRIDGE_ACCESS_TOKEN_FILE: "" }), "token");
  assert.equal(selectAuthMode({ E2E_SENDER_STATE_DIR: "/test-state" }), "token");
  assert.throws(() => selectAuthMode({ E2E_AUTH_MODE: "other" }), /must be/u);
  assert.throws(
    () => selectAuthMode({ E2E_AUTH_MODE: "password", E2E_SENDER_ACCESS_TOKEN_FILE: "/test" }),
    /cannot be combined/u,
  );
  assert.throws(
    () => roleAuthentication("bridge", "token", { E2E_BRIDGE_PASSWORD: "ignored" }),
    /ACCESS_TOKEN_FILE is required/u,
  );
  assert.throws(() => roleAuthentication("helper", "token", {}), /HELPER_ACCESS_TOKEN_FILE/u);
  assert.throws(
    () =>
      roleAuthentication("bridge", "token", { E2E_BRIDGE_ACCESS_TOKEN_FILE: "/token", E2E_BRIDGE_STATE_DIR: "/state" }),
    /DEVICE_ID is required/u,
  );
  assert.throws(
    () =>
      roleAuthentication("sender", "token", {
        E2E_SENDER_ACCESS_TOKEN_FILE: "relative",
        E2E_SENDER_STATE_DIR: "/state",
        E2E_SENDER_DEVICE_ID: "TEST",
      }),
    /absolute/u,
  );
});

test("repeated token provisioning/cleanup preserves credentials, crypto bytes and the initialized ledger", async (t) => {
  const { identity, requests, options } = await fixture(t);
  const { openBridgeStateStore } = await import("../../dist/bridge-state.js");
  const store = await openBridgeStateStore({
    stateDir: identity.stateDir,
    identity: { homeserver: options.homeserver, ...identity },
  });
  await store.markEventCompleted(options.roomId, "$completed");
  const cryptoPath = join(identity.stateDir, "original-crypto-snapshot");
  await writeFile(cryptoPath, "private persistent bytes", { mode: 0o600 });
  for (let run = 0; run < 2; run += 1) {
    await provisionEnvironment(options);
    const environment = JSON.parse(await readFile(options.environmentPath, "utf8"));
    assert.equal(environment.bridge.tokenFile, identity.tokenFile);
    assert.equal(environment.bridge.stateDir, identity.stateDir);
    await cleanupEnvironment(options.environmentPath, environment, { roles: ["bridge"] });
    assert.equal(await readFile(identity.tokenFile, "utf8"), "supplied-test-token\n");
    assert.equal(await readFile(cryptoPath, "utf8"), "private persistent bytes");
    const state = JSON.parse(await readFile(join(identity.stateDir, "bridge-state.json"), "utf8"));
    assert.equal(state.initialized, true);
    assert.deepEqual(state.completedEventIds[options.roomId], ["$completed"]);
    await assert.rejects(stat(options.environmentPath), { code: "ENOENT" });
  }
  assert.equal(requests.length, 4);
});

test("token/user/device mismatches and device-less tokens fail before touching supplied state", async (t) => {
  const { identity, options } = await fixture(t);
  for (const body of [
    { user_id: "@other:example.org", device_id: "TEST" },
    { user_id: identity.userId, device_id: "OTHER" },
    { user_id: identity.userId },
  ]) {
    t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => body }));
    await assert.rejects(provisionEnvironment(options), /mismatch/u);
    await assert.rejects(stat(options.environmentPath), { code: "ENOENT" });
  }
});

test("token bindings reject room, mode and store replacement", async (t) => {
  const { identity, options } = await fixture(t);
  await provisionEnvironment(options);
  await cleanupEnvironment(options.environmentPath, JSON.parse(await readFile(options.environmentPath, "utf8")), {
    roles: ["bridge"],
  });
  await assert.rejects(provisionEnvironment({ ...options, roomId: "!another:example.org" }), /bound to another/u);
  await assert.rejects(provisionEnvironment({ ...options, responseMode: "thread" }), /bound to another/u);
  const replacement = join(identity.stateDir, "replacement");
  await mkdir(replacement, { mode: 0o700 });
  await assert.rejects(
    provisionEnvironment({ ...options, roles: [{ ...identity, stateDir: replacement }] }),
    /bound to another/u,
  );
});

test("reusable encrypted devices require established crypto and cannot bootstrap a replacement store", async (t) => {
  const { identity, options } = await fixture(t);
  await assert.rejects(provisionEnvironment({ ...options, transport: "encrypted" }), /manifest-absent/u);
  await assert.rejects(stat(join(identity.stateDir, "matrix-crypto")), { code: "ENOENT" });
});

test("active reusable state blocks parallel provisioning and cleanup cannot claim another run's store", async (t) => {
  const { options, identity } = await fixture(t);
  await provisionEnvironment(options);
  const second = {
    ...options,
    privateRoot: join(options.privateRoot, "other"),
    environmentPath: join(options.privateRoot, "other-environment.json"),
  };
  const stagingPath = join(identity.stateDir, ".bridge-state.json.active.tmp");
  await writeFile(stagingPath, "active writer staging bytes", { mode: 0o600 });
  await assert.rejects(provisionEnvironment(second), /in use or interrupted/u);
  assert.equal(await readFile(stagingPath, "utf8"), "active writer staging bytes");
  await assert.rejects(stat(second.environmentPath), { code: "ENOENT" });
  assert.equal(await readFile(identity.tokenFile, "utf8"), "supplied-test-token\n");
  assert.equal(
    JSON.parse(await readFile(join(identity.stateDir, "e2e-active-environment.json"), "utf8")).environmentPath,
    options.environmentPath,
  );
});

test("partial provisioning preserves issued tokens and recovery provenance after a login failure", async (t) => {
  const { options } = await fixture(t);
  let logins = 0;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(url);
    if (url.endsWith("/logout")) return { ok: false, status: 503 };
    logins += 1;
    const body = JSON.parse(init.body);
    return {
      ok: logins === 1,
      status: logins === 1 ? 200 : 429,
      json: async () => ({
        user_id: body.identifier.user,
        device_id: body.device_id,
        access_token: "owned-test-token",
      }),
    };
  });
  await assert.rejects(
    provisionEnvironment({
      ...options,
      roles: ["bridge", "sender"].map((name) => ({
        name,
        userId: `@${name}:example.org`,
        deviceId: name,
        password: "not-persisted",
        state: true,
      })),
    }),
    /HTTP 429/u,
  );
  assert.equal(logins, 2);
  const environment = JSON.parse(await readFile(options.environmentPath, "utf8"));
  assert.equal(environment.bridge.ownership, "owned");
  assert.equal(await readFile(environment.bridge.tokenFile, "utf8"), "owned-test-token\n");
  await assert.rejects(
    cleanupEnvironment(options.environmentPath, environment, { roles: ["bridge", "sender"] }),
    /preserved/u,
  );
  assert.ok(await stat(options.environmentPath));
  assert.ok(await stat(environment.bridge.tokenFile));
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.ok(url.endsWith("/logout"));
    return { ok: true };
  });
  await cleanupEnvironment(options.environmentPath, environment, { roles: ["bridge", "sender"] });
  await assert.rejects(stat(options.privateRoot), { code: "ENOENT" });
});

test("cleanup with ambiguous ownership fails before any credential or session mutation", async (t) => {
  const { options } = await fixture(t);
  await provisionEnvironment(options);
  const environment = JSON.parse(await readFile(options.environmentPath, "utf8"));
  delete environment.bridge.ownership;
  await assert.rejects(
    cleanupEnvironment(options.environmentPath, environment, { roles: ["bridge"] }),
    /explicit device ownership/u,
  );
  assert.ok(await stat(options.environmentPath));
});

test("encrypted token provisioning compares server keys, rejects missing snapshots and preserves valid crypto on cleanup", async (t) => {
  const { identity, options } = await fixture(t);
  const { ensureCryptoDatabaseDirectory, openCryptoStateStore } = await import("../../dist/crypto-state.js");
  const databasePath = await ensureCryptoDatabaseDirectory(identity.stateDir);
  const store = await openCryptoStateStore({
    stateDir: identity.stateDir,
    identity: { homeserver: options.homeserver, ...identity },
  });
  const fingerprints = { ed25519Fingerprint: "test-ed-key", curve25519Fingerprint: "test-curve-key" };
  await store.recordBootstrap(fingerprints);
  await assert.rejects(provisionEnvironment({ ...options, transport: "encrypted" }), { code: "ENOENT" });
  const snapshot = {
    schemaVersion: 1,
    databases: ["matrix-sdk-crypto", "matrix-sdk-crypto-meta"].map((suffix) => ({
      name: `${databasePath}::${suffix}`,
      objectStores: [{ records: ["opaque-private-test-record"] }],
    })),
  };
  const snapshotPath = join(databasePath, ".indexeddb.snapshot");
  await writeFile(snapshotPath, serialize(snapshot), { mode: 0o600 });
  let serverEdKey = "wrong-device-key";
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (url.endsWith("/whoami")) return { user_id: identity.userId, device_id: identity.deviceId };
      if (url.endsWith("/keys/query"))
        return {
          device_keys: {
            [identity.userId]: {
              [identity.deviceId]: {
                keys: {
                  [`ed25519:${identity.deviceId}`]: serverEdKey,
                  [`curve25519:${identity.deviceId}`]: fingerprints.curve25519Fingerprint,
                },
              },
            },
          },
        };
      assert.ok(url.includes("/devices/"));
      return { device_id: identity.deviceId };
    },
  }));
  await assert.rejects(provisionEnvironment({ ...options, transport: "encrypted" }), /keys do not match/u);
  await writeFile(snapshotPath, "invalid-private-snapshot-contents", { mode: 0o600 });
  await assert.rejects(provisionEnvironment({ ...options, transport: "encrypted" }), (error) => {
    assert.match(error.message, /snapshot is invalid/u);
    assert.ok(!error.message.includes("invalid-private-snapshot-contents"));
    return true;
  });
  await writeFile(snapshotPath, serialize(snapshot), { mode: 0o600 });
  serverEdKey = fingerprints.ed25519Fingerprint;
  const manifestPath = join(identity.stateDir, "crypto-state.json");
  const manifestBytes = await readFile(manifestPath);
  const snapshotBytes = await readFile(snapshotPath);
  await provisionEnvironment({ ...options, transport: "encrypted" });
  await cleanupEnvironment(options.environmentPath, JSON.parse(await readFile(options.environmentPath, "utf8")), {
    roles: ["bridge"],
  });
  assert.deepEqual(await readFile(snapshotPath), snapshotBytes);
  assert.deepEqual(await readFile(manifestPath), manifestBytes);
});

test("reusable cleanup deletes owned ACP sessions and detaches mappings without removing the ledger", async (t) => {
  const { identity, options } = await fixture(t);
  await provisionEnvironment(options);
  const environment = JSON.parse(await readFile(options.environmentPath, "utf8"));
  const { openBridgeStateStore } = await import("../../dist/bridge-state.js");
  const store = await openBridgeStateStore({
    stateDir: identity.stateDir,
    identity: { homeserver: options.homeserver, ...identity },
  });
  await store.markEventCompleted(options.roomId, "$completed");
  await store.setSessionMapping(options.roomId, "owned-session");
  const deletedPath = join(identity.stateDir, "test-deleted-sessions.json");
  const peerPath = join(options.privateRoot, "cleanup-peer.mjs");
  await writeFile(
    peerPath,
    `import {createInterface} from 'node:readline'; import {writeFileSync} from 'node:fs'; const deleted=[]; createInterface({input:process.stdin}).on('line',line=>{ const m=JSON.parse(line); if(m.method==='session/delete'){deleted.push(m.params.sessionId);writeFileSync(${JSON.stringify(deletedPath)},JSON.stringify(deleted));} console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{agentCapabilities:{sessionCapabilities:{delete:{}}}}:{}})); });`,
  );
  environment.acpCommand = [process.execPath, peerPath];
  const originalLedger = JSON.parse(
    await readFile(join(identity.stateDir, "bridge-state.json"), "utf8"),
  ).completedEventIds;
  await cleanupEnvironment(options.environmentPath, environment, { roles: ["bridge"] });
  const after = JSON.parse(await readFile(join(identity.stateDir, "bridge-state.json"), "utf8"));
  assert.deepEqual(JSON.parse(await readFile(deletedPath, "utf8")), ["owned-session"]);
  assert.deepEqual(after.sessions, {});
  assert.deepEqual(after.completedEventIds, originalLedger);
  assert.equal(await readFile(identity.tokenFile, "utf8"), "supplied-test-token\n");
});

test("token mode rejects expired credentials and fresh state instead of password login or delivery reset", async (t) => {
  const { identity, options } = await fixture(t);
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.ok(url.endsWith("/whoami"));
    return { ok: false, status: 401 };
  });
  await assert.rejects(provisionEnvironment(options), /HTTP 401/u);
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: true,
    json: async () =>
      url.endsWith("/whoami")
        ? { user_id: identity.userId, device_id: identity.deviceId }
        : { device_id: identity.deviceId },
  }));
  await rm(join(identity.stateDir, "bridge-state.json"));
  await assert.rejects(provisionEnvironment(options), /initialized delivery state/u);
  await assert.rejects(stat(options.environmentPath), { code: "ENOENT" });
});

test("ACP cleanup failure retains reusable credentials, mappings and the recovery claim", async (t) => {
  const { identity, options } = await fixture(t);
  await provisionEnvironment(options);
  const environment = JSON.parse(await readFile(options.environmentPath, "utf8"));
  const { openBridgeStateStore } = await import("../../dist/bridge-state.js");
  const store = await openBridgeStateStore({
    stateDir: identity.stateDir,
    identity: { homeserver: options.homeserver, ...identity },
  });
  await store.setSessionMapping(options.roomId, "owned-session");
  environment.acpCommand = [process.execPath, "-e", "process.exit(1)"];
  await assert.rejects(cleanupEnvironment(options.environmentPath, environment, { roles: ["bridge"] }), /ACP cleanup/u);
  assert.ok(await stat(options.environmentPath));
  assert.ok(await stat(join(identity.stateDir, "e2e-active-environment.json")));
  assert.equal(
    JSON.parse(await readFile(join(identity.stateDir, "bridge-state.json"), "utf8")).sessions[options.roomId],
    "owned-session",
  );
  assert.equal(await readFile(identity.tokenFile, "utf8"), "supplied-test-token\n");
});
