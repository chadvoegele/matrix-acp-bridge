import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openBridgeStateStore } from "./bridge-state.js";
import { MatrixSyncCoordinator } from "./sync-coordinator.js";
import type { BridgeConfig } from "./config.js";
import type { Clock } from "./clock.js";
import type { DiagnosticRecord } from "./diagnostics.js";
import type {
  InboundMatrixEvent,
  MatrixSyncBatch,
} from "./matrix-client.js";

const ROOM = "!room:example.org";
const OTHER_ROOM = "!other:example.org";
const USER = "@bridge:example.org";
const ALICE = "@alice:example.org";

const CONFIG: BridgeConfig = {
  stateDir: "/unused",
  matrix: {
    homeserver: "https://matrix.example.org",
    userId: USER,
    deviceId: "DEVICE",
    accessTokenFile: "/unused/token",
    allowedRooms: [ROOM, OTHER_ROOM],
    allowedSenders: [ALICE],
    encryption: "disabled",
  },
  acp: { cwd: "/unused/workspace" },
  limits: {
    maxInputBytes: 1000,
    maxOutputBytes: 256,
    maxMatrixMessageBytes: 128,
    maxQueuedTurnsPerRoom: 1,
    maxConcurrentPrompts: 1,
    maxTurnSeconds: 10,
    shutdownGraceSeconds: 1,
    startupTimeoutSeconds: 10,
    maxCatchupAgeSeconds: 10,
    maxCatchupEventsPerRoom: 4,
  },
};

class TestClock implements Clock {
  constructor(public nowMs: number) {}

  now(): number {
    return this.nowMs;
  }

  setTimeout(callback: () => void, _delayMs: number): unknown {
    callback();
    return undefined;
  }

  clearTimeout(_handle: unknown): void {
    // no-op
  }
}

class TestBridge {
  intake = false;
  dispatch = false;
  readonly admitted: InboundMatrixEvent[] = [];

  constructor(readonly options: {
    readonly completion?: Promise<void>;
    readonly consumesTerminalCompletion?: boolean;
    readonly onAdmission?: () => void;
  } = {}) {}

  get completion(): Promise<void> {
    return this.options.completion ?? new Promise<void>(() => {});
  }

  get consumesTerminalCompletion(): boolean {
    return this.options.consumesTerminalCompletion ?? false;
  }

  openIntake(): void {
    this.intake = true;
  }

  enableDispatch(): void {
    this.dispatch = true;
  }

  handleTimelineEvent(event: InboundMatrixEvent): Promise<void> {
    assert.equal(this.intake, true);
    assert.equal(this.dispatch, false);
    this.options.onAdmission?.();
    this.admitted.push(event);
    return this.completion;
  }
}

function event(eventId: string, roomId = ROOM): InboundMatrixEvent {
  return {
    roomId,
    eventId,
    sender: ALICE,
    type: "m.room.message",
    content: { msgtype: "m.text", body: eventId },
    isLive: true,
    isCatchUp: true,
    timeline: { phase: "incremental", isCatchUp: true, limited: false },
    isRedacted: false,
    isPlaintext: true,
    isEncrypted: false,
    isDecrypted: true,
  };
}

function batch(nextBatch: string, timeline: readonly InboundMatrixEvent[], roomId = ROOM): MatrixSyncBatch {
  return {
    nextBatch,
    phase: "incremental",
    rooms: [{ roomId, timeline, limited: false }],
  };
}

function noop(): void {}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: () => void = noop;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function withStore<T>(run: (stateDir: string, clock: TestClock, records: DiagnosticRecord[]) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m2-"));
  const records: DiagnosticRecord[] = [];
  const clock = new TestClock(100_000);
  try {
    return await run(stateDir, clock, records);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

function diagnostics(records: DiagnosticRecord[]): {
  emit(level: DiagnosticRecord["level"], eventName: string, fields?: Record<string, string | number | boolean | null>): void;
  debug(): void;
  info(): void;
  warn(): void;
  error(): void;
} {
  return {
    emit(level, eventName, fields = {}) {
      records.push({ timestamp: "", level, event: eventName, fields });
    },
    debug() { /* no-op */ },
    info() { /* no-op */ },
    warn() { /* no-op */ },
    error() { /* no-op */ },
  };
}

void test("first run suppresses its timeline and commits only after startup validation", async () => {
  await withStore(async (stateDir, clock, records) => {
    const store = await openBridgeStateStore({
      stateDir,
      identity: { homeserver: CONFIG.matrix.homeserver, userId: USER, deviceId: "DEVICE" },
      now: () => clock.now(),
    });
    const bridge = new TestBridge();
    const coordinator = new MatrixSyncCoordinator({
      config: CONFIG,
      bridge,
      stateStore: store,
      clock,
      diagnostics: diagnostics(records),
      onFatal: (error) => { throw new Error(error.message); },
    });

    await coordinator.handleBatch({
      nextBatch: "opaque-first-cursor",
      phase: "initial",
      rooms: [{ roomId: ROOM, timeline: [event("$history")], limited: false }],
    });

    assert.equal(bridge.admitted.length, 0);
    assert.equal(bridge.intake, true);
    assert.equal(bridge.dispatch, true);
    assert.equal(store.getCheckpoint()?.cursor, "opaque-first-cursor");
  });
});

void test("short catch-up keeps newest events in Matrix order and holds the cursor until terminal completion", async () => {
  await withStore(async (stateDir, clock, records) => {
    const store = await openBridgeStateStore({
      stateDir,
      identity: { homeserver: CONFIG.matrix.homeserver, userId: USER, deviceId: "DEVICE" },
      now: () => clock.now(),
    });
    await store.commitCursor("old-cursor", 95_000);
    const bridge = new TestBridge();
    const coordinator = new MatrixSyncCoordinator({
      config: CONFIG,
      bridge,
      stateStore: store,
      clock,
      diagnostics: diagnostics(records),
      onFatal: (error) => { throw new Error(error.message); },
    });

    await coordinator.handleBatch(batch("new-cursor", [event("$one"), event("$two"), event("$three")]));

    assert.deepEqual(bridge.admitted.map((item) => item.eventId), ["$two", "$three"]);
    assert.equal(store.getCheckpoint()?.cursor, "old-cursor");
    assert.deepEqual(store.getPendingRecoveryBatches()[0]?.rooms[0]?.eventIds, ["$two", "$three"]);
    assert.deepEqual(store.getPendingRecoveryBatches()[0]?.rooms[0]?.completedEventIds, []);
    assert.equal(bridge.dispatch, true);
    assert.equal(records.some((record) => record.event === "catch-up-events-omitted"), true);
  });
});

void test("coordinator suppresses an exact completed event while replaying the next pending event", async () => {
  await withStore(async (stateDir, clock, records) => {
    const store = await openBridgeStateStore({
      stateDir,
      identity: { homeserver: CONFIG.matrix.homeserver, userId: USER, deviceId: "DEVICE" },
      now: () => clock.now(),
    });
    await store.commitCursor("old-cursor", 95_000);
    await store.registerSyncBatch({
      nextBatch: "pending-cursor",
      rooms: [{ roomId: ROOM, eventIds: ["$one", "$two"] }],
    });
    await store.completeSyncEvent("$one");

    const bridge = new TestBridge();
    const coordinator = new MatrixSyncCoordinator({
      config: CONFIG,
      bridge,
      stateStore: store,
      clock,
      diagnostics: diagnostics(records),
      onFatal: (error) => { throw new Error(error.message); },
    });

    await coordinator.handleBatch(batch("replayed-cursor", [event("$one"), event("$two")]));

    assert.deepEqual(bridge.admitted.map((item) => item.eventId), ["$two"]);
    assert.equal(store.getCheckpoint()?.cursor, "old-cursor");
    assert.deepEqual(store.getPendingRecoveryBatches()[0]?.rooms[0]?.completedEventIds, ["$one"]);
    assert.deepEqual(store.getPendingRecoveryBatches()[0]?.rooms[0]?.eventIds, ["$one", "$two"]);
  });
});

void test("callback-aware bridge resolution does not complete an interrupted event", async () => {
  await withStore(async (stateDir, clock, records) => {
    const store = await openBridgeStateStore({
      stateDir,
      identity: { homeserver: CONFIG.matrix.homeserver, userId: USER, deviceId: "DEVICE" },
      now: () => clock.now(),
    });
    await store.commitCursor("old-cursor", 95_000);
    const bridge = new TestBridge({ completion: Promise.resolve(), consumesTerminalCompletion: true });
    const coordinator = new MatrixSyncCoordinator({
      config: CONFIG,
      bridge,
      stateStore: store,
      clock,
      diagnostics: diagnostics(records),
      onFatal: (error) => { throw new Error(error.message); },
    });

    await coordinator.handleBatch(batch("new-cursor", [event("$interrupted")]));
    await coordinator.flush();

    assert.equal(store.getCheckpoint()?.cursor, "old-cursor");
    assert.deepEqual(store.getPendingRecoveryBatches()[0]?.rooms[0]?.eventIds, ["$interrupted"]);
  });
});

void test("callback-unaware bridge resolution completes an event for compatibility", async () => {
  await withStore(async (stateDir, clock, records) => {
    const store = await openBridgeStateStore({
      stateDir,
      identity: { homeserver: CONFIG.matrix.homeserver, userId: USER, deviceId: "DEVICE" },
      now: () => clock.now(),
    });
    await store.commitCursor("old-cursor", 95_000);
    const bridge = new TestBridge({ completion: Promise.resolve() });
    const coordinator = new MatrixSyncCoordinator({
      config: CONFIG,
      bridge,
      stateStore: store,
      clock,
      diagnostics: diagnostics(records),
      onFatal: (error) => { throw new Error(error.message); },
    });

    await coordinator.handleBatch(batch("new-cursor", [event("$completed")]));
    await coordinator.flush();

    assert.equal(store.getCheckpoint()?.cursor, "new-cursor");
    assert.deepEqual(store.getPendingRecoveryBatches(), []);
  });
});

void test("does not admit recovery events until durable batch registration commits", async () => {
  await withStore(async (stateDir, clock, records) => {
    const store = await openBridgeStateStore({
      stateDir,
      identity: { homeserver: CONFIG.matrix.homeserver, userId: USER, deviceId: "DEVICE" },
      now: () => clock.now(),
    });
    await store.commitCursor("old-cursor", 95_000);

    let registerStarted!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      registerStarted = resolve;
    });
    let releaseRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let registrationCommitted = false;
    const registerSyncBatch = store.registerSyncBatch.bind(store);
    store.registerSyncBatch = async (input) => {
      registerStarted();
      await registrationGate;
      const result = await registerSyncBatch(input);
      registrationCommitted = true;
      return result;
    };

    const bridge = new TestBridge({
      onAdmission: () => {
        assert.equal(registrationCommitted, true);
      },
    });
    const coordinator = new MatrixSyncCoordinator({
      config: CONFIG,
      bridge,
      stateStore: store,
      clock,
      diagnostics: diagnostics(records),
      onFatal: (error) => { throw new Error(error.message); },
    });

    const handling = coordinator.handleBatch(batch("new-cursor", [event("$registered-after-commit")]));
    await registrationStarted;
    assert.equal(bridge.admitted.length, 0);
    releaseRegistration();
    await handling;
    assert.deepEqual(bridge.admitted.map((item) => item.eventId), ["$registered-after-commit"]);
  });
});

void test("old and backward-dated checkpoints skip catch-up without busy admissions", async () => {
  await withStore(async (stateDir, clock, records) => {
    const store = await openBridgeStateStore({
      stateDir,
      identity: { homeserver: CONFIG.matrix.homeserver, userId: USER, deviceId: "DEVICE" },
      now: () => clock.now(),
    });
    await store.commitCursor("old-cursor", 1000);
    const bridge = new TestBridge();
    const coordinator = new MatrixSyncCoordinator({
      config: CONFIG,
      bridge,
      stateStore: store,
      clock,
      diagnostics: diagnostics(records),
      onFatal: (error) => { throw new Error(error.message); },
    });

    await coordinator.handleBatch(batch("skipped-cursor", [event("$omitted")]));
    assert.deepEqual(bridge.admitted, []);
    assert.equal(store.getCheckpoint()?.cursor, "skipped-cursor");
    assert.equal(records.some((record) => record.event === "catch-up-skipped-age"), true);

    const backwardClock = new TestClock(500);
    const secondStateDir = await mkdtemp(join(tmpdir(), "matrix-acp-m2-backward-"));
    const secondStore = await openBridgeStateStore({
      stateDir: secondStateDir,
      identity: { homeserver: CONFIG.matrix.homeserver, userId: USER, deviceId: "DEVICE" },
      now: () => backwardClock.now(),
    });
    try {
      await secondStore.commitCursor("future-cursor", 1000);
      const secondBridge = new TestBridge();
      const second = new MatrixSyncCoordinator({
        config: CONFIG,
        bridge: secondBridge,
        stateStore: secondStore,
        clock: backwardClock,
        diagnostics: diagnostics(records),
        onFatal: (error) => { throw new Error(error.message); },
      });
      await second.handleBatch(batch("backward-cursor", [event("$backward")]));
      assert.deepEqual(secondBridge.admitted.map((item) => item.eventId), ["$backward"]);
      assert.equal(records.some((record) => record.event === "clock-skew-during-catch-up"), true);
    } finally {
      await rm(secondStateDir, { recursive: true, force: true });
    }
  });
});

void test("durable FIFO completes an omitted pending event before a later replayed event", async () => {
  await withStore(async (stateDir, clock, records) => {
    const store = await openBridgeStateStore({
      stateDir,
      identity: { homeserver: CONFIG.matrix.homeserver, userId: USER, deviceId: "DEVICE" },
      now: () => clock.now(),
    });
    await store.commitCursor("old-cursor", 95_000);
    await store.registerSyncBatch({
      nextBatch: "pending-cursor",
      rooms: [{ roomId: ROOM, eventIds: ["$previously-pending:example.org"] }],
    });

    const omittedRelease = deferred();
    const omittedStart = deferred();
    const completeSyncEvent = store.completeSyncEvent.bind(store);
    store.completeSyncEvent = async (eventId) => {
      if (eventId === "$previously-pending:example.org") {
        omittedStart.resolve();
        await omittedRelease.promise;
      }
      return completeSyncEvent(eventId);
    };

    const bridge = new TestBridge({ completion: Promise.resolve() });
    const coordinator = new MatrixSyncCoordinator({
      config: CONFIG,
      bridge,
      stateStore: store,
      clock,
      diagnostics: diagnostics(records),
      onFatal: (error) => { throw new Error(error.message); },
    });
    const omitted = {
      ...event("$previously-pending:example.org"),
      sender: "@not-allowed:example.org",
    } satisfies InboundMatrixEvent;

    // The replayed timeline can report a newly registered event before the
    // older durable pending event. Durable room FIFO remains authoritative.
    const handled = coordinator.handleBatch(batch("next-cursor", [
      event("$selected-later:example.org"),
      omitted,
    ]));
    await omittedStart.promise;
    assert.equal(bridge.admitted.length, 0);

    omittedRelease.resolve();
    await handled;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    await coordinator.flush();

    assert.deepEqual(bridge.admitted.map((item) => item.eventId), ["$selected-later:example.org"]);
    assert.equal(store.getCheckpoint()?.cursor, "next-cursor");
    assert.deepEqual(store.getPendingRecoveryBatches(), []);
  });
});

void test("limited timelines are reported and never paginated", async () => {
  await withStore(async (stateDir, clock, records) => {
    const store = await openBridgeStateStore({
      stateDir,
      identity: { homeserver: CONFIG.matrix.homeserver, userId: USER, deviceId: "DEVICE" },
      now: () => clock.now(),
    });
    const bridge = new TestBridge();
    const coordinator = new MatrixSyncCoordinator({
      config: CONFIG,
      bridge,
      stateStore: store,
      clock,
      diagnostics: diagnostics(records),
      onFatal: (error) => { throw new Error(error.message); },
    });
    await coordinator.handleBatch({
      nextBatch: "initial-limited-cursor",
      phase: "initial",
      rooms: [{ roomId: ROOM, timeline: [event("$history")], limited: true }],
    });
    assert.equal(records.some((record) => record.event === "limited-matrix-timeline"), true);
    assert.equal(bridge.admitted.length, 0);
  });
});
