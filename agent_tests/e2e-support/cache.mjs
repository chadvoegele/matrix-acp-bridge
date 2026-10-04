import { createHash } from "node:crypto";
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { assertReusableStateAvailable, validatePrivatePath, validateTokenIdentity } from "./auth.mjs";
import { deviceId, login, readToken, writePrivateFile } from "./common.mjs";

export function cacheDirectory(environment, settings = process.env) {
  const root = settings.E2E_CACHE_DIR ?? join(homedir(), ".local/state/matrix-acp-bridge/test-cache");
  if (!isAbsolute(root) || root === "/") throw new Error("E2E_CACHE_DIR must be a private absolute directory");
  const profile = settings.E2E_CACHE_PROFILE ?? "default";
  if (!/^[\w-]+$/u.test(profile)) throw new Error("E2E_CACHE_PROFILE must contain only letters, digits, _ or -");
  const digest = createHash("sha256").update(JSON.stringify(environment)).digest("hex").slice(0, 24);
  return join(root, `${profile}-${digest}`);
}

export async function prepareCachedRoles(environment, definitions, settings = process.env) {
  const directory = cacheDirectory(environment, settings);
  // Refuse repository/worktree storage: caches must survive worktree removal.
  const { repoRoot } = await import("./common.mjs");
  const { execFileSync } = await import("node:child_process");
  const commonGit = resolve(
    repoRoot,
    execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot, encoding: "utf8" }).trim(),
  );
  const repository = resolve(commonGit, "..");
  if (directory.startsWith(`${repository}/`) || directory === repository)
    throw new Error("Cache must be outside the repository and disposable worktrees");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await validatePrivatePath(directory, true);
  const lock = join(directory, "bootstrap.lock");
  try {
    await writeFile(lock, "Recover interrupted bootstrap before removing this lock.\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("Cache bootstrap is active/interrupted; preserve files and recover its lock");
    throw error;
  }
  try {
    const roles = [];
    for (const definition of definitions) {
      const roleDirectory = join(directory, definition.name);
      const manifestPath = join(roleDirectory, "profile.json");
      const binding = { ...environment, role: definition.name, userId: definition.userId };
      let manifest;
      try {
        await validatePrivatePath(roleDirectory, true);
        await validatePrivatePath(manifestPath);
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (
          JSON.stringify(manifest.binding) !== JSON.stringify(binding) ||
          manifest.version !== 1 ||
          !["issued", "ready", "blocked"].includes(manifest.status) ||
          typeof manifest.deviceId !== "string" ||
          !/^MABCACHE[A-F0-9]+$/u.test(manifest.deviceId) ||
          ["cryptoBootstrapped", "sasVerified"].some(
            (key) => manifest[key] !== undefined && typeof manifest[key] !== "boolean",
          ) ||
          (manifest.status === "blocked" &&
            (!Number.isSafeInteger(manifest.retryAt) ||
              manifest.retryAt < 0 ||
              manifest.retryAt > 8_640_000_000_000_000)) ||
          Object.keys(manifest).some(
            (key) =>
              !["version", "binding", "deviceId", "status", "retryAt", "cryptoBootstrapped", "sasVerified"].includes(
                key,
              ),
          )
        )
          throw new Error("Invalid/partial cache profile; restore its original credentials/state; never reset crypto");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        // Exclusive creation distinguishes truly absent from damaged/partial profiles.
        try {
          await mkdir(roleDirectory, { mode: 0o700 });
        } catch (creationError) {
          if (creationError.code === "EEXIST")
            throw new Error("Partial cache profile: preserve it and recover profile.json; no password fallback");
          throw creationError;
        }
        const password =
          settings[
            definition.name === "helper" ? "E2E_BRIDGE_PASSWORD" : `E2E_${definition.name.toUpperCase()}_PASSWORD`
          ];
        if (!password) {
          await rmdir(roleDirectory);
          throw new Error("SETUP BLOCKED: designated test password is required for absent cache bootstrap");
        }
        manifest = { version: 1, binding, deviceId: deviceId("MABCACHE"), status: "issuing" };
        await writePrivateFile(manifestPath, `${JSON.stringify(manifest)}\n`);
        await mkdir(join(roleDirectory, "state"), { mode: 0o700 });
        await issueCachedToken(environment, definition, roleDirectory, manifestPath, manifest, password);
      }
      if (manifest.status === "blocked") {
        if (Date.now() < manifest.retryAt)
          throw new Error(`SETUP BLOCKED: HTTP 429; retry after ${new Date(manifest.retryAt).toISOString()}`);
        const password =
          settings[
            definition.name === "helper" ? "E2E_BRIDGE_PASSWORD" : `E2E_${definition.name.toUpperCase()}_PASSWORD`
          ];
        if (!password) throw new Error("SETUP BLOCKED: designated password unavailable for bootstrap retry");
        await issueCachedToken(environment, definition, roleDirectory, manifestPath, manifest, password);
      }
      const identity = {
        ...definition,
        deviceId: manifest.deviceId,
        ownership: "reusable",
        tokenFile: join(roleDirectory, "access-token"),
        stateDir: join(roleDirectory, "state"),
        cacheManifest: manifestPath,
        cacheInitial: manifest.status === "issued",
        cacheCryptoInitial: !manifest.cryptoBootstrapped,
      };
      await validatePrivatePath(identity.tokenFile);
      await validatePrivatePath(identity.stateDir, true);
      await assertReusableStateAvailable(identity);
      await validateTokenIdentity(environment.homeserver, identity, await readToken(identity.tokenFile));
      roles.push(identity);
    }
    return roles;
  } finally {
    await rm(lock);
  }
}

async function issueCachedToken(environment, definition, directory, path, manifest, password) {
  try {
    await login(
      environment.homeserver,
      definition.userId,
      password,
      manifest.deviceId,
      definition.displayName,
      async (token) => {
        await writePrivateFile(join(directory, "access-token"), `${token}\n`);
      },
    );
    manifest.status = "issued";
    delete manifest.retryAt;
    await writePrivateFile(path, `${JSON.stringify(manifest)}\n`);
  } catch (error) {
    if (error.status === 429) {
      manifest.status = "blocked";
      const delay = Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs >= 0 ? error.retryAfterMs : 60_000;
      manifest.retryAt = Date.now() + Math.max(delay, 1000);
      await writePrivateFile(path, `${JSON.stringify(manifest)}\n`);
      throw new Error(`SETUP BLOCKED: HTTP 429; retry after ${new Date(manifest.retryAt).toISOString()}`);
    }
    throw error;
  }
}

export async function finishCachedSetup(environment) {
  for (const role of ["bridge", "helper", "sender"]) {
    const identity = environment[role];
    if (!identity?.cacheManifest) continue;
    await validatePrivatePath(identity.cacheManifest);
    const manifest = JSON.parse(await readFile(identity.cacheManifest, "utf8"));
    if (environment.transport === "encrypted" && !manifest.sasVerified) continue;
    if (role === "bridge") {
      const state = JSON.parse(await readFile(join(identity.stateDir, "bridge-state.json"), "utf8"));
      if (!state.initialized) continue;
    }
    manifest.status = "ready";
    await writePrivateFile(identity.cacheManifest, `${JSON.stringify(manifest)}\n`);
  }
}

export async function recordCachedSas(environment) {
  for (const role of ["bridge", "helper", "sender"]) {
    const identity = environment[role];
    if (!identity?.cacheManifest) continue;
    const manifest = JSON.parse(await readFile(identity.cacheManifest, "utf8"));
    manifest.sasVerified = true;
    await writePrivateFile(identity.cacheManifest, `${JSON.stringify(manifest)}\n`);
  }
}

export async function recordCachedBootstrap(identity) {
  if (!identity.cacheManifest) return;
  const manifest = JSON.parse(await readFile(identity.cacheManifest, "utf8"));
  manifest.cryptoBootstrapped = true;
  await writePrivateFile(identity.cacheManifest, `${JSON.stringify(manifest)}\n`);
}

export async function hasCachedSas(environment) {
  for (const role of ["bridge", "helper", "sender"]) {
    const identity = environment[role];
    if (!identity?.cacheManifest) return false;
    const manifest = JSON.parse(await readFile(identity.cacheManifest, "utf8"));
    if (!manifest.sasVerified) return false;
  }
  return true;
}
