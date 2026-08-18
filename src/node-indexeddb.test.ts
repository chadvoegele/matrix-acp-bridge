import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import test from "node:test";

const execFile = promisify(execFileCallback);

function moduleUrl(): string {
  return pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "node-indexeddb.js")).href;
}

void test("Node IndexedDB crypto state survives a fresh process", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-node-indexeddb-"));
  const databasePath = join(stateDir, "matrix-crypto");
  await mkdir(databasePath, { mode: 0o700 });
  try {
    const initializeScript = `
      import { configureNodeIndexedDb, flushNodeIndexedDb } from ${JSON.stringify(moduleUrl())};
      const databasePath = process.argv[1];
      await configureNodeIndexedDb(databasePath);
      const request = indexedDB.open(databasePath + "::test", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      const database = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction("kv", "readwrite");
      transaction.objectStore("kv").put({ stable: true }, "identity");
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      // Concurrent lifecycle callers must share the serialized snapshot tail;
      // otherwise both writes race on the fixed atomic temporary path.
      await Promise.all([flushNodeIndexedDb(), flushNodeIndexedDb()]);
      process.exit(0);
    `;
    await execFile(process.execPath, ["--input-type=module", "-e", initializeScript, databasePath], {
      timeout: 30_000,
    });
    const snapshot = await stat(join(databasePath, ".indexeddb.snapshot"));
    assert.equal(snapshot.mode & 0o077, 0);

    const restoreScript = `
      import { configureNodeIndexedDb } from ${JSON.stringify(moduleUrl())};
      const databasePath = process.argv[1];
      await configureNodeIndexedDb(databasePath);
      const request = indexedDB.open(databasePath + "::test");
      const database = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction("kv", "readonly");
      const valueRequest = transaction.objectStore("kv").get("identity");
      const value = await new Promise((resolve, reject) => {
        valueRequest.onsuccess = () => resolve(valueRequest.result);
        valueRequest.onerror = () => reject(valueRequest.error);
      });
      if (!value || value.stable !== true) throw new Error("snapshot value was not restored");
      database.close();
      process.exit(0);
    `;
    await execFile(process.execPath, ["--input-type=module", "-e", restoreScript, databasePath], {
      timeout: 30_000,
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
