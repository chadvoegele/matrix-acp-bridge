import assert from "node:assert/strict";
import test from "node:test";

import { TextCollector } from "./text-collector.js";
import type { MatrixOutputPublication as AgentTextPublication } from "./conversation-publication.js";
import { renderOutput } from "./output-sink.js";
import { renderMatrixTextChunks } from "./matrix-text-rendering.js";
import { matrixHtmlEditContentBytes } from "./matrix-message-content.js";
import type { AgentTextSettings } from "./config.js";
import type { Clock } from "./clock.js";

import { ConversationPublication, type PublicationFailure } from "./conversation-publication.js";
import { matrixHtmlContentBytes, type MatrixOutputRouting } from "./matrix-message-content.js";
import { OUTPUT_TRUNCATION_MARKER } from "./response-rendering.js";
import { FakeClock } from "./test-support/fake-clock.js";

function createTextPublication(options: {
  settings: AgentTextSettings;
  maxOutputBytes: number;
  maxMatrixMessageBytes: number;
  queue: ConversationPublication;
  routing?: MatrixOutputRouting;
  clock?: Clock;
}) {
  const collector = new TextCollector({
    ...options,
    sink: renderOutput(
      options.queue.messages,
      (content) =>
        renderMatrixTextChunks(content.text, options.maxMatrixMessageBytes, (rendered) =>
          matrixHtmlEditContentBytes({ ...rendered, ...options.routing }),
        ),
      () => options.queue.fail("delivery"),
    ),
  });
  options.queue.onStop(() => collector.stop());
  return collector;
}

function createFixture(
  options: {
    maxOutputBytes?: number;
    maxMatrixMessageBytes?: number;
    capacity?: number;
    routing?: MatrixOutputRouting;
  } = {},
) {
  const clock = new FakeClock();
  const calls: AgentTextPublication[] = [];
  const failures: PublicationFailure[] = [];
  let send: () => Promise<string | undefined> = async () => `$event-${calls.length}`;
  const queue = new ConversationPublication({
    maximumPending: options.capacity ?? 4,
    maxMatrixMessageBytes: options.maxMatrixMessageBytes ?? 2048,
    ...(options.routing === undefined ? {} : { routing: options.routing }),
    onFailure: (reason) => failures.push(reason),
    publish: async (kind, publication) => {
      if (kind === "text") calls.push(publication);
      return send();
    },
  });
  const buffer = createTextPublication({
    settings: { agentTextFlushBytes: 256, agentTextQuietMs: 100, agentTextMaxIntervalMs: 250 },
    maxOutputBytes: options.maxOutputBytes ?? 16_384,
    maxMatrixMessageBytes: options.maxMatrixMessageBytes ?? 2048,
    queue,
    clock,
    ...(options.routing === undefined ? {} : { routing: options.routing }),
  });
  return {
    clock,
    calls,
    failures,
    queue,
    buffer,
    setSend: (value: typeof send) => {
      send = value;
    },
    blockTransport: async () => {
      const gate = createGate();
      send = async () => {
        await gate.promise;
        return "$blocker";
      };
      queue.cards.flush("blocker", [{ body: "blocking", formattedBody: "<p>blocking</p>" }]);
      await Promise.resolve();
      send = async () => `$event-${calls.length}`;
      return gate;
    },
  };
}

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

void test("quiet flush sends trailing text, later same-ID chunks edit, and unchanged blocks do nothing", async () => {
  const { buffer, clock, queue, calls } = createFixture();
  buffer.append("a", "hello");
  clock.advanceBy(99);
  assert.equal(calls.length, 0);
  clock.advanceBy(1);
  await queue.waitForIdle();
  assert.equal(calls[0]?.body, "hello");
  assert.equal(calls[0]?.targetEventId, undefined);
  clock.advanceBy(10_000);
  buffer.flush();
  await queue.waitForIdle();
  assert.equal(calls.length, 1);
  buffer.append("a", " world");
  clock.advanceBy(100);
  await queue.waitForIdle();
  assert.equal(calls[1]?.body, "hello world");
  assert.equal(calls[1]?.targetEventId, "$event-1");
  assert.equal(clock.pendingTimerCount, 0);
});

void test("size counts new UTF-8 bytes and repeated crossings are paced", async () => {
  const { buffer, clock, queue, calls } = createFixture({ maxMatrixMessageBytes: 16_384 });
  buffer.append("a", "é".repeat(128));
  await queue.waitForIdle();
  assert.equal(calls.length, 1);
  for (let index = 0; index < 10; index++) buffer.append("a", "x".repeat(256));
  await queue.waitForIdle();
  assert.equal(calls.length, 1);
  clock.advanceBy(100);
  await queue.waitForIdle();
  assert.equal(calls.length, 2);
  const firstFlushCalls = calls.length;
  buffer.append("a", "z");
  clock.advanceBy(99);
  await queue.waitForIdle();
  assert.equal(calls.length, firstFlushCalls);
  clock.advanceBy(1);
  await queue.waitForIdle();
  assert.ok(calls.length > firstFlushCalls);
});

void test("continuous small deltas flush at the maximum interval without quiet", async () => {
  const { buffer, clock, queue, calls } = createFixture();
  buffer.append("a", "0");
  for (let index = 1; index <= 3; index++) {
    clock.advanceBy(80);
    buffer.append("a", String(index));
  }
  clock.advanceBy(10);
  await queue.waitForIdle();
  assert.equal(calls[0]?.body, "0123");
  buffer.stop();
  assert.equal(clock.pendingTimerCount, 0);
});

void test("transitions and activity preserve order; activity does not retire the current identity", async () => {
  const { buffer, queue, calls } = createFixture();
  buffer.append("a", "before");
  buffer.flush();
  queue.cards.flush("tool", [{ body: "activity", formattedBody: "<p>activity</p>" }]);
  await queue.waitForIdle();
  buffer.append("a", " after tool");
  buffer.append("b", "next");
  buffer.flush();
  await queue.waitForIdle();
  assert.deepEqual(
    calls.map(({ id, body }) => [id, body]),
    [
      ["a", "before"],
      ["a", "before after tool"],
      ["b", "next"],
    ],
  );
  assert.equal(calls[1]?.targetEventId, "$event-1");
  assert.equal(calls[2]?.targetEventId, undefined);
});

void test("slow sends coalesce edits, including final text before an identity transition", async () => {
  const { buffer, queue, calls, blockTransport } = createFixture();
  const blocked = await blockTransport();
  buffer.append("a", "first");
  buffer.flush();
  buffer.append("a", " second");
  buffer.flush();
  assert.ok(queue.pendingCount <= 3);
  blocked.release();
  await queue.waitForIdle();
  assert.deepEqual(
    calls.map(({ body }) => body),
    ["first second"],
  );

  const sending = createGate();
  const started = createGate();
  const slowFixture = createFixture();
  const slowCalls = slowFixture.calls;
  const slow = slowFixture.buffer;
  slowFixture.setSend(async () => {
    if (slowCalls.length === 1) {
      started.release();
      await sending.promise;
    }
    return `$slow-${slowCalls.length}`;
  });
  slow.append("a", "one");
  slow.flush();
  await started.promise;
  slow.append("a", " two");
  slow.append("b", "three");
  slow.flush();
  sending.release();
  await slowFixture.queue.waitForIdle();
  assert.deepEqual(
    slowCalls.map(({ body }) => body),
    ["one", "one two", "three"],
  );
  assert.equal(slowCalls[1]?.targetEventId, "$slow-1");
  slow.stop();
});

void test("bounded pending work fails explicitly and cancels timers instead of retaining more identities", async () => {
  const { buffer, queue, clock, calls, failures, blockTransport } = createFixture({ capacity: 2 });
  const blocked = await blockTransport();
  buffer.append("a", "a");
  buffer.append("b", "b");
  buffer.append("c", "c");
  assert.equal(buffer.append("d", "d"), false);
  assert.deepEqual(failures, ["capacity"]);
  assert.equal(clock.pendingTimerCount, 0);
  blocked.release();
  await queue.waitForIdle();
  assert.equal(calls.length, 0);
  assert.equal(queue.pendingCount, 0);
});

void test("output remains bounded with an explicit marker and excess deltas produce no more work", async () => {
  const { buffer, queue, calls } = createFixture({ maxOutputBytes: 64 });
  buffer.append("a", "é".repeat(10_000));
  buffer.flush();
  await queue.waitForIdle();
  assert.ok(Buffer.byteLength(calls[0]!.body) <= 64);
  assert.ok(calls[0]!.body.endsWith(OUTPUT_TRUNCATION_MARKER));
  for (let index = 0; index < 100; index++) buffer.append("a", "x".repeat(10_000));
  buffer.flush();
  await queue.waitForIdle();
  assert.equal(calls.length, 1);
});

void test("safe Markdown is rerendered incrementally and continuation events reuse their mappings", async () => {
  const routing = { threadRootEventId: "$root", threadInReplyToEventId: "$reply" };
  const { buffer, queue, calls, failures } = createFixture({ maxMatrixMessageBytes: 1400, routing });
  buffer.append("a", "**hello <script>alert(1)</script> [link](java");
  buffer.flush();
  await queue.waitForIdle();
  buffer.append("a", "script:evil)**\n" + "é text ".repeat(200));
  buffer.flush();
  await queue.waitForIdle();
  const latest = new Map<number, AgentTextPublication>();
  for (const call of calls) {
    assert.doesNotMatch(call.formattedBody, /<script>|href="javascript:/u);
    assert.ok(matrixHtmlContentBytes({ ...call, ...routing }, call.targetEventId) <= 1400);
    latest.set(call.partIndex, call);
  }
  assert.ok(latest.size > 1);
  assert.equal(calls[1]?.targetEventId, "$event-1");
  assert.equal(
    [...latest.values()].map(({ body }) => body).join(""),
    "**hello <script>alert(1)</script> [link](javascript:evil)**\n" + "é text ".repeat(200),
  );
  assert.deepEqual(failures, []);
});

void test("reset invalidates queued callbacks and independent sessions keep identical IDs separate", async () => {
  const first = createFixture();
  const second = createFixture();
  const blocked = await first.blockTransport();
  first.buffer.append("same", "discard");
  first.buffer.flush();
  first.buffer.append("same", " timer");
  first.queue.stop();
  second.buffer.append("same", "deliver");
  second.clock.advanceBy(100);
  blocked.release();
  await Promise.all([first.queue.waitForIdle(), second.queue.waitForIdle()]);
  assert.equal(first.calls.length, 0);
  assert.equal(first.clock.pendingTimerCount, 0);
  assert.equal(second.calls[0]?.body, "deliver");
});

void test("unrecoverable publication is observable and clears subsequent queued work", async () => {
  const { buffer, queue, clock, failures, setSend } = createFixture();
  setSend(async (): Promise<undefined> => {});
  buffer.append("a", "failed");
  buffer.flush();
  buffer.append("a", "pending timer");
  await queue.waitForIdle();
  assert.deepEqual(failures, ["delivery"]);
  assert.equal(clock.pendingTimerCount, 0);
  assert.equal(buffer.append("a", "later"), false);
});

void test("retired identities leave no historical mapping and repeated deltas always append", async () => {
  const { buffer, queue, calls, clock } = createFixture();
  for (let index = 0; index < 100; index++) {
    buffer.append(String(index), "x");
    buffer.append(String(index), "x");
    buffer.flush();
    await queue.waitForIdle();
    assert.equal(queue.pendingCount, 0);
  }
  buffer.append("final", "new live text");
  buffer.flush();
  await queue.waitForIdle();
  assert.equal(calls.length, 101);
  assert.ok(calls.slice(0, 100).every((call) => call.body === "xx" && call.targetEventId === undefined));
  assert.equal(calls[100]?.targetEventId, undefined);
  assert.equal(calls[100]?.body, "new live text");
  assert.equal(clock.pendingTimerCount, 0);
});

void test("late truncation preserves bounded continuation text and reuses existing event mappings", async () => {
  const { buffer, queue, calls, failures } = createFixture({ maxOutputBytes: 1000, maxMatrixMessageBytes: 1000 });
  buffer.append("a", "é".repeat(500));
  buffer.flush();
  await queue.waitForIdle();
  const originalEvents = calls.length;
  buffer.append("a", "tail beyond limit");
  buffer.flush();
  await queue.waitForIdle();
  const latest = new Map<number, AgentTextPublication>();
  for (const call of calls) latest.set(call.partIndex, call);
  const source = [...latest.values()].map(({ body }) => body).join("");
  assert.ok(source.endsWith(OUTPUT_TRUNCATION_MARKER));
  assert.ok(Buffer.byteLength(source) <= 1000);
  assert.ok(
    calls
      .slice(originalEvents)
      .every((call) =>
        call.partIndex < originalEvents
          ? call.targetEventId === `$event-${call.partIndex + 1}`
          : call.targetEventId === undefined,
      ),
  );
  assert.deepEqual(failures, []);
});

void test("an event budget that cannot fit the edit envelope reports delivery failure without sending", async () => {
  const { buffer, queue, calls, failures, clock } = createFixture({ maxMatrixMessageBytes: 64 });
  buffer.append("a", "text");
  clock.advanceBy(100);
  await queue.waitForIdle();
  assert.deepEqual(failures, ["delivery"]);
  assert.equal(calls.length, 0);
  assert.equal(clock.pendingTimerCount, 0);
});

void test("a new identity with an empty delta flushes preceding text without sending a placeholder", async () => {
  const { buffer, queue, calls, clock } = createFixture();
  buffer.append("a", "preceding");
  buffer.append("b", "");
  await queue.waitForIdle();
  assert.deepEqual(
    calls.map(({ id, body }) => [id, body]),
    [["a", "preceding"]],
  );
  assert.equal(clock.pendingTimerCount, 0);
  buffer.append("b", "later");
  clock.advanceBy(100);
  await queue.waitForIdle();
  assert.equal(calls[1]?.id, "b");
  assert.equal(calls[1]?.body, "later");
  assert.equal(calls[1]?.targetEventId, undefined);
});
