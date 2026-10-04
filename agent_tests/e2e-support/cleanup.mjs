import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { pathsOverlap, validatePrivatePath } from "./auth.mjs";
import { readToken, writePrivateFile } from "./common.mjs";

export async function savedAcpSessionIds(environment, additionalFiles = []) {
  const sessionIds = [];
  const stateFiles = [join(environment.bridge.stateDir, "bridge-state.json"), ...additionalFiles];
  for (const path of stateFiles) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      const ids = Array.isArray(value)
        ? value
        : [
            ...Object.values(value.sessions ?? {}),
            ...(Array.isArray(value.threads)
              ? value.threads.flatMap((record) => (typeof record?.sessionId === "string" ? [record.sessionId] : []))
              : []),
          ];
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length > 0)) {
        throw new Error("retained session-ID list is invalid");
      }
      sessionIds.push(...ids);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`could not read saved ACP session IDs: ${path}`, {
        cause: error,
      });
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
  const exitPromise = new Promise((resolve) =>
    child.once("close", () => {
      if (responses.size > 0) failTransport();
      resolve();
    }),
  );
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
  const request = (method, parameters) =>
    new Promise((resolve, reject) => {
      if (fatal !== undefined) {
        reject(fatal);
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`ACP cleanup ${method} timed out`)), 30_000);
      responses.set(id, (message) => {
        clearTimeout(timer);
        responses.delete(id);
        if (message.error === undefined) {
          resolve(message.result);
        } else {
          reject(new Error(`ACP cleanup ${method} failed`));
        }
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

export async function cleanupEnvironment(
  environmentPath,
  environment,
  { roles, additionalSessionFiles = [], clientName },
) {
  if (!environment.privateRoot || environment.privateRoot.length < 8 || !environment.privateRoot.startsWith("/"))
    throw new Error("Cleanup requires a safe recorded private root");
  await validatePrivatePath(environment.privateRoot, true);
  // Fail closed for old or ambiguous provenance, before deleting any resource.
  for (const role of roles) {
    const identity = environment[role];
    if (!["owned", "reusable"].includes(identity?.ownership))
      throw new Error(
        "Cleanup requires explicit device ownership; recover legacy environments after verifying run ownership",
      );
    if (
      identity.ownership === "owned" &&
      (!environment.privateRoot || !pathsOverlap(environment.privateRoot, identity.tokenFile))
    ) {
      throw new Error("Owned device files must be inside the recorded run private root");
    }
    if (identity.ownership === "owned") {
      for (const path of [identity.stateDir, identity.configFile].filter(Boolean)) {
        if (!pathsOverlap(environment.privateRoot, path))
          throw new Error("Owned test state must remain inside its recorded run root");
      }
    }
    if (identity.ownership === "reusable") {
      if (
        !environment.privateRoot ||
        pathsOverlap(environment.privateRoot, identity.tokenFile) ||
        pathsOverlap(environment.privateRoot, identity.stateDir) ||
        pathsOverlap(identity.stateDir, environment.privateRoot)
      ) {
        throw new Error("Reusable credentials must be outside the run private root");
      }
      {
        const leasePath = join(identity.stateDir, "e2e-active-environment.json");
        try {
          await validatePrivatePath(leasePath);
          const lease = JSON.parse(await readFile(leasePath, "utf8"));
          if (resolve(lease.environmentPath) === resolve(environmentPath)) {
            identity.stateClaimed = true;
          } else {
            if (identity.stateClaimed)
              throw new Error("Reusable state belongs to another active environment; preserve recovery evidence");
          }
        } catch (error) {
          if (error.code !== "ENOENT" || identity.stateClaimed) throw error;
        }
      }
    }
  }
  const bridgeClaimed = environment.bridge.ownership === "owned" || environment.bridge.stateClaimed;
  if (bridgeClaimed) {
    await deleteAcpSessions(environment, await savedAcpSessionIds(environment, additionalSessionFiles), clientName);
    if (environment.bridge.ownership === "reusable") {
      const { openBridgeStateStore } = await import("../../dist/bridge-state.js");
      const store = await openBridgeStateStore({
        stateDir: environment.bridge.stateDir,
        identity: {
          homeserver: environment.homeserver,
          userId: environment.bridge.userId,
          deviceId: environment.bridge.deviceId,
        },
      });
      await store.discardSessionMappings();
      await store.flush();
      for (const path of additionalSessionFiles) await writePrivateFile(path, "[]\n");
    }
  }
  let failed = false;
  for (const role of roles) {
    const identity = environment[role];
    if (identity.ownership === "reusable") continue;
    let token;
    try {
      token = await readToken(identity.tokenFile);
    } catch (error) {
      if (error.code === "ENOENT" && !identity.tokenIssued) continue;
      throw error;
    }
    try {
      const response = await fetch(`${environment.homeserver}/_matrix/client/v3/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok && response.status !== 401) throw new Error(`HTTP ${response.status}`);
    } catch {
      failed = true;
      process.stderr.write(`Could not revoke owned ${role} test device; private recovery state retained\n`);
    }
  }
  if (failed) throw new Error("one or more owned test devices could not be revoked; private state was preserved");
  for (const role of roles) {
    const identity = environment[role];
    if (identity.ownership === "reusable" && identity.stateClaimed) {
      await rm(join(identity.stateDir, "e2e-active-environment.json"));
      identity.stateClaimed = false;
      await writePrivateFile(environmentPath, `${JSON.stringify(environment, null, 2)}\n`);
    }
  }
  await rm(environment.privateRoot, { recursive: true, force: true });
  await rm(environmentPath, { force: true });
  process.stdout.write(
    "Deleted owned ACP sessions and run files; revoked only owned devices; preserved reusable tokens, crypto stores and completed-event ledgers.\n",
  );
}
