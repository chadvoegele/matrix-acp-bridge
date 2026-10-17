import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { repoRoot } from "./common.mjs";
import { savedAcpSessionIds } from "./cleanup.mjs";

test("cleanup collects room, thread, and detached ACP sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "matrix-acp-e2e-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, "bridge-state");
  await mkdir(stateDir);
  await writeFile(
    join(stateDir, "bridge-state.json"),
    JSON.stringify({
      sessions: { "!room:example.org": "room-session" },
      threads: [
        { roomId: "!room:example.org", threadRootEventId: "$root", sessionId: "thread-session" },
        { roomId: "!room:example.org", threadRootEventId: "$reset", sessionId: "detached-session" },
        { roomId: "!room:example.org", threadRootEventId: "$known" },
      ],
    }),
  );
  const detachedPath = join(stateDir, "e2e-session-ids.json");
  await writeFile(detachedPath, JSON.stringify(["detached-session", "reset-previous-session"]));

  assert.deepEqual(await savedAcpSessionIds({ bridge: { stateDir } }, [detachedPath]), [
    "room-session",
    "thread-session",
    "detached-session",
    "reset-previous-session",
  ]);
});

test(
  "encrypted room cleanup deletes reset-detached ACP sessions and preserves reusable credentials and ledger",
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "matrix-acp-encrypted-cleanup-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const privateRoot = join(root, "run");
    await mkdir(privateRoot, { mode: 0o700 });
    const environmentPath = join(root, "environment.json");
    const roles = {};
    for (const role of ["bridge", "helper", "sender"]) {
      const stateDir = join(root, role, "state");
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const tokenFile = join(root, role, "token");
      await writeFile(tokenFile, `test-token-${role}\n`, { mode: 0o600 });
      await writeFile(join(stateDir, "crypto-sentinel"), "retained crypto", { mode: 0o600 });
      roles[role] = {
        userId: `@${role}:example.org`,
        deviceId: role.toUpperCase(),
        stateDir,
        tokenFile,
        configFile: join(privateRoot, `${role}.toml`),
        ownership: "reusable",
        stateClaimed: role === "bridge",
      };
    }
    const homeserver = "https://matrix.example.org";
    const roomId = "!room:example.org";
    const { openBridgeStateStore } = await import("../../dist/bridge-state.js");
    const store = await openBridgeStateStore({
      stateDir: roles.bridge.stateDir,
      identity: { homeserver, ...roles.bridge },
    });
    await store.establishInitialBaseline([{ roomId, eventIds: ["$completed"] }]);
    const sessionPath = join(roles.bridge.stateDir, "e2e-session-ids.json");
    await writeFile(sessionPath, JSON.stringify(["reset-detached", "shutdown-session"]), { mode: 0o600 });
    await writeFile(join(roles.bridge.stateDir, "e2e-active-environment.json"), JSON.stringify({ environmentPath }), {
      mode: 0o600,
    });
    const deletedPath = join(root, "deleted.json");
    const peerPath = join(privateRoot, "cleanup-peer.mjs");
    await writeFile(
      peerPath,
      `import {createInterface} from 'node:readline'; import {writeFileSync} from 'node:fs'; const deleted=[]; createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.method==='session/delete'){deleted.push(m.params.sessionId);writeFileSync(${JSON.stringify(deletedPath)},JSON.stringify(deleted));} process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{agentCapabilities:{sessionCapabilities:{delete:{}}}}:{}})+'\\n');});`,
    );
    await writeFile(
      environmentPath,
      JSON.stringify({
        homeserver,
        roomId,
        acpCwd: root,
        acpCommand: [process.execPath, peerPath],
        privateRoot,
        ...roles,
      }),
      { mode: 0o600 },
    );
    await promisify(execFile)(
      process.execPath,
      [join(repoRoot, "agent_tests/test_encrypted_message/cleanup.mjs"), environmentPath],
      { timeout: 10_000 },
    );
    assert.deepEqual(JSON.parse(await readFile(deletedPath, "utf8")), ["reset-detached", "shutdown-session"]);
    assert.deepEqual(JSON.parse(await readFile(sessionPath, "utf8")), []);
    const state = JSON.parse(await readFile(join(roles.bridge.stateDir, "bridge-state.json"), "utf8"));
    assert.deepEqual(state.completedEventIds[roomId], ["$completed"]);
    for (const [role, identity] of Object.entries(roles)) {
      assert.equal(await readFile(identity.tokenFile, "utf8"), `test-token-${role}\n`);
      assert.equal(await readFile(join(identity.stateDir, "crypto-sentinel"), "utf8"), "retained crypto");
    }
    await assert.rejects(stat(environmentPath), { code: "ENOENT" });
    await assert.rejects(stat(privateRoot), { code: "ENOENT" });
    await assert.rejects(stat(join(roles.bridge.stateDir, "e2e-active-environment.json")), { code: "ENOENT" });
  },
);
