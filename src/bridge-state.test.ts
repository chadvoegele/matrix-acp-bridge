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
      schemaVersion: 12,
      identity,
      initialized: false,
      sessionMappings: {},
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
    ]);
    assert.equal(raw.initialized, true);
    assert.deepEqual(raw.sessions, { [ROOM_ONE]: "acp-session" });
    assert.deepEqual(raw.completedEventIds, { [ROOM_ONE]: [EVENT_ONE, EVENT_TWO] });
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
    assert.deepEqual(store.getSnapshot().completedEventIds, { [ROOM_ONE]: [EVENT_ONE, EVENT_TWO] });
    const reopened = await openStore(stateDir);
    assert.deepEqual(reopened.getSnapshot().completedEventIds, { [ROOM_ONE]: [EVENT_ONE, EVENT_TWO] });
  });
});

void test("strict validation rejects cursor-era state, unknown fields, malformed IDs, and duplicates", async () => {
  const cases: Array<{ readonly value: unknown; readonly category: BridgeStateError["category"] }> = [
    { value: { ...validState(), extra: true }, category: "corrupt" },
    { value: validState({ initialized: "yes" }), category: "corrupt" },
    { value: validState({ completedEventIds: { [ROOM_ONE]: [EVENT_ONE, EVENT_ONE] } }), category: "corrupt" },
    { value: validState({ completedEventIds: { [ROOM_ONE]: ["not-an-event-id"] } }), category: "corrupt" },
    { value: validState({ cursor: "old-cursor" }), category: "corrupt" },
    { value: "{\"schemaVersion\":12,\"identity\":", category: "corrupt" },
  ];
  for (const schemaVersion of [1, 2, 3, 10, 11, 13]) {
    cases.push({ value: validState({ schemaVersion }), category: "unsupported-version" });
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
      rooms.filter((room) => room !== rooms[0] && room !== rooms[1] && room !== ROOM_TWO).sort((left, right) => left.localeCompare(right)),
    );
    assert.equal(await store.discardSessionMappings(), true);
    assert.equal(store.getSnapshot().initialized, true);
    assert.deepEqual(store.getSnapshot().completedEventIds, { [ROOM_ONE]: [EVENT_ONE] });
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

    const points: readonly BridgeStateFaultPoint[] = ["write", "file-fsync", "rename", "directory-fsync"];
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
