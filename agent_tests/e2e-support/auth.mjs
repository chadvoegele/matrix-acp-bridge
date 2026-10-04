import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function selectAuthMode(environment = process.env) {
  const configuredTokens = Object.keys(environment).some((name) =>
    /^E2E_(?:BRIDGE|SENDER|HELPER)_(?:ACCESS_TOKEN_FILE|DEVICE_ID|STATE_DIR)$/u.test(name),
  );
  const mode = environment.E2E_AUTH_MODE ?? (configuredTokens ? "token" : "cache");
  if (!["token", "password", "cache"].includes(mode)) throw new Error("E2E_AUTH_MODE must be token, cache or password");
  if (mode !== "token" && configuredTokens)
    throw new Error("Configured tokens cannot be combined with password mode; select E2E_AUTH_MODE=token");
  return mode;
}

export function roleAuthentication(role, mode = selectAuthMode(), environment = process.env) {
  const prefix = `E2E_${role.toUpperCase()}`;
  const required = (name) => {
    if (!environment[name]) throw new Error(`${name} is required for ${mode} mode`);
    return environment[name];
  };
  if (mode === "cache") return {};
  if (mode === "password")
    return { password: required(role === "helper" ? "E2E_BRIDGE_PASSWORD" : `${prefix}_PASSWORD`) };
  const tokenFile = required(`${prefix}_ACCESS_TOKEN_FILE`);
  const stateDir = required(`${prefix}_STATE_DIR`);
  if (![tokenFile, stateDir].every((path) => isAbsolute(path)))
    throw new Error(`${prefix} token and state paths must be absolute`);
  return { tokenFile, stateDir, deviceId: required(`${prefix}_DEVICE_ID`), ownership: "reusable" };
}

export function pathsOverlap(first, second) {
  const path = relative(resolve(first), resolve(second));
  return (
    path === "" ||
    (!path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && path !== ".." && !isAbsolute(path))
  );
}

export async function validatePrivatePath(path, directory = false) {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    (directory ? !metadata.isDirectory() : !metadata.isFile()) ||
    (metadata.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    metadata.uid !== process.getuid() ||
    (await realpath(path)) !== resolve(path)
  ) {
    throw new Error("Token/state paths must be private, owned, canonical regular files/directories (0600/0700)");
  }
}

export async function validateTokenIdentity(homeserver, identity, token) {
  const headers = { authorization: `Bearer ${token}` };
  const response = await fetch(`${homeserver}/_matrix/client/v3/account/whoami`, { headers });
  if (!response.ok)
    throw new Error(`Test token whoami failed: HTTP ${response.status}; supply an active designated test token`);
  const body = await response.json();
  if (body.user_id !== identity.userId || body.device_id !== identity.deviceId || body.is_guest === true) {
    throw new Error("Test token user/device mismatch; supply the token for the configured test device");
  }
  const device = await fetch(`${homeserver}/_matrix/client/v3/devices/${encodeURIComponent(identity.deviceId)}`, {
    headers,
  });
  const deviceBody = await device.json();
  if (!device.ok || deviceBody.device_id !== identity.deviceId)
    throw new Error("Test token device is unavailable; restore the designated device credentials");
}

export function deviceBinding(environment, identity, role) {
  return {
    version: 1,
    homeserver: environment.homeserver,
    roomId: environment.roomId,
    userId: identity.userId,
    deviceId: identity.deviceId,
    stateDir: identity.stateDir,
    transport: environment.transport,
    responseMode: environment.responseMode,
    role,
  };
}

export async function validateReusableState(environment, identity, role) {
  const expected = deviceBinding(environment, identity, role);
  const path = `${identity.tokenFile}.e2e-device-binding.json`;
  await validatePrivatePath(dirname(identity.tokenFile), true);
  let binding;
  try {
    await validatePrivatePath(path);
    binding = JSON.parse(await readFile(path, "utf8"));
    if (JSON.stringify(binding) !== JSON.stringify(expected))
      throw new Error(
        "Test device is bound to another room, mode, role or state; supply a separate test-device profile",
      );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (environment.transport === "encrypted" && !identity.cacheCryptoInitial) {
    const { openCryptoStateStore } = await import("../../dist/crypto-state.js");
    const store = await openCryptoStateStore({ stateDir: identity.stateDir, identity: expected });
    // Reusable devices must already have their original device-bound snapshot.
    // This checks identity, bootstrap and database completeness before normal SAS.
    const manifest = store.assertReadyForVerification();
    const snapshotPath = join(identity.stateDir, "matrix-crypto", ".indexeddb.snapshot");
    await validatePrivatePath(snapshotPath);
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    const prefix = join(identity.stateDir, "matrix-crypto");
    if (
      snapshot.schemaVersion !== 1 ||
      !Array.isArray(snapshot.databases) ||
      !["matrix-sdk-crypto", "matrix-sdk-crypto-meta"].every((suffix) =>
        snapshot.databases.some(
          (database) =>
            database.name === `${prefix}::${suffix}` &&
            Array.isArray(database.objectStores) &&
            (suffix === "matrix-sdk-crypto-meta" ||
              database.objectStores.some((objectStore) => objectStore.records?.length > 0)),
        ),
      )
    ) {
      throw new Error(
        "Reusable crypto snapshot is missing its device databases; restore the original store without moving it",
      );
    }
    const tokenContents = await readFile(identity.tokenFile, "utf8");
    const token = tokenContents.trim();
    const response = await fetch(`${environment.homeserver}/_matrix/client/v3/keys/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ device_keys: { [identity.userId]: [identity.deviceId] } }),
    });
    const body = await response.json();
    const keys = body.device_keys?.[identity.userId]?.[identity.deviceId]?.keys;
    if (
      !response.ok ||
      keys?.[`ed25519:${identity.deviceId}`] !== manifest.ed25519Fingerprint ||
      keys?.[`curve25519:${identity.deviceId}`] !== manifest.curve25519Fingerprint
    ) {
      throw new Error(
        "Reusable test-device keys do not match the retained crypto manifest; restore its original store",
      );
    }
  }
  if (role === "bridge") {
    const { openBridgeStateStore } = await import("../../dist/bridge-state.js");
    const store = await openBridgeStateStore({ stateDir: identity.stateDir, identity: expected });
    if (!store.getSnapshot().initialized && !identity.cacheInitial) {
      throw new Error(
        "Reusable bridge token requires its initialized delivery state; restore the original completed-event ledger",
      );
    }
    if (!binding && store.getConversationRecords().some((record) => record.sessionId !== undefined)) {
      throw new Error("Unbound test state contains ACP sessions; recover its owned sessions before adopting tokens");
    }
  }
  return { path, binding: expected };
}

export async function claimReusableState(environmentPath, identity) {
  const leasePath = join(identity.stateDir, "e2e-active-environment.json");
  try {
    await writeFile(leasePath, `${JSON.stringify({ environmentPath })}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Test device state is in use or interrupted; recover its retained environment before provisioning",
      );
    throw error;
  }
}

export async function assertReusableAdapterFingerprints(environment, role, adapter) {
  if (environment[role].ownership !== "reusable") return;
  const { openCryptoStateStore } = await import("../../dist/crypto-state.js");
  const store = await openCryptoStateStore({
    stateDir: environment[role].stateDir,
    identity: { homeserver: environment.homeserver, ...environment[role] },
  });
  store.assertReadyForVerification(await adapter.getDeviceKeyFingerprints());
}

export async function assertReusableStateAvailable(identity) {
  try {
    await lstat(join(identity.stateDir, "e2e-active-environment.json"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    "Test device state is in use or interrupted; recover its retained environment before inspecting state",
  );
}
