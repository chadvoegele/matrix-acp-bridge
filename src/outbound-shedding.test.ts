import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationPublication,
  OUTPUT_CAPACITY_NOTICE,
  type MatrixOutputPublication,
} from "./conversation-publication.js";
import { MatrixDelivery } from "./matrix-delivery.js";
import type { MatrixBridgeAdapter, MatrixHtmlMessage } from "./matrix-client.js";
import { matrixHtml, type MatrixSafeHtml } from "./matrix-html.js";
import { FakeClock } from "./test-support/fake-clock.js";

const noop = (): void => {};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const part = (body: string) => ({ body, formattedBody: matrixHtml`<p>${body}</p>` });

function fixture(maximumPending = 26) {
  const blocked = gate();
  const clock = new FakeClock();
  const calls: MatrixOutputPublication[] = [];
  const diagnostics: unknown[] = [];
  const queue = new ConversationPublication({
    maximumPending,
    maxMatrixMessageBytes: 4096,
    clock,
    onFailure: () => assert.fail("unexpected delivery failure"),
    onCapacity: (...fields) => diagnostics.push(fields),
    publish: async (_, publication) => {
      calls.push(publication);
      if (calls.length === 1) await blocked.promise;
      return `$event-${calls.length}`;
    },
  });
  return { queue, blocked, calls, diagnostics, clock };
}

void test("default 26 pending plus one in flight shed mixed output with bounded state and recover", async () => {
  const f = fixture();
  f.queue.messages.flush("active", [part("active")]);
  await Promise.resolve();
  f.queue.messages.finish("active");
  for (let index = 0; index < 26; index++) {
    const sink = index % 2 === 0 ? f.queue.messages : f.queue.cards;
    sink.flush(`pending-${index}`, [part("accepted")]);
    sink.finish(`pending-${index}`);
  }
  for (let index = 0; index < 10_000; index++) {
    const sink = index % 2 === 0 ? f.queue.messages : f.queue.cards;
    sink.flush(`dropped-${index}`, [part("private output")]);
    sink.finish(`dropped-${index}`);
    assert.equal(f.queue.pendingCount, 27);
    assert.equal(f.queue.liveCount, 27);
  }
  assert.equal(f.clock.pendingTimerCount, 0);
  assert.deepEqual(f.diagnostics, [["dropping", 1, 26]]);
  f.blocked.release();
  await f.queue.waitForIdle();
  assert.equal(f.calls.length, 28);
  assert.equal(f.calls.at(-1)?.body, OUTPUT_CAPACITY_NOTICE);
  assert.deepEqual(f.diagnostics.at(-1), ["recovered", 10_000, 26]);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /private|pending-|dropped-/u);
  assert.equal(f.queue.liveCount, 0);
  f.queue.messages.flush("fresh", [part("fresh")]);
  f.queue.messages.finish("fresh");
  await f.queue.waitForIdle();
  assert.equal(f.calls.at(-1)?.body, "fresh");
  assert.equal(f.queue.stopped, false);
  assert.equal(f.queue.liveCount, 0);
});

void test("dropped original can resume as a new event, while dropped updates keep existing continuation mappings", async () => {
  const f = fixture(1);
  f.queue.messages.flush("active", [part("initial")]);
  await Promise.resolve();
  f.queue.cards.flush("pending", [part("expanded")]);
  f.queue.cards.flush("pending", [part("dropped collapse")]);
  f.queue.cards.finish("pending");
  f.queue.messages.flush("active", [part("dropped update"), part("dropped continuation")]);
  f.queue.messages.flush("missing", [part("dropped original")]);
  f.queue.messages.finish("missing");
  assert.equal(f.queue.liveCount, 2);
  f.blocked.release();
  await f.queue.waitForIdle();
  assert.deepEqual(
    f.calls.map((call) => call.body),
    ["initial", "expanded", OUTPUT_CAPACITY_NOTICE],
  );
  f.queue.messages.flush("missing", [part("new original"), part("new continuation")]);
  f.queue.messages.finish("missing");
  await f.queue.waitForIdle();
  assert.equal(f.calls.at(-2)?.targetEventId, undefined);
  assert.equal(f.calls.at(-1)?.targetEventId, undefined);
  f.queue.messages.flush("active", [part("accepted update"), part("accepted continuation")]);
  f.queue.messages.finish("active");
  await f.queue.waitForIdle();
  assert.equal(f.calls.at(-2)?.targetEventId, "$event-1");
  assert.equal(f.calls.at(-1)?.targetEventId, undefined);
  assert.equal(f.queue.liveCount, 0);
});

void test("coalescing and finish work at capacity without losing the accepted final snapshot", async () => {
  const f = fixture(1);
  f.queue.messages.flush("active", [part("active")]);
  await Promise.resolve();
  f.queue.messages.flush("pending", [part("obsolete")]);
  for (let index = 0; index < 1000; index++) f.queue.messages.flush("pending", [part("final")]);
  f.queue.messages.finish("active");
  f.queue.messages.finish("pending");
  f.blocked.release();
  await f.queue.waitForIdle();
  assert.deepEqual(
    f.calls.map((call) => call.body),
    ["active", "final"],
  );
  assert.equal(f.queue.liveCount, 0);
  assert.deepEqual(f.diagnostics, []);
});

void test("notices and diagnostics coalesce for 30 seconds after drain without timers or historical IDs", async () => {
  const f = fixture();
  f.blocked.release();
  f.queue.shed();
  await f.queue.waitForIdle();
  for (let index = 0; index < 1000; index++) {
    f.queue.shed();
    await f.queue.waitForIdle();
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.diagnostics.length, 2);
  assert.equal(f.clock.pendingTimerCount, 0);
  f.clock.advanceBy(30_000);
  f.queue.shed();
  await f.queue.waitForIdle();
  assert.equal(f.calls.length, 2);
  assert.equal(f.diagnostics.length, 4);
  f.queue.stop();
  f.queue.shed();
  await f.queue.waitForIdle();
  assert.equal(f.calls.length, 2);
});

void test("shutdown discards the waiting notice and late send results without retaining live state", async () => {
  const f = fixture(1);
  f.queue.messages.flush("active", [part("active")]);
  await Promise.resolve();
  f.queue.messages.flush("pending", [part("pending")]);
  f.queue.messages.flush("drop", [part("drop")]);
  f.queue.stop();
  f.blocked.release();
  await f.queue.waitForIdle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.queue.liveCount, 0);
  assert.equal(f.queue.pendingCount, 0);
  assert.equal(f.clock.pendingTimerCount, 0);
});

void test("two threads in one room serialize notices normally while another conversation progresses", async () => {
  const blocked = gate();
  const started = gate();
  const calls: MatrixHtmlMessage[] = [];
  let activeInSharedRoom = 0;
  const matrix: MatrixBridgeAdapter = {
    sendMessage: async () => {},
    stopIntake: () => {},
    stop: async () => {},
    onFatalError: () => noop,
    sendHtmlMessage: async (message) => {
      calls.push(message);
      if (message.roomId === "!shared") {
        assert.equal(activeInSharedRoom++, 0);
        if (calls.length === 1) {
          started.release();
          await blocked.promise;
        }
        activeInSharedRoom--;
      }
      return `$event-${calls.length}`;
    },
  };
  const delivery = new MatrixDelivery({ matrix, canSend: () => true });
  const makeQueue = (threadRootEventId: string, roomId = "!shared") =>
    new ConversationPublication({
      maximumPending: 1,
      maxMatrixMessageBytes: 4096,
      routing: { threadRootEventId },
      onFailure: () => assert.fail("unexpected delivery failure"),
      publish: (_, publication) =>
        delivery.sendLive({
          ...publication,
          formattedBody: publication.formattedBody as MatrixSafeHtml,
          threadRootEventId,
          roomId,
          transactionId: `${threadRootEventId}-${calls.length}`,
        }),
    });
  const a = makeQueue("$a");
  const b = makeQueue("$b");
  const other = makeQueue("$other", "!other");
  a.messages.flush("first", [part("a-first")]);
  await started.promise;
  b.messages.flush("first", [part("b-first")]);
  await Promise.resolve();
  for (const queue of [a, b]) {
    queue.messages.flush("pending", [part("pending")]);
    queue.messages.flush("dropped", [part("dropped")]);
    queue.messages.finish("first");
    queue.messages.finish("pending");
  }
  other.messages.flush("fresh", [part("unrelated")]);
  other.messages.finish("fresh");
  await other.waitForIdle();
  assert.ok(calls.some((call) => call.body === "unrelated"));
  assert.equal(calls.filter((call) => call.body === OUTPUT_CAPACITY_NOTICE).length, 0);
  blocked.release();
  await Promise.all([a.waitForIdle(), b.waitForIdle()]);
  assert.deepEqual(
    calls
      .filter((call) => call.body === OUTPUT_CAPACITY_NOTICE)
      .map((call) => call.threadRootEventId)
      .sort(),
    ["$a", "$b"],
  );
  for (const queue of [a, b, other]) assert.equal(queue.liveCount, 0);
});
