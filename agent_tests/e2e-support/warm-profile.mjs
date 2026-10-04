import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { startBridgePair, stopBridgePair } from "./acp.mjs";
import { deleteAcpSessions, savedAcpSessionIds } from "./cleanup.mjs";
import { writePrivateFile } from "./common.mjs";

export async function warmProfile(environment, evidencePath, acpCommand = environment.acpCommand) {
  const sessionPath = join(environment.bridge.stateDir, "e2e-session-ids.json");
  const statePath = join(environment.bridge.stateDir, "bridge-state.json");
  const sessions = new Set();
  const pending = new Set();
  let prompts = 0;
  let failed = false;
  let pair;
  try {
    pair = await startBridgePair(
      { ...environment, acpCommand },
      {
        onPair: (started) => {
          pair = started;
        },
        onOutbound: (frame) => {
          if (frame.method === "session/prompt") {
            prompts += 1;
            pending.add(frame.id);
          }
        },
        onInbound: (frame) => {
          if (typeof frame.result?.sessionId === "string") sessions.add(frame.result.sessionId);
          pending.delete(frame.id);
          if (frame.error) failed = true;
        },
      },
    );
    let previous;
    let quietSince = Date.now();
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if (failed || pair.bridge.exitCode !== null || pair.acp.exitCode !== null)
        throw new Error("Profile recovery failed; preserve its private environment/evidence");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const current = JSON.stringify(state.completedEventIds);
      if (current !== previous || pending.size > 0) quietSince = Date.now();
      previous = current;
      if (state.initialized && pending.size === 0 && Date.now() - quietSince >= 30_000) break;
      await setTimeout(1000);
    }
    if (Date.now() >= deadline)
      throw new Error("Profile recovery did not settle; preserve the environment and inspect private evidence");
    await stopBridgePair(pair);
    pair = undefined;
    for (const id of await savedAcpSessionIds(environment, [sessionPath])) sessions.add(id);
    await writePrivateFile(sessionPath, `${JSON.stringify([...sessions])}\n`);
    await deleteAcpSessions({ ...environment, acpCommand }, [...sessions]);
    const { openBridgeStateStore } = await import("../../dist/bridge-state.js");
    const store = await openBridgeStateStore({
      stateDir: environment.bridge.stateDir,
      identity: { homeserver: environment.homeserver, ...environment.bridge },
    });
    await store.discardSessionMappings();
    await store.flush();
    await writePrivateFile(sessionPath, "[]\n");
    await writePrivateFile(
      evidencePath,
      `${JSON.stringify({ result: "PASSED", prompts, sessionsDeleted: sessions.size, pending: pending.size })}\n`,
    );
  } finally {
    if (pair) {
      for (const id of await savedAcpSessionIds(environment, [sessionPath])) sessions.add(id);
      await writePrivateFile(sessionPath, `${JSON.stringify([...sessions])}\n`);
      await stopBridgePair(pair);
    }
  }
}
