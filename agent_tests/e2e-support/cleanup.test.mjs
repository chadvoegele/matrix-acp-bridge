import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
