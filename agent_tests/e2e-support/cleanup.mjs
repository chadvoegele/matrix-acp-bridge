import { spawn } from "node:child_process";
import { readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readToken } from "./common.mjs";

export async function savedAcpSessionIds(environment, additionalFiles = []) {
  const sessionIds = [];
  const stateFiles = [join(environment.bridge.stateDir, "bridge-state.json"), ...additionalFiles];
  for (const path of stateFiles) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      const ids = Array.isArray(value) ? value : Object.values(value.sessions ?? {});
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length > 0)) {
        throw new Error("retained session-ID list is invalid");
      }
      sessionIds.push(...ids);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`could not read saved ACP session IDs: ${path}`, { cause: error });
    }
  }
  return [...new Set(sessionIds)];
}

export async function deleteAcpSessions(environment, sessionIds, clientName = "matrix-acp-e2e-cleanup") {
  if (sessionIds.length === 0) return;
  const [program, ...arguments_] = environment.acpCommand;
  const child = spawn(program, arguments_, { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  let pending = "";
  let nextId = 1;
  const responses = new Map();
  let fatal;
  const failTransport = () => {
    fatal = new Error("ACP cleanup transport failed");
    for (const respond of responses.values()) respond({ error: {} });
  };
  const exitPromise = new Promise((resolve) => child.once("close", () => {
    if (responses.size > 0) failTransport();
    resolve();
  }));
  child.once("error", failTransport);
  child.stdin.once("error", failTransport);
  child.stdout.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    while (pending.includes("\n")) {
      const newline = pending.indexOf("\n");
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        responses.get(message.id)?.(message);
      } catch {
        fatal = new Error("ACP cleanup received invalid protocol data");
      }
    }
  });
  const request = (method, parameters) => new Promise((resolve, reject) => {
    if (fatal !== undefined) {
      reject(fatal);
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`ACP cleanup ${method} timed out`)), 30_000);
    responses.set(id, (message) => {
      clearTimeout(timer);
      responses.delete(id);
      if (message.error === undefined) {resolve(message.result);}
      else {reject(new Error(`ACP cleanup ${method} failed`));}
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: parameters })}\n`);
  });
  try {
    const initialized = await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: clientName, version: "1" },
    });
    if (initialized?.agentCapabilities?.sessionCapabilities?.delete === undefined) {
      throw new Error("ACP agent does not support session/delete");
    }
    for (const sessionId of sessionIds) await request("session/delete", { sessionId });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 5000);
    await exitPromise;
    clearTimeout(timer);
  }
}

export async function cleanupEnvironment(environmentPath, environment, {
  roles,
  additionalSessionFiles = [],
  removeSharedRoot = false,
  clientName,
}) {
  await deleteAcpSessions(environment, await savedAcpSessionIds(environment, additionalSessionFiles), clientName);

  let failed = false;
  for (const role of roles) {
    const token = await readToken(environment[role].tokenFile);
    const response = await fetch(`${environment.homeserver}/_matrix/client/v3/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok && response.status !== 401) {
      failed = true;
      process.stderr.write(`Could not revoke ${role} test device: HTTP ${response.status}\n`);
    }
  }
  if (failed) throw new Error("one or more test devices could not be revoked; private state was preserved");

  const roleRoots = [...new Set(roles.map((role) => dirname(environment[role].tokenFile)))];
  for (const roleRoot of roleRoots) await rm(roleRoot, { recursive: true, force: true });
  const sharedParent = roleRoots.length > 0 && new Set(roleRoots.map((roleRoot) => dirname(roleRoot))).size === 1;
  if (removeSharedRoot && sharedParent) {
    await rmdir(dirname(roleRoots[0])).catch((error) => {
      if (error?.code !== "ENOTEMPTY" && error?.code !== "ENOENT") throw error;
    });
  }
  await rm(environmentPath, { force: true });
  process.stdout.write("Deleted ACP sessions, revoked Matrix test devices, and removed private E2E state.\n");
}
