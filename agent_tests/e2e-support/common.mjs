import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertReusableStateAvailable,
  claimReusableState,
  pathsOverlap,
  validatePrivatePath,
  validateReusableState,
  validateTokenIdentity,
} from "./auth.mjs";

export const supportDir = dirname(fileURLToPath(import.meta.url));

export const repoRoot = resolve(supportDir, "../..");

export async function readEnvironment(path, { roleKeys = {} } = {}) {
  const value = JSON.parse(await readFile(path, "utf8"));
  for (const key of ["homeserver", "roomId", "acpCwd", "acpCommand"]) {
    if (value[key] === undefined) throw new Error(`environment is missing ${key}`);
  }
  if (
    !Array.isArray(value.acpCommand) ||
    value.acpCommand.length === 0 ||
    !value.acpCommand.every((part) => typeof part === "string" && part.length > 0)
  ) {
    throw new Error("environment acpCommand must be a nonempty string array");
  }
  for (const [role, keys] of Object.entries(roleKeys)) {
    for (const key of keys) {
      if (typeof value[role]?.[key] !== "string" || value[role][key].length === 0) {
        throw new Error(`environment ${role}.${key} is invalid`);
      }
    }
  }
  return value;
}

export async function readToken(path) {
  const contents = await readFile(path, "utf8");
  const token = contents.replace(/\n$/u, "");
  if (token.length === 0 || /\s/u.test(token)) throw new Error("token file is invalid");
  return token;
}

export async function writePrivateFile(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

export function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

export function deviceId(prefix) {
  return `${prefix}${randomBytes(6).toString("hex").toUpperCase()}`;
}

export async function login(homeserver, userId, passwordValue, id, displayName, onIssued) {
  const response = await fetch(`${homeserver}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: userId },
      password: passwordValue,
      device_id: id,
      initial_device_display_name: displayName,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (response.ok && typeof body.access_token === "string") await onIssued?.(body.access_token);
  if (response.ok && typeof body.access_token === "string" && body.device_id === id && body.user_id === userId)
    return body.access_token;
  throw new Error(
    `Matrix login failed for ${displayName}: HTTP ${response.status}; no automatic login retry. Prefer designated test tokens or wait for the server rate limit.`,
  );
}

export async function runCommand(command, arguments_) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

export async function provisionEnvironment({
  homeserver,
  roomId,
  acpCwd,
  acpCommand,
  privateRoot,
  environmentPath,
  roles: roleDefinitions,
  makeConfig,
  afterProvision,
  message,
  transport = "plaintext",
  responseMode = "room",
}) {
  if (
    !Array.isArray(acpCommand) ||
    acpCommand.length === 0 ||
    !acpCommand.every((part) => typeof part === "string" && part.length > 0)
  ) {
    throw new Error("E2E_ACP_COMMAND must be a nonempty JSON string array");
  }
  if (!privateRoot.startsWith("/") || privateRoot === "/" || privateRoot.length < 8)
    throw new Error("unsafe private root");
  try {
    await stat(environmentPath);
    throw new Error(
      `environment already exists; run ownership-aware cleanup before reprovisioning: ${environmentPath}`,
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const roles = {};
  const environment = { homeserver, roomId, acpCwd, acpCommand, transport, responseMode, privateRoot, ...roles };
  const reusableBindings = [];
  for (const definition of roleDefinitions) {
    const roleRoot = join(privateRoot, definition.name);
    const reusable = definition.ownership === "reusable";
    const identity = {
      userId: definition.userId,
      deviceId: definition.deviceId,
      ownership: reusable ? "reusable" : "owned",
      tokenFile: reusable ? definition.tokenFile : join(roleRoot, "access-token"),
      tokenIssued: reusable,
    };
    if (definition.state || reusable) identity.stateDir = reusable ? definition.stateDir : join(roleRoot, "state");
    if (definition.config) identity.configFile = join(roleRoot, "config.toml");
    roles[definition.name] = identity;
    environment[definition.name] = identity;
  }
  const reusablePaths = Object.values(roles)
    .filter((identity) => identity.ownership === "reusable")
    .flatMap((identity) => [identity.tokenFile, identity.stateDir]);
  for (const path of reusablePaths) {
    if (pathsOverlap(privateRoot, path) || pathsOverlap(path, privateRoot) || pathsOverlap(path, environmentPath)) {
      throw new Error("Run private root/environment must be separate from reusable tokens and stores");
    }
  }
  for (const [index, first] of Object.values(roles).entries()) {
    for (const second of Object.values(roles).slice(index + 1)) {
      if (first.userId === second.userId && first.deviceId === second.deviceId)
        throw new Error("Test roles must use distinct devices");
      if (
        first.ownership === "reusable" &&
        second.ownership === "reusable" &&
        (pathsOverlap(first.stateDir, second.stateDir) || pathsOverlap(second.stateDir, first.stateDir))
      ) {
        throw new Error("Test roles must use separate persistent state directories");
      }
    }
  }
  for (const [role, identity] of Object.entries(roles)) {
    if (identity.ownership !== "reusable") continue;
    await validatePrivatePath(identity.tokenFile);
    await validatePrivatePath(identity.stateDir, true);
    await assertReusableStateAvailable(identity);
    await validateTokenIdentity(homeserver, identity, await readToken(identity.tokenFile));
    reusableBindings.push(await validateReusableState(environment, identity, role));
  }
  // Never wipe existing roots: they can contain interrupted owned resources.
  await mkdir(dirname(privateRoot), { recursive: true, mode: 0o700 });
  await mkdir(privateRoot, { mode: 0o700 });
  await chmod(privateRoot, 0o700);
  // Persist provenance before issuing a device or claiming a reusable store.
  await writePrivateFile(environmentPath, `${JSON.stringify(environment, null, 2)}\n`);
  for (const identity of Object.values(roles)) {
    if (identity.ownership === "reusable") {
      await claimReusableState(environmentPath, identity);
      identity.stateClaimed = true;
      await writePrivateFile(environmentPath, `${JSON.stringify(environment, null, 2)}\n`);
    } else if (identity.stateDir !== undefined) {
      await mkdir(identity.stateDir, { recursive: true, mode: 0o700 });
    }
  }
  for (const binding of reusableBindings) await writePrivateFile(binding.path, `${JSON.stringify(binding.binding)}\n`);
  for (const definition of roleDefinitions) {
    const identity = roles[definition.name];
    if (identity.ownership === "owned") {
      await login(
        homeserver,
        identity.userId,
        definition.password,
        identity.deviceId,
        definition.displayName,
        async (token) => {
          await writePrivateFile(identity.tokenFile, `${token}\n`);
          identity.tokenIssued = true;
          await writePrivateFile(environmentPath, `${JSON.stringify(environment, null, 2)}\n`);
        },
      );
    }
    if (identity.configFile !== undefined)
      await writePrivateFile(identity.configFile, makeConfig(environment, definition.name));
  }
  await afterProvision?.(environment);
  process.stdout.write(`${message}\nEnvironment: ${environmentPath}\n`);
}
