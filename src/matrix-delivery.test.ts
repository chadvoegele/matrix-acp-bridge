import assert from "node:assert/strict";
import test from "node:test";
import { MatrixDelivery } from "./matrix-delivery.js";
import type { MatrixBridgeAdapter, MatrixHtmlMessage } from "./matrix-client.js";
import { matrixHtml } from "./matrix-html.js";
import { renderMatrixResponse } from "./response-rendering.js";
import { FakeClock } from "./test-support/fake-clock.js";

function createParts(roomId = "!room:example.org", body = "hello") {
  return renderMatrixResponse({
    roomId,
    inboundEventId: "$input",
    outcome: { kind: "turn", stopReason: "end_turn", text: body },
    maxOutputBytes: 1000,
    maxMatrixMessageBytes: 64,
  });
}

const noop = (): void => {};

function createAdapter(
  sendMessage: MatrixBridgeAdapter["sendMessage"],
  sendHtmlMessage?: MatrixBridgeAdapter["sendHtmlMessage"],
): MatrixBridgeAdapter {
  return {
    sendMessage,
    ...(sendHtmlMessage === undefined ? {} : { sendHtmlMessage }),
    onFatalError: () => noop,
    stopIntake: () => {},
    stop: async () => {},
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

void test("delivery serializes a whole multipart response with live edits while other rooms progress", async () => {
  let finishFirst!: () => void;
  const firstSend = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const sent: string[] = [];
  const parts = createParts(undefined, "a".repeat(130));
  assert.ok(parts.length > 1);
  const adapter = createAdapter(
    async (part) => {
      sent.push(`${part.roomId}:${part.partNumber}`);
      if (part === parts[0]) await firstSend;
    },
    async (message) => {
      sent.push(`live:${message.roomId}`);
      return "$live";
    },
  );
  const delivery = new MatrixDelivery({ matrix: adapter, canSend: () => true });
  const first = delivery.sendParts(parts[0]!.roomId, parts);
  const message: MatrixHtmlMessage = {
    roomId: parts[0]!.roomId,
    transactionId: "live",
    body: "tool",
    formattedBody: matrixHtml`<p>tool</p>`,
    targetEventId: "$old",
    threadRootEventId: "$root",
  };
  const live = delivery.sendLive(message);
  const other = delivery.sendParts("!other:example.org", createParts("!other:example.org"));
  await other;
  assert.deepEqual(sent, ["!room:example.org:1", "!other:example.org:1"]);
  finishFirst();
  assert.equal(await first, true);
  assert.equal(await live, "$live");
  assert.deepEqual(sent.slice(2), [
    ...parts.slice(1).map((part) => `${part.roomId}:${part.partNumber}`),
    "live:!room:example.org",
  ]);
});

void test("delivery retries stable payloads at server delay and resets backoff for the next part", async () => {
  const clock = new FakeClock();
  const parts = createParts(undefined, "x".repeat(130));
  const attempts: (typeof parts)[number][] = [];
  const delivery = new MatrixDelivery({
    clock,
    random: () => 1,
    canSend: () => true,
    matrix: createAdapter(async (part) => {
      attempts.push(part);
      if (attempts.length === 1) throw { status: 429, data: { retry_after_ms: 250 } };
      if (attempts.length === 3) throw { code: "ECONNRESET" };
    }),
  });
  const result = delivery.sendParts(parts[0]!.roomId, parts);
  await flush();
  clock.advanceBy(249);
  await flush();
  assert.equal(attempts.length, 1);
  clock.advanceBy(1);
  await flush();
  assert.equal(attempts.length, 3);
  clock.advanceBy(999);
  await flush();
  assert.equal(attempts.length, 3);
  clock.advanceBy(1);
  assert.equal(await result, true);
  assert.equal(attempts[0], attempts[1]);
  assert.equal(attempts[2], attempts[3]);
  assert.equal(clock.pendingTimerCount, 0);
});

void test("permanent delivery failure skips remaining parts and releases the room for later responses", async () => {
  const parts = createParts(undefined, "z".repeat(130));
  let attempts = 0;
  const delivery = new MatrixDelivery({
    canSend: () => true,
    matrix: createAdapter(async () => {
      attempts += 1;
      if (attempts === 1) throw { failure: { kind: "permanent", retryable: false } };
    }),
  });
  assert.equal(await delivery.sendParts(parts[0]!.roomId, parts), false);
  assert.equal(attempts, 1);
  assert.equal(await delivery.sendParts(parts[0]!.roomId, createParts()), true);
  assert.equal(attempts, 2);
});

void test("shutdown cancels retry timers, settles waiters and does not retry an active request", async () => {
  const clock = new FakeClock();
  let canSend = true;
  let attempts = 0;
  const delivery = new MatrixDelivery({
    clock,
    canSend: () => canSend,
    matrix: createAdapter(async () => {
      attempts += 1;
      throw { status: 503 };
    }),
  });
  const result = delivery.sendParts("!room:example.org", createParts());
  await flush();
  assert.equal(clock.pendingTimerCount, 1);
  canSend = false;
  delivery.cancelRetries();
  delivery.cancelRetries();
  assert.equal(await result, false);
  assert.equal(clock.pendingTimerCount, 0);
  assert.equal(await delivery.sendParts("!room:example.org", createParts()), false);
  assert.equal(attempts, 1);
});

void test("Retry-After dates use the delivery clock and live retry preserves the edit and thread payload", async () => {
  const clock = new FakeClock(Date.UTC(2020, 0, 1));
  const attempts: MatrixHtmlMessage[] = [];
  const message: MatrixHtmlMessage = {
    roomId: "!room:example.org",
    body: "tool",
    formattedBody: matrixHtml`<p>tool</p>`,
    transactionId: "stable",
    targetEventId: "$previous",
    threadRootEventId: "$root",
    threadInReplyToEventId: "$followup",
  };
  const delivery = new MatrixDelivery({
    clock,
    canSend: () => true,
    matrix: createAdapter(
      async () => {},
      async (payload) => {
        attempts.push(payload);
        if (attempts.length === 1)
          throw { status: 429, headers: new Headers({ "Retry-After": "Wed, 01 Jan 2020 00:00:02 GMT" }) };
        return "$result";
      },
    ),
  });
  const result = delivery.sendLive(message);
  await flush();
  clock.advanceBy(1999);
  await flush();
  assert.equal(attempts.length, 1);
  clock.advanceBy(1);
  assert.equal(await result, "$result");
  assert.deepEqual(attempts, [message, message]);
  assert.equal(clock.pendingTimerCount, 0);
});

void test("shutdown prevents queued responses and remaining parts from starting new sends", async () => {
  let canSend = true;
  let finish!: () => void;
  const active = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let attempts = 0;
  const delivery = new MatrixDelivery({
    canSend: () => canSend,
    matrix: createAdapter(async () => {
      attempts += 1;
      await active;
    }),
  });
  const parts = createParts(undefined, "a".repeat(130));
  const first = delivery.sendParts("!room:example.org", parts);
  const queued = delivery.sendParts("!room:example.org", createParts());
  await flush();
  canSend = false;
  finish();
  assert.equal(await first, false);
  assert.equal(await queued, false);
  assert.equal(attempts, 1);
});
