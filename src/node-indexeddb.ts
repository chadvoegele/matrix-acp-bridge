import { deserialize, serialize } from "node:v8";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isRecord } from "./object-validation.js";

/**
 * matrix-js-sdk's WASM crypto store speaks IndexedDB, but Node does not ship
 * an IndexedDB implementation. fake-indexeddb gives us the browser API and
 * this module adds a private, atomic snapshot for the two crypto databases.
 *
 * This is deliberately isolated from the bridge contracts. The snapshot is an
 * opaque implementation detail beneath state_dir/matrix-crypto and is only
 * enabled when the real SDK is about to initialize its crypto store.
 */

const SNAPSHOT_SCHEMA_VERSION = 1 as const;
const SNAPSHOT_FILE = ".indexeddb.snapshot";
const SNAPSHOT_TEMP_FILE = ".indexeddb.snapshot.tmp";

type IndexedDatabaseKeyPath = string | readonly string[] | null;

interface SnapshotRecord {
  readonly key: unknown;
  readonly value: unknown;
}

interface SnapshotIndex {
  readonly name: string;
  readonly keyPath: IndexedDatabaseKeyPath;
  readonly multiEntry: boolean;
  readonly unique: boolean;
}

interface SnapshotObjectStore {
  readonly name: string;
  readonly keyPath: IndexedDatabaseKeyPath;
  readonly autoIncrement: boolean;
  readonly keyGenerator?: number;
  readonly indexes: readonly SnapshotIndex[];
  readonly records: readonly SnapshotRecord[];
}

interface IndexedDatabaseSnapshot {
  readonly schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  readonly databases: readonly {
    readonly name: string;
    readonly version: number;
    readonly objectStores: readonly SnapshotObjectStore[];
  }[];
}

interface RawRecord {
  readonly key: unknown;
  readonly value: unknown;
}

interface RawIndex {
  readonly name: string;
  readonly keyPath: IndexedDatabaseKeyPath;
  readonly multiEntry: boolean;
  readonly unique: boolean;
  readonly deleted?: boolean;
}

interface RawObjectStore {
  readonly name: string;
  readonly keyPath: IndexedDatabaseKeyPath;
  readonly autoIncrement: boolean;
  readonly keyGenerator?: { num: number } | null;
  readonly rawIndexes: Map<string, RawIndex>;
  readonly records: { values(): Iterable<RawRecord> };
  readonly deleted?: boolean;
}

interface RawDatabase {
  readonly name: string;
  readonly version: number;
  readonly rawObjectStores: Map<string, RawObjectStore>;
}

interface NodeIndexedDatabaseRequest {
  readonly result: NodeIndexedDatabase;
  readonly error?: unknown;
  addEventListener(type: string, listener: () => void, options?: { readonly once?: boolean }): void;
}

interface NodeIndexedDatabaseObjectStore {
  createIndex(
    name: string,
    keyPath: string | readonly string[],
    options: { readonly multiEntry: boolean; readonly unique: boolean },
  ): unknown;
  put(value: unknown, key?: unknown): unknown;
}

interface NodeIndexedDatabaseTransaction {
  error?: unknown;
  objectStore(name: string): NodeIndexedDatabaseObjectStore;
  addEventListener(type: string, listener: () => void, options?: { readonly once?: boolean }): void;
}

interface NodeIndexedDatabase {
  createObjectStore(
    name: string,
    options: { readonly keyPath: string | readonly string[] | null; readonly autoIncrement: boolean },
  ): NodeIndexedDatabaseObjectStore;
  transaction(storeNames: readonly string[] | string, mode?: string): NodeIndexedDatabaseTransaction;
  close(): void;
}

interface FakeIndexedDatabaseFactory {
  open(name: string, version?: number): NodeIndexedDatabaseRequest;
  readonly _databases?: Map<string, RawDatabase>;
}

let databasePath: string | undefined;
let snapshotPath: string | undefined;
let snapshotTail: Promise<void> = Promise.resolve();
let factoryOpenPatched = false;
const patchedConnections = new WeakSet<object>();

function isNodeEnvironment(): boolean {
  return typeof process !== "undefined" && process.release?.name === "node";
}

function isSnapshot(value: unknown): value is IndexedDatabaseSnapshot {
  if (!isRecord(value) || value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
      !Array.isArray(value.databases)) {
    return false;
  }
  return value.databases.every((database) => isRecord(database) &&
    typeof database.name === "string" &&
    typeof database.version === "number" && Number.isSafeInteger(database.version) && database.version > 0 &&
    Array.isArray(database.objectStores));
}

function snapshotFile(path: string): string {
  return join(path, SNAPSHOT_FILE);
}

function snapshotTemporaryFile(path: string): string {
  return join(path, SNAPSHOT_TEMP_FILE);
}

function factory(): FakeIndexedDatabaseFactory {
  return (globalThis as unknown as Record<string, unknown>).indexedDB as FakeIndexedDatabaseFactory;
}

function databaseMatchesPath(name: string): boolean {
  return databasePath !== undefined &&
    (name === databasePath || name.startsWith(`${databasePath}::`));
}

function captureSnapshot(): IndexedDatabaseSnapshot {
  const databases = factory()._databases;
  if (!(databases instanceof Map)) {
    throw new TypeError("Node IndexedDB factory does not expose its database registry");
  }

  const result: Array<IndexedDatabaseSnapshot["databases"][number]> = [];
  for (const [name, database] of databases) {
    if (!databaseMatchesPath(name)) {
      continue;
    }
    const objectStores: SnapshotObjectStore[] = [];
    for (const [storeName, store] of database.rawObjectStores) {
      if (store.deleted === true) {
        continue;
      }
      const records = [...store.records.values()].map((record) => ({
        key: record.key,
        value: record.value,
      }));
      const indexes = [...store.rawIndexes.values()]
        .filter((index) => !isRecord(index) || index.deleted !== true)
        .map((index) => ({
          name: index.name,
          keyPath: index.keyPath === null || typeof index.keyPath === "string"
            ? index.keyPath
            : [...index.keyPath],
          multiEntry: index.multiEntry,
          unique: index.unique,
        }));
      objectStores.push({
        name: storeName,
        keyPath: store.keyPath === null || typeof store.keyPath === "string"
          ? store.keyPath
          : [...store.keyPath],
        autoIncrement: store.autoIncrement,
        ...(store.keyGenerator === undefined || store.keyGenerator === null
          ? {}
          : { keyGenerator: store.keyGenerator.num }),
        indexes,
        records,
      });
    }
    result.push({ name, version: database.version, objectStores });
  }
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, databases: result };
}

async function writeSnapshot(): Promise<void> {
  if (databasePath === undefined || snapshotPath === undefined) {
    return;
  }
  const bytes = serialize(captureSnapshot());
  const temporaryPath = snapshotTemporaryFile(databasePath);
  await writeFile(temporaryPath, bytes, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, snapshotPath);
}

function scheduleSnapshot(): void {
  if (databasePath === undefined) {
    return;
  }
  snapshotTail = snapshotTail.then(async () => {
    // Let all requests queued by the completed transaction settle before
    // taking the in-memory snapshot.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await writeSnapshot();
  });
  void snapshotTail.catch(() => {});
}

function requestResult(request: NodeIndexedDatabaseRequest): Promise<NodeIndexedDatabase> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error instanceof Error ? request.error : new Error("IndexedDB request failed")));
  });
}

function transactionComplete(transaction: NodeIndexedDatabaseTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error instanceof Error ? transaction.error : new Error("IndexedDB transaction aborted")), {
      once: true,
    });
    transaction.addEventListener("error", () => reject(transaction.error instanceof Error ? transaction.error : new Error("IndexedDB transaction failed")), {
      once: true,
    });
  });
}

async function restoreDatabase(database: IndexedDatabaseSnapshot["databases"][number]): Promise<void> {
  const request = factory().open(database.name, database.version);
  request.addEventListener("upgradeneeded", () => {
    const connection = request.result;
    for (const store of database.objectStores) {
      const objectStore = connection.createObjectStore(store.name, {
        keyPath: store.keyPath === null ? null : store.keyPath,
        autoIncrement: store.autoIncrement,
      });
      for (const index of store.indexes) {
        objectStore.createIndex(index.name, index.keyPath as string | string[], {
          multiEntry: index.multiEntry,
          unique: index.unique,
        });
      }
    }
  });
  const connection = await requestResult(request);
  if (database.objectStores.length > 0) {
    const transaction = connection.transaction(
      database.objectStores.map((store) => store.name),
      "readwrite",
    );
    for (const store of database.objectStores) {
      const objectStore = transaction.objectStore(store.name);
      for (const record of store.records) {
        if (store.keyPath === null) {
          objectStore.put(record.value, record.key);
        } else {
          objectStore.put(record.value);
        }
      }
    }
    await transactionComplete(transaction);
  }
  connection.close();

  const rawDatabase = factory()._databases?.get(database.name);
  if (rawDatabase === undefined) {
    throw new Error("Restored IndexedDB database is missing from the factory registry");
  }
  for (const store of database.objectStores) {
    const rawStore = rawDatabase.rawObjectStores.get(store.name);
    if (rawStore?.keyGenerator !== undefined && rawStore.keyGenerator !== null && store.keyGenerator !== undefined) {
      rawStore.keyGenerator.num = store.keyGenerator;
    }
  }
}

async function restoreSnapshot(): Promise<void> {
  if (databasePath === undefined || snapshotPath === undefined) {
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(snapshotPath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const value = deserialize(bytes) as unknown;
  if (!isSnapshot(value)) {
    throw new Error("Node IndexedDB snapshot is invalid");
  }
  for (const database of value.databases) {
    if (!databaseMatchesPath(database.name)) {
      throw new Error("Node IndexedDB snapshot contains an unexpected database");
    }
    await restoreDatabase(database);
  }
}

function patchConnection(connection: NodeIndexedDatabase): void {
  if (patchedConnections.has(connection)) {
    return;
  }
  patchedConnections.add(connection);
  const transaction = connection.transaction.bind(connection);
  connection.transaction = ((storeNames: readonly string[] | string, mode?: string) => {
    const result = transaction(storeNames, mode);
    result.addEventListener("complete", scheduleSnapshot, { once: true });
    result.addEventListener("abort", scheduleSnapshot, { once: true });
    return result;
  });
}

function patchFactory(): void {
  if (factoryOpenPatched) {
    return;
  }
  factoryOpenPatched = true;
  const currentFactory = factory();
  const open = currentFactory.open.bind(currentFactory);
  currentFactory.open = ((name: string, version?: number) => {
    const request = version === undefined ? open(name) : open(name, version);
    request.addEventListener("upgradeneeded", () => patchConnection(request.result));
    request.addEventListener("success", () => patchConnection(request.result));
    return request;
  });
}

/**
 * Install the Node IndexedDB implementation and restore the crypto databases
 * before matrix-js-sdk is imported. A browser's native IndexedDB is left
 * untouched.
 */
export async function configureNodeIndexedDb(path: string): Promise<void> {
  const globalObject = globalThis as unknown as Record<string, unknown>;
  if (!isNodeEnvironment() || globalObject.indexedDB !== undefined) {
    return;
  }
  if (databasePath !== undefined && databasePath !== path) {
    throw new Error("Only one Node IndexedDB crypto database may be active per process");
  }
  databasePath = path;
  snapshotPath = snapshotFile(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  try {
    await unlink(snapshotTemporaryFile(path));
  } catch (error) {
    if (!(isRecord(error) && error.code === "ENOENT")) {
      throw error;
    }
  }
  await import("fake-indexeddb/auto");
  patchFactory();
  await restoreSnapshot();
}

/** Flush the latest crypto database snapshot before a clean process exit. */
export async function flushNodeIndexedDb(): Promise<void> {
  if (databasePath === undefined) {
    return;
  }
  // Serialize the final write with transaction-triggered snapshots. Awaiting
  // the tail and then writing separately races a transaction completion that
  // queues between those operations: both writers use the same atomic temp
  // path, so one rename can remove the other's source file.
  snapshotTail = snapshotTail.then(() => writeSnapshot());
  await snapshotTail;
}
