import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BridgeConfig } from "./config.js";
import { openBridgeStateStore } from "./bridge-state.js";
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

function event(eventId: string, body = eventId, isLive = true): InboundMatrixEvent {
  return {
    roomId: ROOM,
    eventId,
    sender: SENDER,
    type: "m.room.message",
    content: { msgtype: "m.text", body },
    isLive,
    isPlaintext: true,
    isDecrypted: true,
    isRedacted: false,
  };
}

function batch(phase: "initial" | "incremental", events: readonly InboundMatrixEvent[]): MatrixSyncBatch {
  return {
    nextBatch: `next-${phase}`,
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
    config,
    bridge,
    stateStore,
    clock: {
      now: () => 1000,
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
    await coordinator.handleBatch(batch("initial", [event("$history-one:example.org", "$history-one:example.org", false), event("$history-two:example.org", "$history-two:example.org", false)]));
    assert.deepEqual(received, []);
    assert.equal(bridge.opened, true);
    assert.equal(bridge.enabled, true);
    assert.equal(stateStore.getSnapshot().initialized, true);
    assert.deepEqual(stateStore.getSnapshot().completedEventIds, {
      [ROOM]: ["$history-one:example.org", "$history-two:example.org"],
    });
  });
});

void test("restart initial sync admits unseen events, suppresses completed IDs, and compacts the ledger", async () => {
  await withStore(async (stateDir) => {
    const identity = { homeserver: "https://matrix.example.org", userId: "@bridge:example.org", deviceId: "BRIDGEDEVICE" } as const;
    const firstStore = await openBridgeStateStore({ stateDir, identity });
    await firstStore.establishInitialBaseline({ [ROOM]: ["$done:example.org", "$expired:example.org"] });
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
