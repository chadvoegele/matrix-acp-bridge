import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cacheDirectory,
  finishCachedSetup,
  hasCachedSas,
  prepareCachedRoles,
  recordCachedBootstrap,
  recordCachedSas,
} from "./cache.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "matrix-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = {
    homeserver: "https://example.org",
    roomId: "!test:example.org",
    transport: "plaintext",
    responseMode: "room",
  };
  const definitions = [{ name: "bridge", userId: "@test:example.org", displayName: "test bridge" }];
  const settings = { E2E_CACHE_DIR: root, E2E_BRIDGE_PASSWORD: "private-test-password" };
  let logins = 0;
  let identity;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.endsWith("/login")) {
      logins += 1;
      const body = JSON.parse(init.body);
      identity = { user_id: body.identifier.user, device_id: body.device_id, access_token: "test-cache-token" };
    }
    return { ok: true, status: 200, json: async () => identity };
  });
  return { root, environment, definitions, settings, logins: () => logins };
}

test("absent cache bootstraps once, binds whoami, reuses without password and never persists password", async (t) => {
  const f = await fixture(t);
  const [first] = await prepareCachedRoles(f.environment, f.definitions, f.settings);
  const [second] = await prepareCachedRoles(f.environment, f.definitions, { E2E_CACHE_DIR: f.root });
  assert.equal(f.logins(), 1);
  assert.equal(first.deviceId, second.deviceId);
  assert.equal(await readFile(first.tokenFile, "utf8"), "test-cache-token\n");
  const tokenMetadata = await stat(first.tokenFile);
  const stateMetadata = await stat(first.stateDir);
  const manifestContents = await readFile(first.cacheManifest, "utf8");
  assert.equal(tokenMetadata.mode & 0o777, 0o600);
  assert.equal(stateMetadata.mode & 0o777, 0o700);
  assert.ok(!manifestContents.includes(f.settings.E2E_BRIDGE_PASSWORD));
});

test("missing password is separately blocked and leaves no ambiguous role profile", async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareCachedRoles(f.environment, f.definitions, { E2E_CACHE_DIR: f.root }), /SETUP BLOCKED/u);
  await prepareCachedRoles(f.environment, f.definitions, f.settings);
  assert.equal(f.logins(), 1);
});

test("429 preserves device identity and retry boundary without repeated login", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return { ok: false, status: 429, json: async () => ({ retry_after_ms: 30_000 }) };
  });
  for (let run = 0; run < 2; run += 1)
    await assert.rejects(prepareCachedRoles(f.environment, f.definitions, f.settings), /SETUP BLOCKED: HTTP 429/u);
  assert.equal(calls, 1);
  const path = join(cacheDirectory(f.environment, f.settings), "bridge/profile.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  assert.equal(manifest.status, "blocked");
  assert.ok(manifest.deviceId);
  assert.ok(manifest.retryAt > Date.now());
});

test("partial/invalid/missing token cache fails closed instead of password fallback", async (t) => {
  const f = await fixture(t);
  const [identity] = await prepareCachedRoles(f.environment, f.definitions, f.settings);
  await rm(identity.tokenFile);
  await assert.rejects(prepareCachedRoles(f.environment, f.definitions, f.settings), { code: "ENOENT" });
  assert.equal(f.logins(), 1);
  await rm(identity.cacheManifest);
  await assert.rejects(prepareCachedRoles(f.environment, f.definitions, f.settings), /Partial cache/u);
  assert.equal(f.logins(), 1);
});

test("identity mismatch and active state lock block reuse without login", async (t) => {
  const f = await fixture(t);
  const [identity] = await prepareCachedRoles(f.environment, f.definitions, f.settings);
  await writeFile(join(identity.stateDir, "e2e-active-environment.json"), "{}", { mode: 0o600 });
  await assert.rejects(prepareCachedRoles(f.environment, f.definitions, f.settings), /in use or interrupted/u);
  await rm(join(identity.stateDir, "e2e-active-environment.json"));
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ user_id: "@other:example.org", device_id: identity.deviceId }),
  }));
  await assert.rejects(prepareCachedRoles(f.environment, f.definitions, f.settings), /mismatch/u);
  assert.equal(f.logins(), 1);
});

test("bootstrap lock and unsafe location prevent concurrent/repository caches", async (t) => {
  const f = await fixture(t);
  const directory = cacheDirectory(f.environment, f.settings);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "bootstrap.lock"), "active", { mode: 0o600 });
  await assert.rejects(prepareCachedRoles(f.environment, f.definitions, f.settings), /active\/interrupted/u);
  await assert.rejects(
    prepareCachedRoles(f.environment, f.definitions, { E2E_CACHE_DIR: process.cwd() }),
    /outside the repository/u,
  );
});

test("crypto and real SAS milestones persist separately, never invent verified state", async (t) => {
  const f = await fixture(t);
  f.environment.transport = "encrypted";
  const [identity] = await prepareCachedRoles(f.environment, f.definitions, f.settings);
  const environment = { ...f.environment, bridge: identity, helper: identity, sender: identity };
  assert.equal(await hasCachedSas(environment), false);
  await recordCachedBootstrap(identity);
  await finishCachedSetup(environment);
  assert.equal(JSON.parse(await readFile(identity.cacheManifest, "utf8")).status, "issued");
  await recordCachedSas(environment);
  assert.equal(await hasCachedSas(environment), true);
  await writeFile(join(identity.stateDir, "bridge-state.json"), JSON.stringify({ initialized: true }), { mode: 0o600 });
  await finishCachedSetup(environment);
  const [reused] = await prepareCachedRoles(f.environment, f.definitions, f.settings);
  assert.equal(reused.cacheInitial, false);
  assert.equal(reused.cacheCryptoInitial, false);
  assert.equal(f.logins(), 1);
});

test("legitimate rate-limit retry retains proposed device instead of creating throwaway logins", async (t) => {
  const f = await fixture(t);
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 429,
    json: async () => ({ retry_after_ms: 1000 }),
  }));
  await assert.rejects(prepareCachedRoles(f.environment, f.definitions, f.settings), /HTTP 429/u);
  const path = join(cacheDirectory(f.environment, f.settings), "bridge/profile.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const originalDevice = manifest.deviceId;
  manifest.retryAt = Date.now() - 1;
  await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
  let logins = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.endsWith("/login")) {
      logins += 1;
      assert.equal(JSON.parse(init.body).device_id, originalDevice);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ user_id: f.definitions[0].userId, device_id: originalDevice, access_token: "retry-token" }),
    };
  });
  const [identity] = await prepareCachedRoles(f.environment, f.definitions, f.settings);
  assert.equal(identity.deviceId, originalDevice);
  assert.equal(logins, 1);
  assert.equal(await readFile(identity.tokenFile, "utf8"), "retry-token\n");
});

test("cached lifecycle retains token/state and refuses lost initialized delivery state", async (t) => {
  const f = await fixture(t);
  const { provisionEnvironment } = await import("./common.mjs");
  const { cleanupEnvironment } = await import("./cleanup.mjs");
  const options = {
    ...f.environment,
    authMode: "cache",
    acpCwd: "/tmp",
    acpCommand: ["unused"],
    privateRoot: join(f.root, "run"),
    environmentPath: join(f.root, "environment.json"),
    roles: f.definitions,
    makeConfig: () => "",
    message: "cache contract",
  };
  const original = { E2E_CACHE_DIR: process.env.E2E_CACHE_DIR, E2E_BRIDGE_PASSWORD: process.env.E2E_BRIDGE_PASSWORD };
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.E2E_CACHE_DIR = f.root;
  process.env.E2E_BRIDGE_PASSWORD = f.settings.E2E_BRIDGE_PASSWORD;
  await provisionEnvironment(options);
  const environment = JSON.parse(await readFile(options.environmentPath, "utf8"));
  const { openBridgeStateStore } = await import("../../dist/bridge-state.js");
  const store = await openBridgeStateStore({
    stateDir: environment.bridge.stateDir,
    identity: { homeserver: environment.homeserver, ...environment.bridge },
  });
  await store.establishInitialBaseline([]);
  await store.markEventCompleted(environment.roomId, "$completed");
  await cleanupEnvironment(options.environmentPath, environment, { roles: ["bridge"] });
  await provisionEnvironment(options);
  const reused = JSON.parse(await readFile(options.environmentPath, "utf8"));
  assert.equal(reused.bridge.cacheInitial, false);
  assert.equal(f.logins(), 1);
  await cleanupEnvironment(options.environmentPath, reused, { roles: ["bridge"] });
  await rm(join(environment.bridge.stateDir, "bridge-state.json"));
  await assert.rejects(provisionEnvironment(options), /initialized delivery state/u);
  assert.equal(f.logins(), 1);
});

test("malformed rate-limit profile fails closed without attempting password login", async (t) => {
  const f = await fixture(t);
  const [identity] = await prepareCachedRoles(f.environment, f.definitions, f.settings);
  const manifest = JSON.parse(await readFile(identity.cacheManifest, "utf8"));
  manifest.status = "blocked";
  manifest.retryAt = "invalid";
  await writeFile(identity.cacheManifest, JSON.stringify(manifest), { mode: 0o600 });
  await assert.rejects(prepareCachedRoles(f.environment, f.definitions, f.settings), /Invalid\/partial cache/u);
  assert.equal(f.logins(), 1);
});
