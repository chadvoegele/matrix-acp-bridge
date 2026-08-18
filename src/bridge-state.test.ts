import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BRIDGE_STATE_FILE_NAME,
  BRIDGE_STATE_SCHEMA_VERSION,
  BridgeStateError,
  openBridgeStateStore,
  type BridgeStateFaultPoint,
} from "./bridge-state.js";
import type { DiagnosticFields, DiagnosticLevel, DiagnosticSink } from "./diagnostics.js";

const identity = {
  homeserver: "https://matrix.example",
  userId: "@bridge:example",
  deviceId: "BRIDGEDEVICE",
} as const;

async function makeStateDir(): Promise<string> {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-state-"));
  await chmod(stateDir, 0o700);
  return stateDir;
}

async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await makeStateDir();
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function openStore(
  stateDir: string,
  options: { readonly faultInjector?: (point: BridgeStateFaultPoint) => void | Promise<void>; readonly diagnostics?: DiagnosticSink } = {},
) {
  return openBridgeStateStore({ stateDir, identity, ...options });
}

async function seedState(stateDir: string): Promise<void> {
  const store = await openStore(stateDir);
  await store.commitCursor("sync-old", 1_700_000_000_000);
  await store.setSessionMapping("!one:example", "session-one");
  await store.setSessionMapping("!two:example", "session-two");
}

async function writeRawState(stateDir: string, value: unknown): Promise<void> {
  const statePath = join(stateDir, BRIDGE_STATE_FILE_NAME);
  await writeFile(statePath, typeof value === "string" ? value : JSON.stringify(value));
  await chmod(statePath, 0o600);
}

function validState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: BRIDGE_STATE_SCHEMA_VERSION,
    identity: { ...identity },
    cursor: "sync-old",
    committedAtMs: 1_700_000_000_000,
    sessions: { "!one:example": "session-one" },
    pendingBatches: [],
    ...overrides,
  };
}

async function expectStateError(
  action: () => Promise<unknown>,
  category?: BridgeStateError["category"],
): Promise<BridgeStateError> {
  let rejected: unknown;
  await assert.rejects(action, (error: unknown) => {
    rejected = error;
    assert.ok(error instanceof BridgeStateError, `expected BridgeStateError, got ${String(error)}`);
    if (category !== undefined) {
      assert.equal(error.category, category);
    }
    assert.equal(error.code, "state");
    assert.equal(error.fatal, true);
    return true;
  });
  assert.ok(rejected instanceof BridgeStateError);
  return rejected;
}

void test("absent private state opens empty and a cursor/session round trip preserves only the M2 fields", async () => {
  await withStateDir(async (stateDir) => {
    const store = await openStore(stateDir);
    assert.equal(store.getCheckpoint(), undefined);
    assert.deepEqual(store.getSnapshot(), {
      schemaVersion: 11,
      identity,
      sessionMappings: {},
      pendingBatches: [],
    });

    await store.commitCursor("sync-opaque", 1_700_000_000_123);
    await store.setSessionMapping("!room:example", "acp-session");

    const raw = JSON.parse(await readFile(store.statePath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(raw).sort(), ["committedAtMs", "cursor", "identity", "pendingBatches", "schemaVersion", "sessions"]);
    assert.equal(raw.cursor, "sync-opaque");
    assert.deepEqual(raw.sessions, { "!room:example": "acp-session" });
    for (const forbidden of ["eventBody", "inbox", "outbox", "pending", "reply", "accessToken", "agentOutput"]) {
      assert.equal(Object.hasOwn(raw, forbidden), false);
    }
    assert.equal((await lstat(store.statePath)).mode & 0o7777, 0o600);

    const reopened = await openStore(stateDir);
    assert.deepEqual(reopened.getCheckpoint(), {
      schemaVersion: 11,
      identity,
      cursor: "sync-opaque",
      committedAtMs: 1_700_000_000_123,
    });
    assert.equal(reopened.getSessionMapping("!room:example"), "acp-session");
  });
});

void test("state validation rejects unknown fields, malformed values, truncation, and unsupported versions", async () => {
  const cases: Array<{ readonly value: unknown; readonly category?: BridgeStateError["category"] }> = [
    { value: { ...validState(), extra: true }, category: "corrupt" },
    { value: validState({ cursor: "" }), category: "corrupt" },
    { value: validState({ committedAtMs: "yesterday" }), category: "corrupt" },
    { value: validState({ identity: { ...identity, extra: true } }), category: "corrupt" },
    { value: validState({ sessions: { "!room:example": 42 } }), category: "corrupt" },
    { value: "{\"schemaVersion\":1,\"identity\":", category: "corrupt" },
  ];

  for (const schemaVersion of [1, 2, 3, 4, 10, 12]) {
    cases.push({ value: validState({ schemaVersion }), category: "unsupported-version" });
  }

  for (const { value, category } of cases) {
    await withStateDir(async (stateDir) => {
      await writeRawState(stateDir, value);
      await expectStateError(() => openStore(stateDir), category);
    });
  }
});

void test("current-schema recovery ledgers require explicit contiguous completed event IDs", async () => {
  const invalidRooms: unknown[] = [
    { roomId: "!one:example", eventIds: ["$one:example", "$two:example"], completedEventIds: ["$two:example"] },
    { roomId: "!one:example", eventIds: ["$one:example", "$two:example"], completedEventIds: ["$one:example", "$one:example"] },
    { roomId: "!one:example", eventIds: ["$one:example", "$two:example"], completedEventIds: ["$missing:example"] },
    { roomId: "!one:example", eventIds: ["$one:example", "$one:example"], completedEventIds: [] },
    { roomId: "!one:example", eventIds: ["$one:example"], completedEventIds: ["not-an-event-id"] },
    { roomId: "!one:example", eventIds: ["$one:example"], completedEventIds: [], completedPrefix: 0 },
  ];
  for (const room of invalidRooms) {
    await withStateDir(async (stateDir) => {
      await writeRawState(stateDir, validState({
        pendingBatches: [{
          fromCursor: "sync-old",
          nextBatch: "sync-next",
          rooms: [room],
        }],
      }));
      await expectStateError(() => openStore(stateDir), "corrupt");
    });
  }
});

void test("completion uses exact event IDs, is idempotent, and survives restart", async () => {
  await withStateDir(async (stateDir) => {
    const store = await openStore(stateDir);
    await store.commitCursor("cursor-x", 100);
    await store.registerSyncBatch({
      nextBatch: "cursor-y",
      rooms: [{ roomId: "!one:example", eventIds: ["$one:example", "$two:example"] }],
    });

    await expectStateError(() => store.completeSyncEvent("$two:example"), "invalid-input");
    assert.equal(await store.completeSyncEvent("$one:example"), true);
    assert.equal(await store.completeSyncEvent("$one:example"), false);
    assert.deepEqual(store.getPendingRecoveryBatches()[0]?.rooms[0]?.completedEventIds, ["$one:example"]);

    const reopened = await openStore(stateDir);
    const statuses = await reopened.registerSyncBatch({
      nextBatch: "cursor-y",
      rooms: [{ roomId: "!one:example", eventIds: ["$one:example", "$two:example"] }],
    });
    assert.deepEqual(statuses, new Map([
      ["$one:example", "completed"],
      ["$two:example", "pending"],
    ]));
    assert.equal(await reopened.completeSyncEvent("$two:example"), true);
    assert.equal(reopened.getCheckpoint()?.cursor, "cursor-y");
    assert.deepEqual(reopened.getPendingRecoveryBatches(), []);
  });
});

void test("recovery ledgers preserve room order and advance only through contiguous completed event IDs", async () => {
  await withStateDir(async (stateDir) => {
    const store = await openStore(stateDir);
    await store.commitCursor("cursor-x", 100);
    await store.registerSyncBatch({
      nextBatch: "cursor-y",
      rooms: [
        { roomId: "!one:example", eventIds: ["$one:example", "$two:example"] },
        { roomId: "!two:example", eventIds: ["$three:example", "$four:example"] },
      ],
    });
    await store.completeSyncEvent("$one:example");
    await store.completeSyncEvent("$three:example");
    assert.equal(store.getCheckpoint()?.cursor, "cursor-x");
    assert.deepEqual(
      store.getPendingRecoveryBatches()[0]?.rooms.map((room) => room.completedEventIds),
      [["$one:example"], ["$three:example"]],
    );

    await store.completeSyncEvent("$four:example");
    assert.equal(store.getCheckpoint()?.cursor, "cursor-x");
    await store.completeSyncEvent("$two:example");
    assert.equal(store.getCheckpoint()?.cursor, "cursor-y");
    assert.deepEqual(store.getPendingRecoveryBatches(), []);
  });
});

void test("later recovery batches cannot bypass an earlier incomplete batch", async () => {
  await withStateDir(async (stateDir) => {
    const store = await openStore(stateDir);
    await store.commitCursor("cursor-x", 100);
    await store.registerSyncBatch({ nextBatch: "cursor-y", rooms: [{ roomId: "!one:example", eventIds: ["$one:example"] }] });
    await store.registerSyncBatch({ nextBatch: "cursor-z", rooms: [{ roomId: "!one:example", eventIds: ["$two:example"] }] });
    await store.completeSyncEvent("$two:example");
    assert.equal(store.getCheckpoint()?.cursor, "cursor-x");
    assert.equal(store.getPendingRecoveryBatches().length, 2);
    await store.completeSyncEvent("$one:example");
    assert.equal(store.getCheckpoint()?.cursor, "cursor-z");
    assert.deepEqual(store.getPendingRecoveryBatches(), []);
  });
});

void test("state identity is bound to homeserver, user, and device without exposing identity values in errors", async () => {
  await withStateDir(async (stateDir) => {
    await writeRawState(stateDir, validState({ identity: { ...identity, userId: "@other:example" } }));
    const error = await expectStateError(() => openStore(stateDir), "identity-mismatch");
    assert.equal(error.message.includes("@other:example"), false);
    assert.equal(error.message.includes("sync-old"), false);
    assert.equal(error.message.includes("session-one"), false);
  });
});

void test("private state directory and target path protections reject unsafe links and modes", async () => {
  await withStateDir(async (stateDir) => {
    await chmod(stateDir, 0o750);
    await expectStateError(() => openStore(stateDir), "unsafe-path");
    await chmod(stateDir, 0o700);

    await seedState(stateDir);
    const statePath = join(stateDir, BRIDGE_STATE_FILE_NAME);
    await chmod(statePath, 0o640);
    await expectStateError(() => openStore(stateDir), "permissions");
    await chmod(statePath, 0o600);
    await rm(statePath);

    const outside = join(stateDir, "outside.json");
    await writeRawState(stateDir, validState());
    await writeFile(outside, "not-state");
    await chmod(outside, 0o600);
    await rm(statePath);
    await symlink(outside, statePath);
    await expectStateError(() => openStore(stateDir), "unsafe-path");
  });

  await withStateDir(async (parent) => {
    const actual = join(parent, "actual");
    const linked = join(parent, "linked");
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, linked);
    await expectStateError(() => openStore(linked), "unsafe-path");
  });
});

void test("crash-left temporary files are removed and never accepted as state", async () => {
  await withStateDir(async (stateDir) => {
    const temporary = join(stateDir, `.${BRIDGE_STATE_FILE_NAME}.crash.tmp`);
    await writeFile(temporary, "truncated secret-sync-token");
    await chmod(temporary, 0o600);

    const store = await openStore(stateDir);
    assert.equal(store.getCheckpoint(), undefined);
    assert.equal((await readdir(stateDir)).includes(".bridge-state.json.crash.tmp"), false);
    assert.equal((await readdir(stateDir)).includes(BRIDGE_STATE_FILE_NAME), false);
  });
});

void test("cursor and mapping mutations are serialized and preserve concurrent room updates", async () => {
  await withStateDir(async (stateDir) => {
    const store = await openStore(stateDir);
    await store.commitCursor("sync-serialized", 100);
    const rooms = Array.from({ length: 24 }, (_, index) => `!room-${index}:example`);
    await Promise.all(rooms.map((roomId, index) => store.setSessionMapping(roomId, `session-${index}`)));

    assert.equal(store.getSessionMappings().size, rooms.length);
    const reopened = await openStore(stateDir);
    assert.equal(reopened.getSessionMappings().size, rooms.length);
    assert.deepEqual(
      [...reopened.getSessionMappings().keys()].sort(),
      [...rooms].sort(),
    );
  });
});

void test("flush waits for the complete fsync sequence of an accepted mutation", async () => {
  await withStateDir(async (stateDir) => {
    let releaseFsync!: () => void;
    const fsyncStarted = new Promise<void>((resolve) => {
      releaseFsync = resolve;
    });
    let fsyncFinished = false;
    const store = await openStore(stateDir, {
      faultInjector: async (point) => {
        if (point === "file-fsync") {
          await fsyncStarted;
          fsyncFinished = true;
        }
      },
    });

    const commit = store.commitCursor("flush-cursor", 2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fsyncFinished, false);

    let flushed = false;
    const flush = store.flush().then(() => {
      flushed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(flushed, false);

    releaseFsync();
    await Promise.all([commit, flush]);
    assert.equal(fsyncFinished, true);
    assert.equal(store.getCheckpoint()?.cursor, "flush-cursor");
  });
});

void test("mapping prune and discard are atomic operations", async () => {
  await withStateDir(async (stateDir) => {
    await seedState(stateDir);
    const store = await openStore(stateDir);

    assert.deepEqual(await store.pruneSessionMappings(["!one:example", "!new:example"]), ["!two:example"]);
    assert.equal(store.getSessionMapping("!two:example"), undefined);
    assert.equal(await store.removeSessionMapping("!missing:example"), false);
    assert.equal(await store.discardSessionMappings(), true);
    assert.deepEqual([...store.getSessionMappings()], []);

    const reopened = await openStore(stateDir);
    assert.deepEqual([...reopened.getSessionMappings()], []);
    assert.equal(reopened.getCheckpoint()?.cursor, "sync-old");
  });
});

void test("write, file-fsync, rename, and directory-fsync failures reject fatally without updating the reported state", async () => {
  const points: readonly BridgeStateFaultPoint[] = ["write", "file-fsync", "rename", "directory-fsync"];
  for (const point of points) {
    await withStateDir(async (stateDir) => {
      let enabled = false;
      const secret = "raw-io-error-sync-token-session-id";
      const store = await openStore(stateDir, {
        faultInjector: (faultPoint) => {
          if (enabled && faultPoint === point) {
            throw new Error(secret);
          }
        },
      });
      await store.commitCursor("stable-cursor", 1);
      enabled = true;

      const error = await expectStateError(() => store.commitCursor("new-cursor", 2), point);
      assert.equal(error.message.includes(secret), false);
      assert.equal(store.getCheckpoint()?.cursor, "stable-cursor");
      assert.equal(store.getCheckpoint()?.committedAtMs, 1);
      assert.equal((await lstat(store.statePath)).isFile(), true);
    });
  }
});

void test("state diagnostics expose only the sanitized category and file location", async () => {
  await withStateDir(async (stateDir) => {
    const records: Array<{ readonly level: DiagnosticLevel; readonly event: string; readonly fields: DiagnosticFields }> = [];
    const diagnostics: DiagnosticSink = {
      emit(level, event, fields = {}) {
        records.push({ level, event, fields });
      },
      debug() {},
      info() {},
      warn() {},
      error() {},
    };
    let enabled = false;
    const store = await openStore(stateDir, {
      diagnostics,
      faultInjector: () => {
        if (enabled) {
          throw new Error("opaque token and ACP session id");
        }
      },
    });
    await store.commitCursor("stable", 1);
    enabled = true;
    await expectStateError(() => store.commitCursor("new", 2), "write");
    const record = records.at(-1);
    assert.equal(record?.event, "private-state-failure");
    assert.equal(record?.fields.path, store.statePath);
    assert.equal(record?.fields.category, "write");
    assert.equal(JSON.stringify(record).includes("opaque token"), false);
  });
});
