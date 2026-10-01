import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BRIDGE_STATE_FILE_NAME,
  BRIDGE_STATE_BACKUP_FILE_NAME,
  BRIDGE_STATE_SCHEMA_VERSION,
  BridgeStateError,
  openBridgeStateStore,
  type BridgeStateFaultPoint,
} from "./bridge-state.js";
import { acquireStateLock } from "./config.js";
import type { ConversationIdentity } from "./conversation-identity.js";
import { InMemorySessionStore, type ThreadConversationRecord } from "./session-store.js";
import type { DiagnosticFields, DiagnosticLevel, DiagnosticSink } from "./diagnostics.js";

const identity = {
  homeserver: "https://matrix.example",
  userId: "@bridge:example",
  deviceId: "BRIDGEDEVICE",
} as const;

const ROOM_ONE = "!one:example";
const ROOM_TWO = "!two:example";
const EVENT_ONE = "$one:example";
const EVENT_TWO = "$two:example";

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
  options: {
    readonly faultInjector?: (point: BridgeStateFaultPoint) => void | Promise<void>;
    readonly diagnostics?: DiagnosticSink;
  } = {},
) {
  return openBridgeStateStore({ stateDir, identity, ...options });
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
    initialized: true,
    sessions: { [ROOM_ONE]: "session-one" },
    threads: [],
    completedEventIds: { [ROOM_ONE]: [EVENT_ONE] },
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

void test("absent private state is fresh and the strict schema round-trips sessions and completed IDs", async () => {
  await withStateDir(async (stateDir) => {
    const store = await openStore(stateDir);
    assert.deepEqual(store.getSnapshot(), {
      schemaVersion: BRIDGE_STATE_SCHEMA_VERSION,
      identity,
      initialized: false,
      sessionMappings: {},
      threadRecords: [],
      completedEventIds: {},
    });

    await store.setSessionMapping(ROOM_ONE, "acp-session");
    await store.establishInitialBaseline([{ roomId: ROOM_ONE, eventIds: [EVENT_ONE, EVENT_TWO] }]);

    const raw = JSON.parse(await readFile(store.statePath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(raw).sort(), [
      "completedEventIds",
      "identity",
      "initialized",
      "schemaVersion",
      "sessions",
      "threads",
    ]);
    assert.equal(raw.initialized, true);
    assert.deepEqual(raw.sessions, { [ROOM_ONE]: "acp-session" });
    assert.deepEqual(raw.completedEventIds, {
      [ROOM_ONE]: [EVENT_ONE, EVENT_TWO],
    });
    for (const forbidden of [
      "cursor",
      "committedAtMs",
      "pendingBatches",
      "observedEventIds",
      "eventBody",
      "accessToken",
      "rawError",
    ]) {
      assert.equal(Object.hasOwn(raw, forbidden), false);
    }
    assert.equal((await lstat(store.statePath)).mode & 0o7777, 0o600);

    const reopened = await openStore(stateDir);
    assert.equal(reopened.getSnapshot().initialized, true);
    assert.equal(reopened.isEventCompleted(ROOM_ONE, EVENT_ONE), true);
    assert.equal(reopened.isEventCompleted(ROOM_TWO, EVENT_ONE), false);
    assert.deepEqual([...reopened.getSessionMappings()], [[ROOM_ONE, "acp-session"]]);
  });
});

void test("baseline establishment is atomic and a failed first commit remains fresh", async () => {
  await withStateDir(async (stateDir) => {
    let failed = false;
    const store = await openStore(stateDir, {
      faultInjector: (point) => {
        if (!failed && point === "rename") {
          failed = true;
          throw new Error("opaque baseline failure");
        }
      },
    });
    await expectStateError(
      () => store.establishInitialBaseline([{ roomId: ROOM_ONE, eventIds: [EVENT_ONE] }]),
      "rename",
    );
    assert.equal(store.getSnapshot().initialized, false);
    assert.deepEqual(store.getSnapshot().completedEventIds, {});

    const reopened = await openStore(stateDir);
    assert.equal(reopened.getSnapshot().initialized, false);
    assert.deepEqual(reopened.getSnapshot().completedEventIds, {});
    await reopened.establishInitialBaseline([{ roomId: ROOM_ONE, eventIds: [EVENT_ONE] }]);
    assert.equal(reopened.getSnapshot().initialized, true);
  });
});

void test("completion is durable, room-scoped, idempotent, and preserves sessions", async () => {
  await withStateDir(async (stateDir) => {
    const store = await openStore(stateDir);
    await store.setSessionMapping(ROOM_ONE, "session-one");
    await store.establishInitialBaseline([{ roomId: ROOM_ONE, eventIds: [EVENT_ONE] }]);

    assert.equal(await store.markEventCompleted(ROOM_ONE, EVENT_TWO), true);
    assert.equal(await store.markEventCompleted(ROOM_ONE, EVENT_TWO), false);
    assert.equal(store.isEventCompleted(ROOM_ONE, EVENT_TWO), true);
    assert.equal(store.isEventCompleted(ROOM_TWO, EVENT_TWO), false);

    const reopened = await openStore(stateDir);
    assert.equal(reopened.isEventCompleted(ROOM_ONE, EVENT_TWO), true);
    assert.deepEqual([...reopened.getSessionMappings()], [[ROOM_ONE, "session-one"]]);
  });
});

void test("compaction retains the current window and newly terminal IDs only", async () => {
  await withStateDir(async (stateDir) => {
    const store = await openStore(stateDir);
    await store.establishInitialBaseline([
      { roomId: ROOM_ONE, eventIds: [EVENT_ONE, EVENT_TWO] },
      { roomId: ROOM_TWO, eventIds: ["$old:example"] },
    ]);
    await store.markEventCompleted(ROOM_ONE, "$outside:example");

    await store.compactCompletedEventIds(
      [
        { roomId: ROOM_ONE, eventIds: [EVENT_TWO, "$not-completed:example"] },
        { roomId: ROOM_TWO, eventIds: [] },
      ],
      [
        { roomId: ROOM_ONE, eventIds: ["$new-terminal:example"] },
        { roomId: ROOM_TWO, eventIds: ["$omitted:example"] },
      ],
    );

    assert.deepEqual(store.getSnapshot().completedEventIds, {
      [ROOM_ONE]: [EVENT_TWO, "$new-terminal:example"],
      [ROOM_TWO]: ["$omitted:example"],
    });
  });
});

void test("a compaction failure leaves the previous ledger intact and therefore only over-retains", async () => {
  await withStateDir(async (stateDir) => {
    let fail = false;
    const store = await openStore(stateDir, {
      faultInjector: (point) => {
        if (fail && point === "write") {
          throw new Error("opaque compaction failure");
        }
      },
    });
    await store.establishInitialBaseline([{ roomId: ROOM_ONE, eventIds: [EVENT_ONE, EVENT_TWO] }]);
    fail = true;
    await expectStateError(
      () => store.compactCompletedEventIds([{ roomId: ROOM_ONE, eventIds: [EVENT_TWO] }]),
      "write",
    );
    assert.deepEqual(store.getSnapshot().completedEventIds, {
      [ROOM_ONE]: [EVENT_ONE, EVENT_TWO],
    });
    const reopened = await openStore(stateDir);
    assert.deepEqual(reopened.getSnapshot().completedEventIds, {
      [ROOM_ONE]: [EVENT_ONE, EVENT_TWO],
    });
  });
});

void test("strict validation rejects cursor-era state, unknown fields, malformed IDs, and duplicates", async () => {
  const cases: Array<{
    readonly value: unknown;
    readonly category: BridgeStateError["category"];
  }> = [
    { value: { ...validState(), extra: true }, category: "corrupt" },
    { value: validState({ initialized: "yes" }), category: "corrupt" },
    {
      value: validState({
        completedEventIds: { [ROOM_ONE]: [EVENT_ONE, EVENT_ONE] },
      }),
      category: "corrupt",
    },
    {
      value: validState({
        completedEventIds: { [ROOM_ONE]: ["not-an-event-id"] },
      }),
      category: "corrupt",
    },
    { value: validState({ cursor: "old-cursor" }), category: "corrupt" },
    { value: '{"schemaVersion":12,"identity":', category: "corrupt" },
  ];
  for (const schemaVersion of [1, 2, 3, 10, 11, 14]) {
    cases.push({
      value: validState({ schemaVersion }),
      category: "unsupported-version",
    });
  }

  for (const { value, category } of cases) {
    await withStateDir(async (stateDir) => {
      await writeRawState(stateDir, value);
      await expectStateError(() => openStore(stateDir), category);
    });
  }
});

void test("state identity is bound without exposing identity or event values in errors", async () => {
  await withStateDir(async (stateDir) => {
    await writeRawState(stateDir, validState({ identity: { ...identity, userId: "@other:example" } }));
    const error = await expectStateError(() => openStore(stateDir), "identity-mismatch");
    assert.equal(error.message.includes("@other:example"), false);
    assert.equal(error.message.includes(EVENT_ONE), false);
    assert.equal(error.message.includes("session-one"), false);
  });
});

void test("session mutations are independent of ledger mutations and are serialized", async () => {
  await withStateDir(async (stateDir) => {
    const store = await openStore(stateDir);
    const rooms = Array.from({ length: 12 }, (_, index) => `!room-${index}:example`);
    await Promise.all(rooms.map((roomId, index) => store.setSessionMapping(roomId, `session-${index}`)));
    await store.establishInitialBaseline([{ roomId: ROOM_ONE, eventIds: [EVENT_ONE] }]);
    assert.equal(store.getSessionMappings().size, rooms.length);
    assert.equal(await store.removeSessionMapping(rooms[0]!), true);
    assert.deepEqual(
      await store.pruneSessionMappings([ROOM_TWO, rooms[1]!]),
      rooms
        .filter((room) => room !== rooms[0] && room !== rooms[1] && room !== ROOM_TWO)
        .sort((left, right) => left.localeCompare(right)),
    );
    assert.equal(await store.discardSessionMappings(), true);
    assert.equal(store.getSnapshot().initialized, true);
    assert.deepEqual(store.getSnapshot().completedEventIds, {
      [ROOM_ONE]: [EVENT_ONE],
    });
  });
});

void test("private path protections, temporary cleanup, and every atomic write failure are sanitized", async () => {
  await withStateDir(async (stateDir) => {
    const temporary = join(stateDir, `.${BRIDGE_STATE_FILE_NAME}.crash.tmp`);
    await writeFile(temporary, "raw token and event body");
    await chmod(temporary, 0o600);
    const store = await openStore(stateDir);
    assert.equal((await readdir(stateDir)).includes(temporary.split("/").at(-1)!), false);
    assert.equal(store.getSnapshot().initialized, false);

    const points = ["write", "file-fsync", "rename", "directory-fsync"] as const;
    for (const point of points) {
      let enabled = false;
      const faulted = await openStore(stateDir, {
        faultInjector: (faultPoint) => {
          if (enabled && faultPoint === point) {
            throw new Error("raw secret and session");
          }
        },
      });
      enabled = true;
      const error = await expectStateError(
        () => faulted.markEventCompleted(ROOM_ONE, `$fault-${point}:example`),
        point,
      );
      assert.equal(error.message.includes("raw secret"), false);
    }
  });

  await withStateDir(async (parent) => {
    const actual = join(parent, "actual");
    const linked = join(parent, "linked");
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, linked);
    await expectStateError(() => openStore(linked), "unsafe-path");
  });
});

void test("state diagnostics expose only sanitized metadata", async () => {
  await withStateDir(async (stateDir) => {
    const records: Array<{
      readonly level: DiagnosticLevel;
      readonly event: string;
      readonly fields: DiagnosticFields;
    }> = [];
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
          throw new Error("opaque event and ACP session id");
        }
      },
    });
    await store.establishInitialBaseline([{ roomId: ROOM_ONE, eventIds: [EVENT_ONE] }]);
    enabled = true;
    await expectStateError(() => store.markEventCompleted(ROOM_ONE, EVENT_TWO), "write");
    const record = records.at(-1);
    assert.equal(record?.event, "private-state-failure");
    assert.equal(record?.fields.path, store.statePath);
    assert.equal(record?.fields.category, "write");
    assert.equal(JSON.stringify(record).includes("opaque event"), false);
  });
});

const THREAD_ONE = { kind: "thread", roomId: ROOM_ONE, threadRootEventId: EVENT_ONE } as const;
const THREAD_TWO = { ...THREAD_ONE, threadRootEventId: EVENT_TWO };
const THREAD_OTHER_ROOM = { ...THREAD_ONE, roomId: ROOM_TWO };

function legacyState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 12,
    identity: { ...identity },
    initialized: true,
    sessions: { [ROOM_ONE]: "legacy-room-session" },
    completedEventIds: { [ROOM_ONE]: [EVENT_ONE, EVENT_TWO] },
    ...overrides,
  };
}

void test("thread records isolate modes, roots and rooms, persist sessionless admission, and survive reset/restart", async () => {
  await withStateDir(async (stateDir) => {
    let store = await openStore(stateDir);
    await Promise.all([
      store.setSessionMapping(ROOM_ONE, "room-session"),
      store.setConversationRecord({ ...THREAD_ONE, sessionId: "thread-one" }),
      store.setConversationRecord({ ...THREAD_TWO, sessionId: "thread-two" }),
      store.setConversationRecord({ ...THREAD_OTHER_ROOM, sessionId: "other-room" }),
    ]);
    const admitted = { ...THREAD_TWO, threadRootEventId: "$admitted" };
    await store.setConversationRecord(admitted);
    await store.establishInitialBaseline([{ roomId: ROOM_ONE, eventIds: [EVENT_ONE] }]);
    await store.markEventCompleted(ROOM_ONE, EVENT_TWO);
    await store.compactCompletedEventIds([{ roomId: ROOM_ONE, eventIds: [EVENT_TWO] }]);
    assert.equal(await store.resetConversation(THREAD_ONE), true);
    assert.equal(await store.resetConversation(THREAD_ONE), false);
    assert.equal(await store.resetConversation({ ...THREAD_ONE, threadRootEventId: "$unknown" }), false);
    store = await openStore(stateDir);
    assert.deepEqual(store.getConversationRecord(THREAD_ONE), THREAD_ONE);
    assert.deepEqual(store.getConversationRecord(admitted), admitted);
    assert.deepEqual(store.getConversationRecord(THREAD_TWO), { ...THREAD_TWO, sessionId: "thread-two" });
    assert.deepEqual(store.getConversationRecord(THREAD_OTHER_ROOM), { ...THREAD_OTHER_ROOM, sessionId: "other-room" });
    assert.equal(store.getSessionMapping(ROOM_ONE), "room-session");
    assert.equal(store.getConversationRecord({ ...THREAD_ONE, threadRootEventId: "$unknown" }), undefined);
    assert.deepEqual(store.getSnapshot().completedEventIds, { [ROOM_ONE]: [EVENT_TWO] });
    assert.equal(store.getConversationRecords().length, 5);
    assert.equal(await store.setConversationRecord({ ...THREAD_ONE, sessionId: "fresh-session" }), true);
    assert.equal(await store.setConversationRecord({ ...THREAD_ONE, sessionId: "fresh-session" }), false);
    assert.equal((await openStore(stateDir)).getConversationRecord(THREAD_ONE)?.sessionId, "fresh-session");
    // Merely opening/reading state performs no ACP calls or eager session loading.
    // Returning to room mode addresses the independent room record.
    assert.deepEqual(store.getConversationRecord({ kind: "room", roomId: ROOM_ONE }), {
      kind: "room",
      roomId: ROOM_ONE,
      sessionId: "room-session",
    });
    assert.equal(await store.resetConversation({ kind: "room", roomId: ROOM_ONE }), true);
    assert.equal(store.getConversationRecords().length, 4);
  });
});

void test("room pruning removes all thread identities while no-load startup discards both modes and preserves live identities", async () => {
  await withStateDir(async (stateDir) => {
    const store = await openStore(stateDir);
    await store.setSessionMapping(ROOM_ONE, "room-session");
    await store.setConversationRecord({ ...THREAD_ONE, sessionId: "one" });
    await store.setConversationRecord(THREAD_TWO);
    await store.setConversationRecord(THREAD_OTHER_ROOM);
    await store.establishInitialBaseline([{ roomId: ROOM_ONE, eventIds: [EVENT_ONE] }]);
    // Neither response mode nor sender configuration is part of pruning input.
    assert.deepEqual(await store.pruneSessionMappings([ROOM_ONE, ROOM_TWO]), []);
    assert.deepEqual(await store.pruneSessionMappings([ROOM_TWO]), [ROOM_ONE]);
    const reopened = await openStore(stateDir);
    assert.deepEqual(reopened.getConversationRecords(), [THREAD_OTHER_ROOM]);
    const live = new InMemorySessionStore();
    live.setConversationRecord({ ...THREAD_OTHER_ROOM, sessionId: "live-session" });
    assert.equal(await reopened.discardSessionMappings(), true);
    assert.equal(await reopened.discardSessionMappings(), false);
    assert.deepEqual((await openStore(stateDir)).getConversationRecords(), []);
    assert.equal(live.resetConversation(THREAD_OTHER_ROOM), true);
    assert.deepEqual(live.getConversationRecord(THREAD_OTHER_ROOM), THREAD_OTHER_ROOM);
    assert.deepEqual(reopened.getSnapshot().completedEventIds, { [ROOM_ONE]: [EVENT_ONE] });
    assert.equal(reopened.getSnapshot().initialized, true);
  });
});

void test("state snapshots and accepted thread operations do not share mutable record objects", async () => {
  await withStateDir(async (stateDir) => {
    const store = await openStore(stateDir);
    const input = { ...THREAD_ONE, sessionId: "accepted" };
    const pending = store.setConversationRecord(input);
    input.sessionId = "caller-mutated";
    await pending;
    const copy = store.getConversationRecord(THREAD_ONE) as { sessionId: string };
    copy.sessionId = "snapshot-mutated";
    const snapshot = store.getSnapshot();
    (snapshot.threadRecords[0] as { sessionId: string }).sessionId = "snapshot-mutated";
    assert.equal(store.getConversationRecord(THREAD_ONE)?.sessionId, "accepted");
    assert.equal((await openStore(stateDir)).getConversationRecord(THREAD_ONE)?.sessionId, "accepted");
  });
});

void test("strict thread schema rejects malformed records, duplicate identities, and sessionless rooms without rewriting", async () => {
  const invalidThreads: readonly unknown[] = [
    {},
    null,
    [{ ...THREAD_ONE, kind: "room" }],
    [{ ...THREAD_ONE, threadRootEventId: "bad-root" }],
    [{ ...THREAD_ONE, roomId: "bad-room" }],
    [{ ...THREAD_ONE, sessionId: "" }],
    [{ ...THREAD_ONE, sessionId: null }],
    [{ ...THREAD_ONE, sessionId: "secret\nvalue" }],
    [{ ...THREAD_ONE, extra: "secret" }],
    [THREAD_ONE, { ...THREAD_ONE, sessionId: "duplicate" }],
  ];
  for (const threads of invalidThreads) {
    await withStateDir(async (stateDir) => {
      await writeRawState(stateDir, validState({ threads }));
      const original = await readFile(join(stateDir, BRIDGE_STATE_FILE_NAME));
      const error = await expectStateError(() => openStore(stateDir), "corrupt");
      assert.match(error.message, /Stop the bridge.*recovery/u);
      assert.equal(error.message.includes("secret"), false);
      assert.deepEqual(await readFile(join(stateDir, BRIDGE_STATE_FILE_NAME)), original);
      assert.equal((await readdir(stateDir)).includes(BRIDGE_STATE_BACKUP_FILE_NAME), false);
    });
  }
  await withStateDir(async (stateDir) => {
    const store = await openStore(stateDir);
    await expectStateError(
      () => store.setConversationRecord({ ...THREAD_ONE, sessionId: undefined } as unknown as ThreadConversationRecord),
      "invalid-input",
    );
    await expectStateError(
      () => store.resetConversation({ ...THREAD_ONE, extra: true } as ConversationIdentity),
      "invalid-input",
    );
    assert.deepEqual(store.getConversationRecords(), []);
  });
});

void test("failed thread reset is fatal, leaves memory unchanged, and cannot acknowledge a successful reset", async () => {
  for (const point of ["write", "file-fsync", "rename", "directory-fsync"] as const) {
    await withStateDir(async (stateDir) => {
      let fail = false;
      const store = await openStore(stateDir, {
        faultInjector: (at) => {
          if (fail && at === point) throw new Error("private session error");
        },
      });
      await store.setConversationRecord({ ...THREAD_ONE, sessionId: "old-session" });
      fail = true;
      await expectStateError(() => store.resetConversation(THREAD_ONE), point);
      assert.equal(store.getConversationRecord(THREAD_ONE)?.sessionId, "old-session");
      const disk = (await openStore(stateDir)).getConversationRecord(THREAD_ONE);
      assert.ok(disk !== undefined);
      if (point !== "directory-fsync") assert.equal(disk.sessionId, "old-session");
      // A post-rename fsync failure is fatal with an indeterminate disk commit;
      // either valid record is safe, but the caller must never send success.
    });
  }
});

void test("schema-12 migration preserves identity/ledger/room sessions, SDK-owned recovery and lock ownership with a private original backup", async () => {
  await withStateDir(async (stateDir) => {
    const original = `${JSON.stringify(legacyState(), null, 2)}\n`;
    await writeRawState(stateDir, original);
    const sdkPath = join(stateDir, "sdk-sync-recovery.json");
    const sdkBytes = '{"nextBatch":"sdk-owned-cursor","recovery":"sdk-owned"}\n';
    await writeFile(sdkPath, sdkBytes, { mode: 0o600 });
    const lock = await acquireStateLock(stateDir);
    try {
      const store = await openStore(stateDir);
      assert.equal(store.getSnapshot().schemaVersion, 13);
      assert.equal(store.getSnapshot().initialized, true);
      assert.deepEqual(store.getSnapshot().identity, identity);
      assert.deepEqual(store.getSnapshot().completedEventIds, { [ROOM_ONE]: [EVENT_ONE, EVENT_TWO] });
      assert.equal(store.getSessionMapping(ROOM_ONE), "legacy-room-session");
      assert.deepEqual(store.getSnapshot().threadRecords, []);
      assert.equal(await readFile(sdkPath, "utf8"), sdkBytes);
      await assert.rejects(() => acquireStateLock(stateDir), /already locked/u);
      const backupPath = join(stateDir, BRIDGE_STATE_BACKUP_FILE_NAME);
      const originalStat = await lstat(backupPath);
      assert.equal(originalStat.mode & 0o7777, 0o600);
      assert.equal(originalStat.uid, process.getuid?.());
      assert.equal(await readFile(backupPath, "utf8"), original);
      await store.setConversationRecord({ ...THREAD_ONE, sessionId: "new-thread" });
      const reopened = await openStore(stateDir);
      assert.equal(reopened.getConversationRecord(THREAD_ONE)?.sessionId, "new-thread");
      assert.equal((await lstat(backupPath)).ino, originalStat.ino);
      assert.equal(await readFile(backupPath, "utf8"), original);
      assert.equal(await readFile(sdkPath, "utf8"), sdkBytes);
      assert.equal(
        (await readdir(stateDir)).some((name) => name.endsWith(".tmp")),
        false,
      );
    } finally {
      await lock.release();
    }
    const nextLock = await acquireStateLock(stateDir);
    await nextLock.release();
  });
});

void test("migration preserves an uninitialized baseline and does not synthesize thread context", async () => {
  await withStateDir(async (stateDir) => {
    await writeRawState(stateDir, legacyState({ initialized: false, completedEventIds: {} }));
    const migrated = await openStore(stateDir);
    assert.equal(migrated.getSnapshot().initialized, false);
    assert.equal(migrated.getConversationRecord(THREAD_ONE), undefined);
    assert.equal(migrated.getSessionMapping(ROOM_ONE), "legacy-room-session");
  });
});

void test("backup and migration write/fsync/rename failures leave original bytes and a retryable startup", async () => {
  const points = [
    "backup-write",
    "backup-file-fsync",
    "backup-link",
    "backup-directory-fsync",
    "write",
    "file-fsync",
    "rename",
    "directory-fsync",
  ] as const;
  for (const point of points) {
    await withStateDir(async (stateDir) => {
      await writeRawState(stateDir, legacyState());
      const original = await readFile(join(stateDir, BRIDGE_STATE_FILE_NAME));
      const error = await expectStateError(
        () =>
          openStore(stateDir, {
            faultInjector: (at) => {
              if (at === point) throw new Error("raw-secret migration failure");
            },
          }),
        point.startsWith("backup-") ? "backup" : (point as BridgeStateError["category"]),
      );
      assert.equal(error.message.includes("raw-secret"), false);
      assert.deepEqual(await readFile(join(stateDir, BRIDGE_STATE_FILE_NAME)), original);
      assert.equal(
        (await readdir(stateDir)).some((name) => name.endsWith(".tmp")),
        false,
      );
      const reopened = await openStore(stateDir);
      assert.equal(reopened.getSnapshot().schemaVersion, 13);
      assert.deepEqual(await readFile(join(stateDir, BRIDGE_STATE_BACKUP_FILE_NAME)), original);
    });
  }
});

void test("an existing unsafe, corrupt or incompatible backup blocks migration without overwriting either file", async () => {
  for (const mode of ["public", "symlink", "corrupt", "wrong-schema", "wrong-identity", "directory"] as const) {
    await withStateDir(async (stateDir) => {
      await writeRawState(stateDir, legacyState());
      const original = await readFile(join(stateDir, BRIDGE_STATE_FILE_NAME));
      const backupPath = join(stateDir, BRIDGE_STATE_BACKUP_FILE_NAME);
      if (mode === "symlink") {
        await symlink(join(stateDir, BRIDGE_STATE_FILE_NAME), backupPath);
      } else if (mode === "directory") {
        await mkdir(backupPath, { mode: 0o700 });
      } else {
        const content =
          mode === "corrupt"
            ? "original-private-backup"
            : JSON.stringify(
                mode === "wrong-schema"
                  ? validState()
                  : legacyState(mode === "wrong-identity" ? { identity: { ...identity, deviceId: "OTHER" } } : {}),
              );
        await writeFile(backupPath, content, { mode: 0o600 });
        // File creation is filtered by the caller's umask. Explicitly make
        // this unsafe fixture public even when tests run under umask 077.
        if (mode === "public") await chmod(backupPath, 0o644);
      }
      const before = await lstat(backupPath);
      await expectStateError(() => openStore(stateDir), "backup");
      assert.deepEqual(await readFile(join(stateDir, BRIDGE_STATE_FILE_NAME)), original);
      assert.equal((await lstat(backupPath)).ino, before.ino);
    });
  }
});

void test("stop/restore-backup rollback restores the exact old schema and loses post-migration changes; remigration never replaces the first backup", async () => {
  await withStateDir(async (stateDir) => {
    await writeRawState(stateDir, legacyState());
    const original = await readFile(join(stateDir, BRIDGE_STATE_FILE_NAME));
    const store = await openStore(stateDir);
    await store.setConversationRecord({ ...THREAD_ONE, sessionId: "post-migration-thread" });
    await store.setSessionMapping(ROOM_ONE, "post-migration-room");
    await store.markEventCompleted(ROOM_ONE, "$post-migration");
    await store.flush();
    // The daemon must stop/release its lock before this operator procedure.
    const backupPath = join(stateDir, BRIDGE_STATE_BACKUP_FILE_NAME);
    const backupStat = await lstat(backupPath);
    const restorePath = join(stateDir, "bridge-state.restore.tmp");
    await copyFile(backupPath, restorePath);
    await chmod(restorePath, 0o600);
    await rename(restorePath, store.statePath);
    assert.deepEqual(await readFile(store.statePath), original);
    const oldDocument = JSON.parse(await readFile(store.statePath, "utf8")) as Record<string, unknown>;
    assert.equal(oldDocument.schemaVersion, 12);
    assert.deepEqual(Object.keys(oldDocument).sort(), [
      "completedEventIds",
      "identity",
      "initialized",
      "schemaVersion",
      "sessions",
    ]);
    assert.equal(Object.hasOwn(oldDocument, "threads"), false);
    const reopened = await openStore(stateDir);
    assert.equal(reopened.getSessionMapping(ROOM_ONE), "legacy-room-session");
    assert.equal(reopened.getConversationRecord(THREAD_ONE), undefined);
    assert.equal(reopened.isEventCompleted(ROOM_ONE, "$post-migration"), false);
    assert.equal((await lstat(backupPath)).ino, backupStat.ino);
    assert.deepEqual(await readFile(backupPath), original);
    // If an old binary runs after rollback and changes room state, a later
    // upgrade still preserves the first backup rather than silently refreshing it.
    await writeRawState(stateDir, legacyState({ sessions: { [ROOM_ONE]: "old-binary-later-session" } }));
    assert.equal((await openStore(stateDir)).getSessionMapping(ROOM_ONE), "old-binary-later-session");
    assert.deepEqual(await readFile(backupPath), original);
  });
});

void test("invalid legacy documents fail before backup or migration and retain the exact original", async () => {
  for (const document of [
    legacyState({ sessions: { [ROOM_ONE]: "" } }),
    legacyState({ completedEventIds: { [ROOM_ONE]: [EVENT_ONE, EVENT_ONE] } }),
    legacyState({ identity: { ...identity, deviceId: "OTHER" } }),
    legacyState({ identity: { ...identity, homeserver: "invalid" } }),
    legacyState({ initialized: null }),
    legacyState({ cursor: "must-remain-sdk-owned" }),
    legacyState({ schemaVersion: 14 }),
  ]) {
    await withStateDir(async (stateDir) => {
      await writeRawState(stateDir, document);
      const original = await readFile(join(stateDir, BRIDGE_STATE_FILE_NAME));
      await expectStateError(() => openStore(stateDir));
      assert.deepEqual(await readFile(join(stateDir, BRIDGE_STATE_FILE_NAME)), original);
      assert.equal((await readdir(stateDir)).includes(BRIDGE_STATE_BACKUP_FILE_NAME), false);
    });
  }
});

void test("backup durability precedes schema replacement", async () => {
  await withStateDir(async (stateDir) => {
    await writeRawState(stateDir, legacyState());
    const points: BridgeStateFaultPoint[] = [];
    await openStore(stateDir, {
      faultInjector: (point) => {
        points.push(point);
      },
    });
    assert.deepEqual(points, [
      "backup-write",
      "backup-file-fsync",
      "backup-link",
      "backup-directory-fsync",
      "write",
      "file-fsync",
      "rename",
      "directory-fsync",
    ]);
  });
});

void test("thread retention has no count or age limit and reopening never refreshes the backup", async () => {
  await withStateDir(async (stateDir) => {
    await writeRawState(stateDir, legacyState());
    const store = await openStore(stateDir);
    const records = Array.from({ length: 32 }, (_, index) => ({
      ...THREAD_ONE,
      threadRootEventId: `$retained-${index}`,
      sessionId: `session-${index}`,
    }));
    await Promise.all(records.map((record) => store.setConversationRecord(record)));
    const reopened = await openStore(stateDir, {
      faultInjector: (point) => {
        if (point.startsWith("backup-")) throw new Error("backup must never be refreshed");
      },
    });
    for (const record of records) {
      const { sessionId: _sessionId, ...threadIdentity } = record;
      assert.deepEqual(reopened.getConversationRecord(threadIdentity), record);
    }
    assert.equal(reopened.getSnapshot().threadRecords.length, records.length);
  });
});
