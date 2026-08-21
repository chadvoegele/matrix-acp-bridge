import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BridgeConfig } from "./config.js";
import { openBridgeStateStore } from "./bridge-state.js";
import type { DiagnosticSink } from "./diagnostics.js";
import type { InboundMatrixEvent, MatrixSyncBatch } from "./matrix-client.js";
import { MatrixSyncCoordinator } from "./sync-coordinator.js";

const ROOM = "!room:example.org";
const SENDER = "@alice:example.org";

const config: BridgeConfig = {
  stateDir: "/tmp/matrix-acp-coordinator",
  matrix: {
    homeserver: "https://matrix.example.org",
    userId: "@bridge:example.org",
    deviceId: "BRIDGEDEVICE",
    accessTokenFile: "/tmp/token",
    allowedRooms: [ROOM],
    allowedSenders: [SENDER],
    encryption: "disabled",
  },
  acp: { cwd: "/tmp" },
  limits: {
    maxInputBytes: 1000,
    maxOutputBytes: 10_000,
    maxMatrixMessageBytes: 10_000,
    maxQueuedTurnsPerRoom: 2,
    maxConcurrentPrompts: 1,
    maxTurnSeconds: 60,
    shutdownGraceSeconds: 1,
    startupTimeoutSeconds: 60,
    initialSyncTimelineLimit: 100,
    maxCatchupAgeSeconds: 10,
    maxCatchupEventsPerRoom: 2,
  },
};

function event(
  eventId: string,
  body = eventId,
  isLive = true,
  originServerTs: number | null = 1000,
): InboundMatrixEvent {
  return {
    roomId: ROOM,
    eventId,
    sender: SENDER,
    type: "m.room.message",
    content: { msgtype: "m.text", body },
    isLive,
    ...(originServerTs === null ? {} : { originServerTs }),
    isPlaintext: true,
    isDecrypted: true,
    isRedacted: false,
  };
}

function batch(phase: "initial" | "incremental", events: readonly InboundMatrixEvent[]): MatrixSyncBatch {
  return {
    phase,
    rooms: [{ roomId: ROOM, timeline: events, limited: false }],
  };
}

async function withStore(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-coordinator-"));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

function makeCoordinator(
  stateStore: Awaited<ReturnType<typeof openBridgeStateStore>>,
  received: InboundMatrixEvent[],
  options: {
    readonly config?: BridgeConfig;
    readonly now?: number;
    readonly diagnostics?: DiagnosticSink;
  } = {},
) {
  const bridge = {
    opened: false,
    enabled: false,
    openIntake() {
      this.opened = true;
    },
    enableDispatch() {
      this.enabled = true;
    },
    async handleTimelineEvent(input: InboundMatrixEvent, terminal: () => Promise<void>) {
      received.push(input);
      await terminal();
    },
  };
  const coordinator = new MatrixSyncCoordinator({
    config: options.config ?? config,
    bridge,
    stateStore,
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    clock: {
      now: () => options.now ?? 1000,
      setTimeout: () => null,
      clearTimeout: () => {},
    },
    onFatal: (error) => {
      throw new Error(`unexpected fatal ${error.code}`);
    },
  });
  return { coordinator, bridge };
}

void test("first initial sync establishes a durable baseline and suppresses history", async () => {
  await withStore(async (stateDir) => {
    const stateStore = await openBridgeStateStore({
      stateDir,
      identity: { homeserver: "https://matrix.example.org", userId: "@bridge:example.org", deviceId: "BRIDGEDEVICE" },
    });
    const received: InboundMatrixEvent[] = [];
    const { coordinator, bridge } = makeCoordinator(stateStore, received);
    await coordinator.handleBatch(batch("initial", [event("$history-one:example.org", "$history-one:example.org", true), event("$history-two:example.org", "$history-two:example.org", false)]));
    assert.deepEqual(received, []);
    assert.equal(bridge.opened, true);
    assert.equal(bridge.enabled, true);
    assert.equal(stateStore.getSnapshot().initialized, true);
    assert.deepEqual(stateStore.getSnapshot().completedEventIds, {
      [ROOM]: ["$history-one:example.org", "$history-two:example.org"],
    });
  });
});

void test("restart age policy terminally omits stale events and keeps fresh events in Matrix order", async () => {
  await withStore(async (stateDir) => {
    const identity = { homeserver: "https://matrix.example.org", userId: "@bridge:example.org", deviceId: "BRIDGEDEVICE" } as const;
    const firstStore = await openBridgeStateStore({ stateDir, identity });
    await firstStore.establishInitialBaseline([{ roomId: ROOM, eventIds: ["$already-done:example.org"] }]);
    const received: InboundMatrixEvent[] = [];
    const records: Array<{ readonly event: string; readonly fields: Readonly<Record<string, string | number | boolean | null>> }> = [];
    const { coordinator } = makeCoordinator(
      await openBridgeStateStore({ stateDir, identity }),
      received,
      {
        now: 2000,
        config: { ...config, limits: { ...config.limits, maxCatchupAgeSeconds: 1 } },
        diagnostics: {
          emit: (_level, eventName, fields = {}) => records.push({ event: eventName, fields }),
          debug() {},
          info() {},
          warn() {},
          error() {},
        },
      },
    );
    await coordinator.handleBatch(batch("initial", [
      event("$stale:example.org", "stale", false, 0),
      event("$fresh:example.org", "fresh", false, 1500),
    ]));
    await coordinator.flush();

    assert.deepEqual(received.map((input) => input.eventId), ["$fresh:example.org"]);
    assert.deepEqual((await openBridgeStateStore({ stateDir, identity })).getSnapshot().completedEventIds, {
      [ROOM]: ["$stale:example.org", "$fresh:example.org"],
    });
    const omission = records.find(({ event: eventName }) => eventName === "initial-sync-events-omitted");
    assert.deepEqual(omission?.fields, {
      omittedCount: 1,
      ageOmittedCount: 1,
      countOmittedCount: 0,
      reason: "age",
    });
    assert.equal(JSON.stringify(omission).includes("$stale:example.org"), false);
  });
});

void test("restart omits events without a finite origin timestamp", async () => {
  await withStore(async (stateDir) => {
    const identity = { homeserver: "https://matrix.example.org", userId: "@bridge:example.org", deviceId: "BRIDGEDEVICE" } as const;
    const firstStore = await openBridgeStateStore({ stateDir, identity });
    await firstStore.establishInitialBaseline([{ roomId: ROOM, eventIds: ["$old:example.org"] }]);
    const received: InboundMatrixEvent[] = [];
    const records: Array<{ readonly event: string; readonly fields: Readonly<Record<string, string | number | boolean | null>> }> = [];
    const { coordinator } = makeCoordinator(await openBridgeStateStore({ stateDir, identity }), received, {
      now: 2000,
      config: { ...config, limits: { ...config.limits, maxCatchupAgeSeconds: 1 } },
      diagnostics: {
        emit: (_level, eventName, fields = {}) => records.push({ event: eventName, fields }),
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
    });
    await coordinator.handleBatch(batch("initial", [
      event("$missing-timestamp:example.org", "missing", false, null),
      event("$non-finite-timestamp:example.org", "non-finite", false, Number.NaN),
      event("$fresh-with-timestamp:example.org", "fresh", false, 1500),
    ]));
    await coordinator.flush();

    assert.deepEqual(received.map((input) => input.eventId), ["$fresh-with-timestamp:example.org"]);
    assert.deepEqual((await openBridgeStateStore({ stateDir, identity })).getSnapshot().completedEventIds, {
      [ROOM]: [
        "$missing-timestamp:example.org",
        "$non-finite-timestamp:example.org",
        "$fresh-with-timestamp:example.org",
      ],
    });
    assert.deepEqual(records.find(({ event: eventName }) => eventName === "initial-sync-events-omitted")?.fields, {
      omittedCount: 2,
      ageOmittedCount: 2,
      countOmittedCount: 0,
      reason: "age",
    });
  });
});

void test("limited initial timelines remain bounded and diagnostics contain counts, not event IDs", async () => {
  await withStore(async (stateDir) => {
    const stateStore = await openBridgeStateStore({
      stateDir,
      identity: { homeserver: "https://matrix.example.org", userId: "@bridge:example.org", deviceId: "BRIDGEDEVICE" },
    });
    const received: InboundMatrixEvent[] = [];
    const records: Array<{ readonly event: string; readonly fields: Readonly<Record<string, string | number | boolean | null>> }> = [];
    const { coordinator } = makeCoordinator(stateStore, received, {
      diagnostics: {
        emit: (_level, eventName, fields = {}) => records.push({ event: eventName, fields }),
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
    });
    await coordinator.handleBatch({
      ...batch("initial", [event("$limited-history:example.org", "history", false)]),
      rooms: [{ roomId: ROOM, timeline: [event("$limited-history:example.org", "history", false)], limited: true }],
    });
    assert.deepEqual(received, []);
    assert.deepEqual(records.find(({ event: eventName }) => eventName === "limited-matrix-timeline")?.fields, {
      eventCount: 1,
    });
    assert.equal(JSON.stringify(records).includes("$limited-history:example.org"), false);
  });
});

void test("restart initial sync admits unseen events, suppresses completed IDs, and compacts the ledger", async () => {
  await withStore(async (stateDir) => {
    const identity = { homeserver: "https://matrix.example.org", userId: "@bridge:example.org", deviceId: "BRIDGEDEVICE" } as const;
    const firstStore = await openBridgeStateStore({ stateDir, identity });
    await firstStore.establishInitialBaseline([{
      roomId: ROOM,
      eventIds: ["$done:example.org", "$expired:example.org"],
    }]);
    const received: InboundMatrixEvent[] = [];
    const { coordinator } = makeCoordinator(await openBridgeStateStore({ stateDir, identity }), received);
    await coordinator.handleBatch(batch("initial", [
      event("$done:example.org"),
      event("$new:example.org"),
      event("$expired:example.org"),
    ]));
    await coordinator.flush();
    assert.deepEqual(received.map((input) => input.eventId), ["$new:example.org"]);
    assert.deepEqual((await openBridgeStateStore({ stateDir, identity })).getSnapshot().completedEventIds, {
      [ROOM]: ["$done:example.org", "$expired:example.org", "$new:example.org"],
    });
  });
});

void test("completed IDs survive restart compaction when authorization temporarily disallows their sender", async () => {
  await withStore(async (stateDir) => {
    const identity = { homeserver: "https://matrix.example.org", userId: "@bridge:example.org", deviceId: "BRIDGEDEVICE" } as const;
    const completedId = "$completed-while-allowed:example.org";
    const firstReceived: InboundMatrixEvent[] = [];
    const first = makeCoordinator(
      await openBridgeStateStore({ stateDir, identity }),
      firstReceived,
    ).coordinator;
    await first.handleBatch(batch("initial", []));
    await first.handleBatch(batch("incremental", [event(completedId)]));
    await first.flush();
    assert.deepEqual(firstReceived.map((input) => input.eventId), [completedId]);

    const disallowedReceived: InboundMatrixEvent[] = [];
    const disallowed = makeCoordinator(
      await openBridgeStateStore({ stateDir, identity }),
      disallowedReceived,
      { config: { ...config, matrix: { ...config.matrix, allowedSenders: [] } } },
    ).coordinator;
    await disallowed.handleBatch(batch("initial", [event(completedId, completedId, false)]));
    await disallowed.flush();
    assert.deepEqual(disallowedReceived, []);
    assert.deepEqual((await openBridgeStateStore({ stateDir, identity })).getSnapshot().completedEventIds, {
      [ROOM]: [completedId],
    });

    const allowedAgainReceived: InboundMatrixEvent[] = [];
    const allowedAgain = makeCoordinator(
      await openBridgeStateStore({ stateDir, identity }),
      allowedAgainReceived,
    ).coordinator;
    await allowedAgain.handleBatch(batch("initial", [event(completedId, completedId, false)]));
    await allowedAgain.flush();
    assert.deepEqual(allowedAgainReceived, []);
    assert.deepEqual((await openBridgeStateStore({ stateDir, identity })).getSnapshot().completedEventIds, {
      [ROOM]: [completedId],
    });
  });
});

void test("terminal encrypted IDs survive fresh and initialized recovery without retaining content", async () => {
  await withStore(async (stateDir) => {
    const identity = { homeserver: "https://matrix.example.org", userId: "@bridge:example.org", deviceId: "BRIDGEDEVICE" } as const;
    const terminalId = "$encrypted-pending:example.org";
    const firstCoordinatorReceived: InboundMatrixEvent[] = [];
    const firstCoordinator = makeCoordinator(
      await openBridgeStateStore({ stateDir, identity }),
      firstCoordinatorReceived,
    ).coordinator;
    await firstCoordinator.handleBatch({
      phase: "initial",
      rooms: [{ roomId: ROOM, timeline: [], terminalEventIds: [terminalId], limited: false }],
    });
    assert.deepEqual(firstCoordinatorReceived, []);
    assert.deepEqual((await openBridgeStateStore({ stateDir, identity })).getSnapshot().completedEventIds, {
      [ROOM]: [terminalId],
    });

    const secondTerminalId = "$encrypted-pending-next:example.org";
    const secondCoordinator = makeCoordinator(
      await openBridgeStateStore({ stateDir, identity }),
      [],
    ).coordinator;
    await secondCoordinator.handleBatch({
      phase: "initial",
      rooms: [{ roomId: ROOM, timeline: [], terminalEventIds: [secondTerminalId], limited: false }],
    });
    const state = await openBridgeStateStore({ stateDir, identity });
    assert.deepEqual(state.getSnapshot().completedEventIds, { [ROOM]: [secondTerminalId] });
    const raw = await readFile(state.statePath, "utf8");
    assert.equal(raw.includes("ciphertext"), false);
    assert.equal(raw.includes("decrypted body"), false);

    const restartedReceived: InboundMatrixEvent[] = [];
    const restarted = makeCoordinator(
      await openBridgeStateStore({ stateDir, identity }),
      restartedReceived,
    ).coordinator;
    await restarted.handleBatch(batch("initial", [event(secondTerminalId, "decrypted body", false, 1000)]));
    await restarted.flush();
    assert.deepEqual(restartedReceived, []);
  });
});

void test("incremental terminal completion is durable before the next response boundary", async () => {
  await withStore(async (stateDir) => {
    const identity = { homeserver: "https://matrix.example.org", userId: "@bridge:example.org", deviceId: "BRIDGEDEVICE" } as const;
    const stateStore = await openBridgeStateStore({ stateDir, identity });
    await stateStore.establishInitialBaseline([]);
    const received: InboundMatrixEvent[] = [];
    const { coordinator } = makeCoordinator(stateStore, received);
    await coordinator.handleBatch(batch("incremental", [event("$live:example.org")]));
    await coordinator.flush();
    assert.deepEqual(received.map((input) => input.eventId), ["$live:example.org"]);
    assert.equal(stateStore.isEventCompleted(ROOM, "$live:example.org"), true);
  });
});
