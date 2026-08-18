import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const supportDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(supportDir, "../..");

export async function readEnvironment(path, { roleKeys = {} } = {}) {
  const value = JSON.parse(await readFile(path, "utf8"));
  for (const key of ["homeserver", "roomId", "acpCwd", "acpCommand"]) {
    if (value[key] === undefined) throw new Error(`environment is missing ${key}`);
  }
  if (!Array.isArray(value.acpCommand) || value.acpCommand.length === 0 ||
      !value.acpCommand.every((part) => typeof part === "string" && part.length > 0)) {
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
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

export function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

export function deviceId(prefix) {
  return `${prefix}${randomBytes(6).toString("hex").toUpperCase()}`;
}

export async function login(homeserver, userId, passwordValue, id, displayName) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
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
    if (response.ok && typeof body.access_token === "string" &&
        body.device_id === id && body.user_id === userId) return body.access_token;
    if (response.status === 429 && attempt < 4) {
      const delay = Number.isFinite(body.retry_after_ms) ? Math.max(1000, body.retry_after_ms) : 30_000;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
      continue;
    }
    throw new Error(`Matrix login failed for ${displayName}: HTTP ${response.status}`);
  }
  throw new Error(`Matrix login retries exhausted for ${displayName}`);
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
}) {
  if (!Array.isArray(acpCommand) || acpCommand.length === 0 ||
      !acpCommand.every((part) => typeof part === "string" && part.length > 0)) {
    throw new Error("E2E_ACP_COMMAND must be a nonempty JSON string array");
  }
  if (privateRoot === "/" || privateRoot.length < 8) throw new Error("unsafe private root");
  try {
    await stat(environmentPath);
    throw new Error(`environment already exists; revoke its devices before reprovisioning: ${environmentPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rm(privateRoot, { recursive: true, force: true });
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await chmod(privateRoot, 0o700);

  const roles = {};
  for (const definition of roleDefinitions) {
    const identity = {
      userId: definition.userId,
      deviceId: definition.deviceId,
      displayName: definition.displayName,
    };
    const roleRoot = join(privateRoot, definition.name);
    identity.tokenFile = join(roleRoot, "access-token");
    if (definition.state) identity.stateDir = join(roleRoot, "state");
    if (definition.config) identity.configFile = join(roleRoot, "config.toml");
    roles[definition.name] = identity;
  }

  for (const identity of Object.values(roles)) {
    if (identity.stateDir !== undefined) await mkdir(identity.stateDir, { recursive: true, mode: 0o700 });
  }
  const issuedTokens = [];
  try {
    for (const definition of roleDefinitions) {
      const identity = roles[definition.name];
      const token = await login(
        homeserver,
        identity.userId,
        definition.password,
        identity.deviceId,
        identity.displayName,
      );
      issuedTokens.push(token);
      await writePrivateFile(identity.tokenFile, `${token}\n`);
      delete identity.displayName;
    }
  } catch (error) {
    await Promise.all(issuedTokens.map((token) => fetch(`${homeserver}/_matrix/client/v3/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => {})));
    await rm(privateRoot, { recursive: true, force: true });
    throw error;
  }

  const environment = { homeserver, roomId, acpCwd, acpCommand, ...roles };
  for (const definition of roleDefinitions) {
    const identity = environment[definition.name];
    if (identity.configFile !== undefined) {
      await writePrivateFile(identity.configFile, makeConfig(environment, definition.name));
    }
  }
  await writePrivateFile(environmentPath, `${JSON.stringify(environment, null, 2)}\n`);
  await afterProvision?.(environment);
  process.stdout.write(`${message}\nEnvironment: ${environmentPath}\n`);
}
