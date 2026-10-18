import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireStateLock, ConfigurationError } from "./config.js";

void test("lock contention is reported even when the helper exits before the parent descriptor closes", async (context) => {
  const stateDir = await fs.mkdtemp(join(tmpdir(), "matrix-acp-lock-race-"));
  const owner = await acquireStateLock(stateDir);
  const open = fs.open;
  const spawnHelper = spawn;
  let helperExited: Promise<void> | undefined;

  // Force the contending helper to exit before close resolves. Previously the
  // exit listener was installed only after close, so this became a timeout.
  context.mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const child = spawnHelper(...args);
    helperExited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    return child;
  });
  syncBuiltinESMExports();
  context.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    context.mock.method(handle, "close", async () => {
      await helperExited;
      await close();
    });
    return handle;
  });

  try {
    await assert.rejects(acquireStateLock(stateDir), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /already locked/u);
      return true;
    });
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await owner.release();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
