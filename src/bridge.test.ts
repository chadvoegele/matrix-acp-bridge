import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createInboundAuthorizer } from "./authorization.js";
import { InMemorySessionStore } from "./session-store.js";
import { BridgeCoordinator } from "./bridge.js";
import { matrixHtmlContent, matrixHtmlContentBytes } from "./matrix-message-content.js";
import { openBridgeStateStore } from "./bridge-state.js";
import type { BridgeConfig } from "./config.js";
import type { CancellationSignal, Unsubscribe } from "./cancellation.js";
import type { DiagnosticSink, FatalError, FatalErrorListener } from "./diagnostics.js";
import { FakeClock } from "./test-support/fake-clock.js";
import type {
  AcpClient,
  AcpOutcome,
  AcpSession,
  AcpSessionOptions,
  AcpSessionLoadOptions,
  AcpUpdate,
} from "./acp-client.js";
import type {
  InboundMatrixEvent,
  MatrixClientAdapter,
  MatrixIdentity,
  MatrixSyncBatch,
  MatrixSyncStateChange,
  MatrixHtmlMessage,
} from "./matrix-client.js";
import type { RenderedMatrixPart } from "./response-rendering.js";

const ROOM_ONE = "!one:example.org";
const ROOM_TWO = "!two:example.org";
const SENDER = "@alice:example.org";

function config(overrides: Partial<BridgeConfig["limits"]> = {}): BridgeConfig {
  return {
    stateDir: "/tmp/matrix-acp-bridge-test",
    matrix: {
      homeserver: "https://matrix.example.org",
      userId: "@bridge:example.org",
      deviceId: "BRIDGE",
      accessTokenFile: "/tmp/token",
      allowedRooms: [ROOM_ONE, ROOM_TWO],
      allowedSenders: [SENDER],
      encryption: "disabled",
      responseMode: "room",
    },
    acp: { cwd: "/tmp" },
    limits: {
      maxInputBytes: 1000,
      maxOutputBytes: 10_000,
      maxMatrixMessageBytes: 10_000,
      maxActivityEventsPerMessage: 10,
      maxQueuedTurnsPerRoom: 1,
      maxQueuedTurnsPerThread: 16,
      maxConcurrentPrompts: 2,
      maxTurnSeconds: 60,
      shutdownGraceSeconds: 1,
      startupTimeoutSeconds: 60,
      initialSyncTimelineLimit: 100,
      maxCatchupAgeSeconds: 900,
      maxCatchupEventsPerRoom: 4,
      ...overrides,
    },
  };
}

function event(eventId: string | undefined, roomId = ROOM_ONE, body = "hello", sender = SENDER): InboundMatrixEvent {
  return {
    roomId,
    sender,
    type: "m.room.message",
    content: { msgtype: "m.text", body },
    isLive: true,
    isRedacted: false,
    isPlaintext: true,
    isEncrypted: false,
    isDecrypted: true,
    ...(eventId === undefined ? {} : { eventId }),
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (condition()) {
      return;
    }
    await flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(condition(), true, "condition did not become true");
}

class FakeMatrix implements MatrixClientAdapter {
  readonly sent: RenderedMatrixPart[] = [];

  readonly fatal = new Set<FatalErrorListener>();

  readonly syncState = new Set<(change: MatrixSyncStateChange) => void>();

  readonly syncBatch = new Set<(batch: MatrixSyncBatch) => void | Promise<void>>();

  readonly typing: Array<{
    roomId: string;
    isTyping: boolean;
    timeoutMs: number;
  }> = [];

  readonly receipts: Array<{ roomId: string; eventId: string }> = [];

  readonly operationOrder: string[] = [];

  intakeStopped = false;

  stopped = false;

  send: (part: RenderedMatrixPart) => Promise<void> = async (part) => {
    this.sent.push(part);
  };

  whoAmI(): Promise<MatrixIdentity> {
    return Promise.resolve({
      userId: "@bridge:example.org",
      deviceId: "BRIDGE",
    });
  }

  onFatalError(listener: FatalErrorListener): Unsubscribe {
    this.fatal.add(listener);
    return () => this.fatal.delete(listener);
  }

  onSyncState(listener: (change: MatrixSyncStateChange) => void): Unsubscribe {
    this.syncState.add(listener);
    return () => this.syncState.delete(listener);
  }

  onSyncBatch(listener: (batch: MatrixSyncBatch) => void | Promise<void>): Unsubscribe {
    this.syncBatch.add(listener);
    return () => this.syncBatch.delete(listener);
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  stopIntake(): void {
    this.intakeStopped = true;
  }

  sendMessage(part: RenderedMatrixPart): Promise<void> {
    this.operationOrder.push(`message:${part.responseKind}`);
    return this.send(part);
  }

  async sendTyping(roomId: string, isTyping: boolean, timeoutMs: number): Promise<void> {
    this.typing.push({ roomId, isTyping, timeoutMs });
    this.operationOrder.push(`typing:${isTyping ? "on" : "off"}`);
  }

  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    this.receipts.push({ roomId, eventId });
    this.operationOrder.push(`receipt:${eventId}`);
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
}

class FakeLiveMatrix extends FakeMatrix {
  readonly html: MatrixHtmlMessage[] = [];

  readonly attempts: MatrixHtmlMessage[] = [];

  htmlSend: (message: MatrixHtmlMessage) => Promise<string> = async (message) => {
    this.html.push(message);
    return message.targetEventId ?? `$live-${this.html.length}:example.org`;
  };

  sendHtmlMessage(message: MatrixHtmlMessage): Promise<string> {
    this.attempts.push(message);
    return this.htmlSend(message);
  }
}

class FakeAcp implements AcpClient {
  readonly promptCalls: Array<{ sessionId: string; text: string }> = [];

  readonly cancelCalls: string[] = [];

  readonly updates = new Set<(update: AcpUpdate) => void>();

  readonly fatal = new Set<FatalErrorListener>();

  sessionCount = 0;

  readonly loadCalls: string[] = [];

  readonly loadOptions: AcpSessionLoadOptions[] = [];

  loadSessionImpl: (options: AcpSessionLoadOptions) => Promise<AcpSession> = async (options) => ({
    sessionId: options.sessionId,
  });

  promptImpl: (sessionId: string, text: string, cancellation: CancellationSignal) => Promise<AcpOutcome> =
    async () => ({
      kind: "turn",
      stopReason: "end_turn",
    });

  closed = false;

  initialize(): Promise<{ protocolVersion: 1 }> {
    return Promise.resolve({ protocolVersion: 1 });
  }

  createSession(_options: AcpSessionOptions): Promise<AcpSession> {
    this.sessionCount += 1;
    return Promise.resolve({ sessionId: `session-${this.sessionCount}` });
  }

  loadSession(options: AcpSessionLoadOptions): Promise<AcpSession> {
    this.loadCalls.push(options.sessionId);
    this.loadOptions.push(options);
    return this.loadSessionImpl(options);
  }

  prompt(sessionId: string, text: string, cancellation: CancellationSignal): Promise<AcpOutcome> {
    this.promptCalls.push({ sessionId, text });
    return this.promptImpl(sessionId, text, cancellation);
  }

  cancel(sessionId: string): Promise<void> {
    this.cancelCalls.push(sessionId);
    return Promise.resolve();
  }

  onUpdate(listener: (update: AcpUpdate) => void): Unsubscribe {
    this.updates.add(listener);
    return () => this.updates.delete(listener);
  }

  onFatalError(listener: FatalErrorListener): Unsubscribe {
    this.fatal.add(listener);
    return () => this.fatal.delete(listener);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  emit(update: AcpUpdate): void {
    for (const listener of this.updates) {
      listener(update);
    }
  }

  emitFatal(error: FatalError): void {
    for (const listener of this.fatal) {
      listener(error);
    }
  }
}

void test("records valid IDs before policy, silently ignores missing IDs, and evicts FIFO", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  acp.promptImpl = async () => ({
    kind: "turn",
    stopReason: "end_turn",
    text: "reinserted",
  });
  const bridge = new BridgeCoordinator({
    config: config({ maxConcurrentPrompts: 1 }),
    acp,
    matrix,
    clock,
  });

  // eslint-disable-next-line unicorn/no-useless-undefined -- omitted event IDs are explicit test input
  await bridge.handleTimelineEvent(event(undefined));
  await bridge.handleTimelineEvent(event("$duplicate:example.org", "!not-allowed:example.org"));
  await bridge.handleTimelineEvent(event("$duplicate:example.org"));
  assert.equal(bridge.deduplicatedEventCount, 1);
  assert.equal(acp.promptCalls.length, 0);

  for (let index = 0; index < 10_000; index += 1) {
    await bridge.handleTimelineEvent(event(`$event-${index}:example.org`, "!not-allowed:example.org"));
  }
  assert.equal(bridge.deduplicatedEventCount, 10_000);
  const reinserted = bridge.handleTimelineEvent(event("$duplicate:example.org"));
  await flush();
  await flush();
  clock.advanceBy(300);
  await reinserted;
  assert.equal(bridge.deduplicatedEventCount, 10_000);
  assert.equal(acp.promptCalls.length, 1);
  await bridge.stop();
});

void test("buffers startup events within active-plus-waiting capacity and recovers after a nonfatal error", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  const promptResults: Array<(outcome: AcpOutcome) => void> = [];
  acp.promptImpl = () => new Promise<AcpOutcome>((resolve) => promptResults.push(resolve));
  const bridge = new BridgeCoordinator({
    config: config({ maxQueuedTurnsPerRoom: 1 }),
    acp,
    matrix,
    clock,
    dispatchOpen: false,
  });

  const first = bridge.handleTimelineEvent(event("$one:example.org", ROOM_ONE, "one"));
  const second = bridge.handleTimelineEvent(event("$two:example.org", ROOM_ONE, "two"));
  const busy = bridge.handleTimelineEvent(event("$three:example.org", ROOM_ONE, "three"));
  await flush();
  assert.equal(acp.promptCalls.length, 0);
  assert.equal(bridge.getQueueDepth(ROOM_ONE), 1);
  assert.equal(matrix.sent[0]?.content.body, "The room queue is full. Try again later.");
  await busy;

  bridge.enableDispatch();
  await flush();
  assert.equal(acp.promptCalls.length, 1);
  promptResults.shift()!({
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  await flush();
  assert.equal(acp.promptCalls.length, 2);
  promptResults.shift()!({ kind: "turn", stopReason: "end_turn", text: "two" });
  await flush();
  clock.advanceBy(300);
  await Promise.all([first, second]);
  assert.equal(
    matrix.sent.some((part) => part.content.body === "[agent error]"),
    true,
  );
  assert.equal(
    matrix.sent.some((part) => part.content.body === "two"),
    true,
  );
  await bridge.stop();
});

void test("keeps room sessions isolated and releases the prompt permit before drain", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  const resolvers: Array<(outcome: AcpOutcome) => void> = [];
  acp.promptImpl = () => new Promise<AcpOutcome>((resolve) => resolvers.push(resolve));
  const bridge = new BridgeCoordinator({
    config: config({ maxConcurrentPrompts: 1 }),
    acp,
    matrix,
    clock,
  });

  const first = bridge.handleTimelineEvent(event("$one:example.org", ROOM_ONE, "room one"));
  const second = bridge.handleTimelineEvent(event("$two:example.org", ROOM_TWO, "room two"));
  await flush();
  assert.equal(acp.promptCalls.length, 1);
  assert.equal(acp.promptCalls[0]?.text, "room one");

  resolvers.shift()!({
    kind: "turn",
    stopReason: "end_turn",
    text: "answer one",
  });
  await flush();
  assert.equal(acp.promptCalls.length, 2);
  assert.equal(acp.promptCalls[1]?.text, "room two");
  assert.notEqual(acp.promptCalls[0]?.sessionId, acp.promptCalls[1]?.sessionId);
  resolvers.shift()!({
    kind: "turn",
    stopReason: "end_turn",
    text: "answer two",
  });
  await flush();
  clock.advanceBy(300);
  await Promise.all([first, second]);
  assert.deepEqual(matrix.sent.map((part) => part.content.body).sort(), ["answer one", "answer two"]);
  await bridge.stop();
});

void test("correlates message IDs, drains trailing output, and ignores stale chunks", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  let resolvePrompt!: (outcome: AcpOutcome) => void;
  acp.promptImpl = () =>
    new Promise<AcpOutcome>((resolve) => {
      resolvePrompt = resolve;
    });
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    clock,
  });

  const completion = bridge.handleTimelineEvent(event("$turn:example.org"));
  await flush();
  const sessionId = acp.promptCalls[0]?.sessionId;
  assert.ok(sessionId);
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "message-a",
    text: "one",
  });
  resolvePrompt({ kind: "turn", stopReason: "end_turn" });
  await flush();
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "message-b",
    text: "two",
  });
  clock.advanceBy(300);
  await completion;
  assert.equal(matrix.sent[0]?.content.body, "one\n\ntwo");

  let secondResolve!: (outcome: AcpOutcome) => void;
  acp.promptImpl = () =>
    new Promise<AcpOutcome>((resolve) => {
      secondResolve = resolve;
    });
  const second = bridge.handleTimelineEvent(event("$turn-two:example.org"));
  await flush();
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "message-a",
    text: "stale",
  });
  secondResolve({ kind: "turn", stopReason: "end_turn", text: "fresh" });
  await flush();
  clock.advanceBy(300);
  await second;
  assert.equal(matrix.sent.at(-1)?.content.body, "fresh");
  await bridge.stop();
});

void test("turn deadlines cancel once and render a timeout without waiting for the normal drain", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  let resolvePrompt!: (outcome: AcpOutcome) => void;
  acp.promptImpl = () =>
    new Promise<AcpOutcome>((resolve) => {
      resolvePrompt = resolve;
    });
  const bridge = new BridgeCoordinator({
    config: config({ maxTurnSeconds: 1 }),
    acp,
    matrix,
    clock,
  });

  const completion = bridge.handleTimelineEvent(event("$timeout:example.org"));
  await flush();
  await flush();
  clock.advanceBy(1000);
  assert.equal(acp.cancelCalls.length, 1);
  resolvePrompt({ kind: "turn", stopReason: "cancelled", text: "partial" });
  await flush();
  await completion;
  assert.equal(matrix.sent[0]?.responseKind, "timeout");
  assert.equal(matrix.sent[0]?.content.body, "partial\n\n[agent timed out]");
  await bridge.stop();
});

void test("session creation failure sends one generic response before fatal shutdown", async () => {
  const acp = new FakeAcp();
  acp.createSession = async () => {
    throw { kind: "method_error", operation: "session_new", fatal: false };
  };
  const matrix = new FakeMatrix();
  const bridge = new BridgeCoordinator({ config: config(), acp, matrix });
  const fatal: FatalError[] = [];
  bridge.onFatalError((error) => fatal.push(error));

  await bridge.handleTimelineEvent(event("$session-failure:example.org"));
  assert.equal(matrix.sent[0]?.content.body, "[agent error]");
  assert.equal(fatal.length, 1);
  assert.equal(bridge.stopping, true);
  await bridge.stop();
});

void test("fatal drain-cap output never gets attributed to a Matrix response", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  let resolvePrompt!: (outcome: AcpOutcome) => void;
  acp.promptImpl = () =>
    new Promise<AcpOutcome>((resolve) => {
      resolvePrompt = resolve;
    });
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    clock,
  });
  const fatal: FatalError[] = [];
  bridge.onFatalError((error) => fatal.push(error));

  const completion = bridge.handleTimelineEvent(event("$drain-cap:example.org"));
  await flush();
  const sessionId = acp.promptCalls[0]?.sessionId;
  assert.ok(sessionId);
  resolvePrompt({ kind: "turn", stopReason: "end_turn" });
  await flush();
  clock.advanceBy(29_900);
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "changing",
    text: "first",
  });
  clock.advanceBy(100);
  await completion;
  assert.equal(fatal[0]?.code, "acp_protocol");
  assert.equal(matrix.sent.length, 0);
  await bridge.stop();
});

void test("retries transient Matrix failures with stable transaction IDs and never retries ACP", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  let attempts = 0;
  const attemptedTransactionIds: string[] = [];
  matrix.send = async (part) => {
    attempts += 1;
    attemptedTransactionIds.push(part.transactionId);
    if (attempts === 1) {
      throw {
        failure: { kind: "transient", retryable: true, sdkRetryable: false },
      };
    }
    matrix.sent.push(part);
  };
  acp.promptImpl = async () => ({
    kind: "turn",
    stopReason: "end_turn",
    text: "answer",
  });
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    clock,
    random: () => 0,
  });

  const completion = bridge.handleTimelineEvent(event("$retry:example.org"));
  await flush();
  await flush();
  clock.advanceBy(300);
  await flush();
  clock.advanceBy(0);
  await flush();
  await completion;
  assert.equal(acp.promptCalls.length, 1);
  assert.equal(attempts, 2);
  assert.equal(matrix.sent[0]?.transactionId.startsWith("mab1_"), true);
  assert.deepEqual(new Set(attemptedTransactionIds).size, 1);
  await bridge.stop();
});

void test("typing spans only an active turn and receipts acknowledge authorized dispositions", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  acp.promptImpl = async () => ({
    kind: "turn",
    stopReason: "end_turn",
    text: "answer",
  });
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    clock,
  });

  const completion = bridge.handleTimelineEvent(event("$typing:example.org"));
  await flush();
  assert.deepEqual(matrix.typing[0], {
    roomId: ROOM_ONE,
    isTyping: true,
    timeoutMs: 30_000,
  });
  clock.advanceBy(300);
  await completion;
  assert.equal(matrix.typing.at(-1)?.isTyping, false);
  assert.deepEqual(matrix.receipts, [{ roomId: ROOM_ONE, eventId: "$typing:example.org" }]);
  await bridge.stop();
});

void test("typing refreshes every 10 seconds through output drain and stops before delivery", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  let finishPrompt!: () => void;
  acp.promptImpl = async (sessionId) =>
    new Promise<AcpOutcome>((resolve) => {
      finishPrompt = () => {
        acp.emit({
          sessionId,
          kind: "agent_message_chunk",
          messageId: "answer",
          text: "answer",
        });
        resolve({ kind: "turn", stopReason: "end_turn" });
      };
    });
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    clock,
  });

  const completion = bridge.handleTimelineEvent(event("$typing-cadence:example.org"));
  await waitFor(() => acp.promptCalls.length === 1);
  assert.deepEqual(matrix.typing, [{ roomId: ROOM_ONE, isTyping: true, timeoutMs: 30_000 }]);

  clock.advanceBy(9999);
  assert.equal(matrix.typing.length, 1);
  clock.advanceBy(1);
  assert.deepEqual(matrix.typing.at(-1), {
    roomId: ROOM_ONE,
    isTyping: true,
    timeoutMs: 30_000,
  });

  finishPrompt();
  await flush();
  await flush();
  clock.advanceBy(300);
  await completion;

  assert.deepEqual(
    matrix.typing.map(({ isTyping }) => isTyping),
    [true, true, false],
  );
  assert.equal(matrix.operationOrder.indexOf("typing:off") < matrix.operationOrder.indexOf("message:agent"), true);
  await bridge.stop();
});

void test("typing survives one missed refresh before the server timeout", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  let finishPrompt!: () => void;
  let typingAttempts = 0;
  const sendTyping = matrix.sendTyping.bind(matrix);
  matrix.sendTyping = async (roomId, isTyping, timeoutMs) => {
    typingAttempts += 1;
    if (isTyping && typingAttempts === 2) {
      throw new Error("temporary typing failure");
    }
    await sendTyping(roomId, isTyping, timeoutMs);
  };
  acp.promptImpl = async (_sessionId) =>
    new Promise<AcpOutcome>((resolve) => {
      finishPrompt = () => resolve({ kind: "turn", stopReason: "end_turn", text: "answer" });
    });
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    clock,
  });

  const completion = bridge.handleTimelineEvent(event("$typing-recovery:example.org"));
  await waitFor(() => acp.promptCalls.length === 1);
  clock.advanceBy(10_000);
  await flush();
  assert.deepEqual(
    matrix.typing.map(({ isTyping }) => isTyping),
    [true],
  );
  clock.advanceBy(10_000);
  await flush();
  assert.deepEqual(
    matrix.typing.map(({ isTyping }) => isTyping),
    [true, true],
  );

  finishPrompt();
  await flush();
  await flush();
  clock.advanceBy(300);
  await completion;
  assert.deepEqual(
    matrix.typing.map(({ isTyping }) => isTyping),
    [true, true, false],
  );
  await bridge.stop();
});

void test("receipts are exactly once for eligible dispositions and absent for policy rejects", async () => {
  const acp = new FakeAcp();
  acp.promptImpl = async () => ({
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  const matrix = new FakeMatrix();
  const bridge = new BridgeCoordinator({ config: config(), acp, matrix });

  await bridge.handleTimelineEvent(event("$receipt-ordinary:example.org"));
  await bridge.handleTimelineEvent(event("$receipt-ordinary:example.org"));
  await bridge.handleTimelineEvent(
    event("$receipt-unauthorized:example.org", ROOM_ONE, "hello", "@mallory:example.org"),
  );
  await bridge.handleTimelineEvent(event("$receipt-self:example.org", ROOM_ONE, "hello", "@bridge:example.org"));
  await bridge.handleTimelineEvent({
    ...event("$receipt-unsupported:example.org"),
    type: "m.room.name",
  });
  await bridge.handleTimelineEvent({
    ...event("$receipt-malformed:example.org"),
    content: {
      msgtype: "m.text",
      body: "hello",
      "m.relates_to": { "m.replace": { event_id: "$old" } },
    },
  });
  // eslint-disable-next-line unicorn/no-useless-undefined -- omitted event IDs are explicit test input
  await bridge.handleTimelineEvent(event(undefined));
  assert.deepEqual(matrix.receipts, [{ roomId: ROOM_ONE, eventId: "$receipt-ordinary:example.org" }]);
  assert.deepEqual(
    matrix.typing.map(({ isTyping }) => isTyping),
    [true, false],
  );
  await bridge.stop();

  const oversizedAcp = new FakeAcp();
  const oversizedMatrix = new FakeMatrix();
  const oversizedBridge = new BridgeCoordinator({
    config: config({ maxInputBytes: 3 }),
    acp: oversizedAcp,
    matrix: oversizedMatrix,
  });
  await oversizedBridge.handleTimelineEvent(event("$receipt-oversized:example.org", ROOM_ONE, "long"));
  assert.deepEqual(oversizedMatrix.receipts, [
    {
      roomId: ROOM_ONE,
      eventId: "$receipt-oversized:example.org",
    },
  ]);
  assert.equal(oversizedMatrix.typing.length, 0);
  assert.equal(oversizedAcp.promptCalls.length, 0);
  await oversizedBridge.stop();

  const busyAcp = new FakeAcp();
  const busyMatrix = new FakeMatrix();
  const busyResolvers: Array<(outcome: AcpOutcome) => void> = [];
  busyAcp.promptImpl = async () =>
    new Promise<AcpOutcome>((resolve) => {
      busyResolvers.push(resolve);
    });
  const busyBridge = new BridgeCoordinator({
    config: config({ maxQueuedTurnsPerRoom: 1 }),
    acp: busyAcp,
    matrix: busyMatrix,
  });
  const busyFirst = busyBridge.handleTimelineEvent(event("$receipt-busy-one:example.org"));
  await waitFor(() => busyAcp.promptCalls.length === 1);
  const busySecond = busyBridge.handleTimelineEvent(event("$receipt-busy-two:example.org"));
  const busyThird = busyBridge.handleTimelineEvent(event("$receipt-busy-three:example.org"));
  await busyThird;
  assert.equal(
    busyMatrix.receipts.some(({ eventId }) => eventId === "$receipt-busy-three:example.org"),
    true,
  );
  busyResolvers.shift()?.({
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  await busyFirst;
  await waitFor(() => busyAcp.promptCalls.length === 2);
  busyResolvers.shift()?.({
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  await busySecond;
  assert.deepEqual(
    busyMatrix.typing.map(({ isTyping }) => isTyping),
    [true, false, true, false],
  );
  await busyBridge.stop();
});

void test("typing and receipt failures are sanitized, nonfatal, and never retried independently", async () => {
  const records: Array<{
    level: string;
    event: string;
    fields: Readonly<Record<string, unknown>> | undefined;
  }> = [];
  const diagnostics: DiagnosticSink = {
    emit(level, eventName, fields) {
      records.push({ level, event: eventName, fields });
    },
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  const acp = new FakeAcp();
  acp.promptImpl = async () => ({
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  const matrix = new FakeMatrix();
  matrix.sendTyping = async () => {
    throw new Error("typing response body must not escape");
  };
  matrix.sendReadReceipt = async () => {
    throw new Error("receipt response body must not escape");
  };
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    diagnostics,
  });

  await bridge.handleTimelineEvent(event("$ephemeral-failure:example.org"));
  assert.equal(matrix.sent[0]?.responseKind, "error");
  assert.equal(bridge.fatalError, undefined);
  assert.equal(records.length, 3);
  assert.equal(
    records.every(({ event }) => event === "typing-operation-failed" || event === "receipt-operation-failed"),
    true,
  );
  assert.equal(
    records.some(({ fields }) => JSON.stringify(fields).includes("response body")),
    false,
  );
  await bridge.stop();
});

void test("timeout stops typing immediately while ACP cancellation is pending", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  let finishPrompt!: () => void;
  acp.promptImpl = async () =>
    new Promise<AcpOutcome>((resolve) => {
      finishPrompt = () => resolve({ kind: "turn", stopReason: "cancelled" });
    });
  const bridge = new BridgeCoordinator({
    config: config({ maxTurnSeconds: 1 }),
    acp,
    matrix,
    clock,
  });

  const completion = bridge.handleTimelineEvent(event("$typing-timeout:example.org"));
  await waitFor(() => acp.promptCalls.length === 1);
  clock.advanceBy(1000);
  assert.deepEqual(
    matrix.typing.map(({ isTyping }) => isTyping),
    [true, false],
  );
  assert.deepEqual(acp.cancelCalls, ["session-1"]);

  finishPrompt();
  await completion;
  assert.deepEqual(
    matrix.typing.map(({ isTyping }) => isTyping),
    [true, false],
  );
  await bridge.stop();
});

void test("fatal and graceful shutdown cleanup both turn typing off", async () => {
  for (const mode of ["fatal", "shutdown"] as const) {
    const clock = new FakeClock();
    const acp = new FakeAcp();
    const matrix = new FakeMatrix();
    acp.promptImpl = async () =>
      new Promise<AcpOutcome>(() => {
        // Keep the prompt unresolved so cleanup, rather than normal rendering,
        // is responsible for ending the typing indicator.
      });
    const bridge = new BridgeCoordinator({
      config: config(),
      acp,
      matrix,
      clock,
    });
    void bridge.handleTimelineEvent(event(`$typing-${mode}:example.org`));
    await waitFor(() => acp.promptCalls.length === 1);

    const stopping =
      mode === "fatal"
        ? (() => {
            acp.emitFatal({ code: "acp_transport", message: "ACP failed" });
            return bridge.stop();
          })()
        : bridge.stop();
    assert.deepEqual(
      matrix.typing.map(({ isTyping }) => isTyping),
      [true, false],
    );
    clock.advanceBy(1000);
    await stopping;
  }
});

void test("queued, semaphore-blocked, loading, and omitted catch-up events never type", async () => {
  const queuedAcp = new FakeAcp();
  const queuedMatrix = new FakeMatrix();
  const queuedResolvers: Array<(outcome: AcpOutcome) => void> = [];
  queuedAcp.promptImpl = async () =>
    new Promise<AcpOutcome>((resolve) => {
      queuedResolvers.push(resolve);
    });
  const queuedBridge = new BridgeCoordinator({
    config: config({ maxQueuedTurnsPerRoom: 1 }),
    acp: queuedAcp,
    matrix: queuedMatrix,
  });
  const first = queuedBridge.handleTimelineEvent(event("$queued-one:example.org"));
  await waitFor(() => queuedAcp.promptCalls.length === 1);
  const second = queuedBridge.handleTimelineEvent(event("$queued-two:example.org"));
  await flush();
  assert.deepEqual(
    queuedMatrix.typing.map(({ isTyping }) => isTyping),
    [true],
  );
  queuedResolvers.shift()?.({
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  await first;
  await waitFor(() => queuedAcp.promptCalls.length === 2);
  queuedResolvers.shift()?.({
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  await second;
  await queuedBridge.stop();

  const semaphoreAcp = new FakeAcp();
  const semaphoreMatrix = new FakeMatrix();
  const semaphoreResolvers: Array<(outcome: AcpOutcome) => void> = [];
  semaphoreAcp.promptImpl = async () =>
    new Promise<AcpOutcome>((resolve) => {
      semaphoreResolvers.push(resolve);
    });
  const semaphoreBridge = new BridgeCoordinator({
    config: config({ maxConcurrentPrompts: 1 }),
    acp: semaphoreAcp,
    matrix: semaphoreMatrix,
  });
  const permitHolder = semaphoreBridge.handleTimelineEvent(event("$permit-one:example.org", ROOM_TWO));
  await waitFor(() => semaphoreAcp.promptCalls.length === 1);
  const permitWaiter = semaphoreBridge.handleTimelineEvent(event("$permit-two:example.org", ROOM_ONE));
  await flush();
  assert.deepEqual(
    semaphoreMatrix.typing.map(({ isTyping }) => isTyping),
    [true],
  );
  semaphoreResolvers.shift()?.({
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  await permitHolder;
  await waitFor(() => semaphoreAcp.promptCalls.length === 2);
  semaphoreResolvers.shift()?.({
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  await permitWaiter;
  await semaphoreBridge.stop();

  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-bridge-typing-load-"));
  try {
    const store = await openBridgeStateStore({
      stateDir,
      identity: {
        homeserver: "https://matrix.example.org",
        userId: "@bridge:example.org",
        deviceId: "BRIDGE",
      },
    });
    await store.establishInitialBaseline([]);
    await store.setSessionMapping(ROOM_ONE, "saved-session");
    const loadingAcp = new FakeAcp();
    let finishLoad!: () => void;
    loadingAcp.loadSessionImpl = async () =>
      new Promise<AcpSession>((resolve) => {
        finishLoad = () => resolve({ sessionId: "saved-session" });
      });
    const loadingMatrix = new FakeMatrix();
    const loadingBridge = new BridgeCoordinator({
      config: config(),
      acp: loadingAcp,
      matrix: loadingMatrix,
      stateStore: store,
      loadSession: true,
    });
    loadingAcp.promptImpl = async () => ({
      kind: "method_error",
      operation: "session_prompt",
      fatal: false,
    });
    const loadingEvent = loadingBridge.handleTimelineEvent(event("$loading:example.org"));
    await waitFor(() => loadingAcp.loadCalls.length === 1);
    assert.equal(loadingMatrix.typing.length, 0);
    finishLoad();
    await waitFor(() => loadingAcp.promptCalls.length === 1);
    assert.deepEqual(
      loadingMatrix.typing.map(({ isTyping }) => isTyping),
      [true, false],
    );
    await loadingEvent;
    await loadingBridge.stop();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }

  const catchupAcp = new FakeAcp();
  const catchupMatrix = new FakeMatrix();
  let finishCatchup!: (outcome: AcpOutcome) => void;
  catchupAcp.promptImpl = async () =>
    new Promise<AcpOutcome>((resolve) => {
      finishCatchup = resolve;
    });
  const catchupBridge = new BridgeCoordinator({
    config: config({ maxQueuedTurnsPerRoom: 1 }),
    acp: catchupAcp,
    matrix: catchupMatrix,
  });
  const catchupFirst = catchupBridge.handleTimelineEvent(event("$catchup-one:example.org"));
  await waitFor(() => catchupAcp.promptCalls.length === 1);
  const catchupQueued = catchupBridge.handleTimelineEvent(event("$catchup-two:example.org"));
  const omitted = catchupBridge.handleTimelineEvent({
    ...event("$catchup-omitted:example.org"),
    isCatchUp: true,
    timeline: { phase: "incremental", isCatchUp: true, limited: false },
  });
  await omitted;
  assert.deepEqual(
    catchupMatrix.typing.map(({ isTyping }) => isTyping),
    [true],
  );
  assert.equal(
    catchupMatrix.receipts.some(({ eventId }) => eventId === "$catchup-omitted:example.org"),
    false,
  );
  finishCatchup({
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  await catchupFirst;
  await waitFor(() => catchupAcp.promptCalls.length === 2);
  finishCatchup({
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  await catchupQueued;
  await catchupBridge.stop();
});

void test("exact reset is queued as a control and the next prompt creates a fresh session", async () => {
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  acp.promptImpl = async () => ({
    kind: "turn",
    stopReason: "end_turn",
    text: "fresh",
  });
  const bridge = new BridgeCoordinator({ config: config(), acp, matrix });

  await bridge.handleTimelineEvent(event("$reset:example.org", ROOM_ONE, "/reset"));
  assert.equal(matrix.sent[0]?.content.body, "Agent session reset.");
  assert.equal(acp.promptCalls.length, 0);

  await bridge.handleTimelineEvent(event("$after-reset:example.org", ROOM_ONE, "hello again"));
  assert.equal(acp.sessionCount, 1);
  assert.equal(acp.promptCalls[0]?.text, "hello again");
  await bridge.stop();
});

void test("recognizes reset only after authorization and reply normalization", async () => {
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  acp.promptImpl = async () => ({
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  const bridge = new BridgeCoordinator({ config: config(), acp, matrix });

  const replyReset: InboundMatrixEvent = {
    ...event("$reply-reset:example.org", ROOM_ONE, "> quoted\n\n/reset"),
    content: {
      msgtype: "m.text",
      body: "> quoted\n\n/reset",
      "m.relates_to": {
        "m.in_reply_to": { event_id: "$quoted:example.org" },
      },
    },
  };
  await bridge.handleTimelineEvent(replyReset);
  const typingAfterReset = matrix.typing.length;

  const ordinaryBodies = ["/reset ", " /reset", "/reset argument", "/reset\n", "//reset", "> quoted\n\n/reset"];
  for (const [index, body] of ordinaryBodies.entries()) {
    await bridge.handleTimelineEvent(event(`$ordinary-reset-${index}:example.org`, ROOM_ONE, body));
  }
  await bridge.handleTimelineEvent(
    event("$unauthorized-reset:example.org", ROOM_ONE, "/reset", "@mallory:example.org"),
  );
  await bridge.handleTimelineEvent({
    ...event("$malformed-reset:example.org", ROOM_ONE, "/reset"),
    content: {
      msgtype: "m.text",
      body: "/reset",
      "m.relates_to": { "m.replace": { event_id: "$old:example.org" } },
    },
  });

  assert.equal(matrix.sent[0]?.responseKind, "reset");
  assert.equal(matrix.sent[0]?.content.body, "Agent session reset.");
  assert.deepEqual(
    acp.promptCalls.map(({ text }) => text),
    ordinaryBodies,
  );
  assert.equal(
    matrix.sent.some((part) => part.content.body === "Agent session reset."),
    true,
  );
  assert.equal(typingAfterReset, 0);
  assert.equal(matrix.receipts.filter(({ eventId }) => eventId === "$reply-reset:example.org").length, 1);
  assert.equal(
    matrix.receipts.some(({ eventId }) => eventId === "$unauthorized-reset:example.org"),
    false,
  );
  await bridge.stop();
});

void test("reset stays in room order, is busy when the bounded queue is full, and frees a fresh session", async () => {
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  let resolveFirst!: (outcome: AcpOutcome) => void;
  let promptNumber = 0;
  acp.promptImpl = async () => {
    promptNumber += 1;
    if (promptNumber === 1) {
      return new Promise<AcpOutcome>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return {
      kind: "method_error",
      operation: "session_prompt",
      fatal: false,
    };
  };
  const bridge = new BridgeCoordinator({
    config: config({ maxQueuedTurnsPerRoom: 2 }),
    acp,
    matrix,
  });

  const first = bridge.handleTimelineEvent(event("$ordered-one:example.org", ROOM_ONE, "first"));
  const earlierQueued = bridge.handleTimelineEvent(event("$ordered-two:example.org", ROOM_ONE, "earlier queued"));
  const reset = bridge.handleTimelineEvent(event("$ordered-reset:example.org", ROOM_ONE, "/reset"));
  const busy = bridge.handleTimelineEvent(event("$ordered-busy:example.org", ROOM_ONE, "too late"));
  await flush();

  assert.equal(acp.promptCalls.length, 1);
  assert.equal(bridge.getQueueDepth(ROOM_ONE), 2);
  await busy;
  assert.equal(
    matrix.sent.some((part) => part.responseKind === "busy"),
    true,
  );
  assert.equal(
    acp.promptCalls.some(({ text }) => text === "/reset"),
    false,
  );

  resolveFirst({
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  await Promise.all([first, earlierQueued, reset]);
  assert.deepEqual(
    acp.promptCalls.map(({ text }) => text),
    ["first", "earlier queued"],
  );
  assert.equal(
    matrix.sent.some((part) => part.content.body === "Agent session reset."),
    true,
  );

  const afterReset = bridge.handleTimelineEvent(event("$ordered-after-reset:example.org", ROOM_ONE, "after reset"));
  await afterReset;
  assert.deepEqual(
    acp.promptCalls.map(({ text }) => text),
    ["first", "earlier queued", "after reset"],
  );
  assert.notEqual(acp.promptCalls[0]?.sessionId, acp.promptCalls[2]?.sessionId);
  await bridge.stop();
});

void test("reset bypasses a saturated global prompt permit", async () => {
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  let resolvePrompt!: (outcome: AcpOutcome) => void;
  acp.promptImpl = async () =>
    new Promise<AcpOutcome>((resolve) => {
      resolvePrompt = resolve;
    });
  const bridge = new BridgeCoordinator({
    config: config({ maxConcurrentPrompts: 1 }),
    acp,
    matrix,
  });

  const ordinary = bridge.handleTimelineEvent(event("$permit-holder:example.org", ROOM_TWO, "occupy permit"));
  await flush();
  assert.equal(acp.promptCalls.length, 1);

  await bridge.handleTimelineEvent(event("$permit-reset:example.org", ROOM_ONE, "/reset"));
  assert.equal(matrix.sent.at(-1)?.content.body, "Agent session reset.");
  assert.equal(acp.promptCalls.length, 1);

  resolvePrompt({
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  await ordinary;
  await bridge.stop();
});

void test("reset removes only its room mapping and succeeds without an existing session", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-bridge-reset-"));
  try {
    const store = await openBridgeStateStore({
      stateDir,
      identity: {
        homeserver: "https://matrix.example.org",
        userId: "@bridge:example.org",
        deviceId: "BRIDGE",
      },
    });
    await store.establishInitialBaseline([]);
    await store.setSessionMapping(ROOM_ONE, "room-one-session");
    await store.setSessionMapping(ROOM_TWO, "room-two-session");

    const acp = new FakeAcp();
    acp.promptImpl = async () => ({
      kind: "method_error",
      operation: "session_prompt",
      fatal: false,
    });
    const matrix = new FakeMatrix();
    let mappingAtResetSend: string | undefined = "not-sent";
    matrix.send = async (part) => {
      if (part.responseKind === "reset") {
        mappingAtResetSend = store.getSessionMapping(ROOM_ONE);
      }
      matrix.sent.push(part);
    };
    const bridge = new BridgeCoordinator({
      config: config(),
      acp,
      matrix,
      stateStore: store,
      loadSession: true,
    });

    await bridge.handleTimelineEvent(event("$durable-reset:example.org", ROOM_ONE, "/reset"));
    assert.equal(matrix.sent[0]?.content.body, "Agent session reset.");
    assert.equal(mappingAtResetSend, undefined);
    assert.equal(store.getSessionMapping(ROOM_ONE), undefined);
    assert.equal(store.getSessionMapping(ROOM_TWO), "room-two-session");
    assert.deepEqual(acp.loadCalls, []);
    assert.equal(acp.promptCalls.length, 0);

    await bridge.handleTimelineEvent(event("$other-room:example.org", ROOM_TWO, "other room"));
    await bridge.handleTimelineEvent(event("$fresh-room:example.org", ROOM_ONE, "fresh room"));
    assert.deepEqual(acp.loadCalls, ["room-two-session"]);
    assert.equal(acp.promptCalls[0]?.sessionId, "room-two-session");
    assert.equal(acp.promptCalls[1]?.sessionId, "session-1");
    assert.equal(store.getSessionMapping(ROOM_ONE), "session-1");
    assert.equal(store.getSessionMapping(ROOM_TWO), "room-two-session");
    await bridge.stop();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("reset uses stable retry transactions and abandons permanent Matrix failures", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  const attemptedTransactionIds: string[] = [];
  let attempts = 0;
  matrix.send = async (part) => {
    attempts += 1;
    attemptedTransactionIds.push(part.transactionId);
    if (attempts === 1) {
      throw {
        failure: { kind: "transient", retryable: true, sdkRetryable: false },
      };
    }
    matrix.sent.push(part);
  };
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    clock,
    random: () => 0,
  });

  const completion = bridge.handleTimelineEvent(event("$reset-retry:example.org", ROOM_ONE, "/reset"));
  await flush();
  await flush();
  clock.advanceBy(0);
  await flush();
  await completion;
  assert.equal(attempts, 2);
  assert.equal(new Set(attemptedTransactionIds).size, 1);
  assert.equal(matrix.sent[0]?.responseKind, "reset");
  await bridge.stop();

  const permanentMatrix = new FakeMatrix();
  permanentMatrix.send = async () => {
    throw {
      failure: { kind: "permanent", retryable: false, sdkRetryable: false },
    };
  };
  const permanentBridge = new BridgeCoordinator({
    config: config(),
    acp: new FakeAcp(),
    matrix: permanentMatrix,
  });
  const fatal: FatalError[] = [];
  permanentBridge.onFatalError((error) => fatal.push(error));
  await permanentBridge.handleTimelineEvent(event("$reset-permanent:example.org", ROOM_ONE, "/reset"));
  assert.equal(permanentMatrix.sent.length, 0);
  assert.equal(fatal.length, 0);
  await permanentBridge.stop();
});

void test("a reset state-write failure is fatal and never acknowledges success", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-bridge-reset-failure-"));
  try {
    let failWrites = false;
    const store = await openBridgeStateStore({
      stateDir,
      identity: {
        homeserver: "https://matrix.example.org",
        userId: "@bridge:example.org",
        deviceId: "BRIDGE",
      },
      faultInjector: async (point) => {
        if (failWrites && point === "rename") {
          throw new Error("injected state failure");
        }
      },
    });
    await store.establishInitialBaseline([]);
    await store.setSessionMapping(ROOM_ONE, "saved-session");
    failWrites = true;

    const acp = new FakeAcp();
    const matrix = new FakeMatrix();
    const bridge = new BridgeCoordinator({
      config: config(),
      acp,
      matrix,
      stateStore: store,
      loadSession: true,
    });
    const fatal: FatalError[] = [];
    bridge.onFatalError((error) => fatal.push(error));

    await bridge.handleTimelineEvent(event("$reset-state-failure:example.org", ROOM_ONE, "/reset"));
    assert.equal(matrix.sent.length, 0);
    assert.equal(acp.promptCalls.length, 0);
    assert.equal(fatal[0]?.code, "state");
    assert.equal(bridge.stopping, true);
    assert.equal(store.getSessionMapping(ROOM_ONE), "saved-session");
    await bridge.stop();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("restores a durable room session before its first prompt", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-bridge-session-"));
  try {
    const clock = new FakeClock();
    const store = await openBridgeStateStore({
      stateDir,
      identity: {
        homeserver: "https://matrix.example.org",
        userId: "@bridge:example.org",
        deviceId: "BRIDGE",
      },
    });
    await store.establishInitialBaseline([]);
    await store.setSessionMapping(ROOM_ONE, "saved-session");
    const acp = new FakeAcp();
    acp.promptImpl = async () => ({
      kind: "turn",
      stopReason: "end_turn",
      text: "loaded answer",
    });
    const matrix = new FakeMatrix();
    const bridge = new BridgeCoordinator({
      config: config(),
      acp,
      matrix,
      clock,
      stateStore: store,
      loadSession: true,
    });

    const completion = bridge.handleTimelineEvent(event("$loaded:example.org"));
    await flush();
    clock.advanceBy(300);
    await completion;
    assert.deepEqual(acp.loadCalls, ["saved-session"]);
    assert.equal(acp.promptCalls[0]?.sessionId, "saved-session");
    assert.equal(matrix.sent.at(-1)?.content.body, "loaded answer");
    await bridge.stop();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("discards unsupported durable mappings and never persists a newly-created session", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-bridge-session-"));
  try {
    const clock = new FakeClock();
    const store = await openBridgeStateStore({
      stateDir,
      identity: {
        homeserver: "https://matrix.example.org",
        userId: "@bridge:example.org",
        deviceId: "BRIDGE",
      },
    });
    await store.establishInitialBaseline([]);
    await store.setSessionMapping(ROOM_ONE, "old-session");
    const acp = new FakeAcp();
    acp.promptImpl = async () => ({
      kind: "turn",
      stopReason: "end_turn",
      text: "new answer",
    });
    const matrix = new FakeMatrix();
    const bridge = new BridgeCoordinator({
      config: config(),
      acp,
      matrix,
      clock,
      stateStore: store,
      loadSession: false,
    });

    const completion = bridge.handleTimelineEvent(event("$unsupported-load:example.org"));
    await waitFor(() => acp.promptCalls.length === 1);
    clock.advanceBy(300);
    await completion;

    assert.deepEqual(acp.loadCalls, []);
    assert.equal(acp.sessionCount, 1);
    assert.equal(acp.promptCalls[0]?.sessionId, "session-1");
    assert.equal(store.getSessionMapping(ROOM_ONE), undefined);
    await bridge.stop();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("persists a new mapping before the first prompt and phase-gates every load update", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-bridge-session-"));
  try {
    const clock = new FakeClock();
    const store = await openBridgeStateStore({
      stateDir,
      identity: {
        homeserver: "https://matrix.example.org",
        userId: "@bridge:example.org",
        deviceId: "BRIDGE",
      },
    });
    await store.establishInitialBaseline([]);
    await store.setSessionMapping(ROOM_ONE, "saved-session");

    const acp = new FakeAcp();
    let finishLoad!: () => void;
    let loadActive = false;
    acp.loadSessionImpl = async () => {
      loadActive = true;
      await new Promise<void>((resolve) => {
        finishLoad = () => {
          loadActive = false;
          resolve();
        };
      });
      return { sessionId: "saved-session" };
    };
    acp.promptImpl = async (sessionId) => {
      assert.equal(loadActive, false);
      assert.equal(store.getSessionMapping(ROOM_ONE), sessionId);
      acp.emit({
        sessionId,
        kind: "agent_message_chunk",
        messageId: "answer",
        text: "after load",
      });
      return { kind: "turn", stopReason: "end_turn" };
    };
    const matrix = new FakeMatrix();
    const bridge = new BridgeCoordinator({
      config: config(),
      acp,
      matrix,
      clock,
      stateStore: store,
      loadSession: true,
    });

    const completion = bridge.handleTimelineEvent(event("$load-phase:example.org"));
    await waitFor(() => acp.loadCalls.length === 1 && loadActive);
    assert.deepEqual(acp.loadOptions, [
      {
        cwd: "/tmp",
        mcpServers: [],
        sessionId: "saved-session",
      },
    ]);
    assert.equal(acp.promptCalls.length, 0);

    acp.emit({
      sessionId: "saved-session",
      kind: "agent_message_chunk",
      messageId: "history-one",
      text: "replayed one",
    });
    acp.emit({
      sessionId: "saved-session",
      kind: "agent_message_chunk",
      messageId: "history-two",
      text: "replayed two",
    });
    await flush();
    assert.equal(matrix.sent.length, 0);

    finishLoad();
    await waitFor(() => acp.promptCalls.length === 1);
    clock.advanceBy(300);
    await completion;
    assert.equal(matrix.sent.at(-1)?.content.body, "after load");
    await bridge.stop();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("replaces a stale mapping after a healthy load method error and warns only with room metadata", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-bridge-session-"));
  try {
    const clock = new FakeClock();
    const store = await openBridgeStateStore({
      stateDir,
      identity: {
        homeserver: "https://matrix.example.org",
        userId: "@bridge:example.org",
        deviceId: "BRIDGE",
      },
    });
    await store.establishInitialBaseline([]);
    await store.setSessionMapping(ROOM_ONE, "stale-session");
    const diagnostics: Array<{
      level: string;
      event: string;
      fields: Readonly<Record<string, unknown>> | undefined;
    }> = [];
    const diagnosticSink: DiagnosticSink = {
      emit(level, eventName, fields) {
        diagnostics.push({ level, event: eventName, fields });
      },
      debug() {},
      info() {},
      warn() {},
      error() {},
    };
    const acp = new FakeAcp();
    acp.loadSessionImpl = async () => {
      return {
        kind: "method_error",
        operation: "session_load",
        fatal: false,
      } as unknown as AcpSession;
    };
    acp.promptImpl = async () => ({
      kind: "turn",
      stopReason: "end_turn",
      text: "replacement",
    });
    const matrix = new FakeMatrix();
    const bridge = new BridgeCoordinator({
      config: config(),
      acp,
      matrix,
      clock,
      diagnostics: diagnosticSink,
      stateStore: store,
      loadSession: true,
    });

    const completion = bridge.handleTimelineEvent(event("$stale-session:example.org"));
    await waitFor(() => acp.promptCalls.length === 1);
    clock.advanceBy(300);
    await completion;

    assert.deepEqual(acp.loadCalls, ["stale-session"]);
    assert.equal(acp.sessionCount, 1);
    assert.equal(acp.promptCalls[0]?.sessionId, "session-1");
    assert.equal(store.getSessionMapping(ROOM_ONE), "session-1");
    const reset = diagnostics.find((entry) => entry.event === "room-context-reset");
    assert.equal(reset?.level, "warn");
    assert.deepEqual(reset?.fields, { roomId: ROOM_ONE });
    assert.equal(
      diagnostics.some((entry) => JSON.stringify(entry.fields).includes("stale-session")),
      false,
    );
    await bridge.stop();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("keeps load transport and protocol failures fatal instead of creating a replacement", async () => {
  for (const failure of [
    { kind: "transport_error", operation: "session_load", fatal: true },
    { kind: "protocol_error", operation: "session_load", fatal: true },
  ] as const) {
    const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-bridge-session-"));
    try {
      const clock = new FakeClock();
      const store = await openBridgeStateStore({
        stateDir,
        identity: {
          homeserver: "https://matrix.example.org",
          userId: "@bridge:example.org",
          deviceId: "BRIDGE",
        },
      });
      await store.establishInitialBaseline([]);
      await store.setSessionMapping(ROOM_ONE, "saved-session");
      const acp = new FakeAcp();
      acp.loadSessionImpl = async () => {
        throw failure;
      };
      const matrix = new FakeMatrix();
      const bridge = new BridgeCoordinator({
        config: config(),
        acp,
        matrix,
        clock,
        stateStore: store,
        loadSession: true,
      });
      const fatal: FatalError[] = [];
      bridge.onFatalError((error) => fatal.push(error));

      await bridge.handleTimelineEvent(event(`$fatal-load-${failure.kind}:example.org`));
      assert.equal(acp.sessionCount, 0);
      assert.equal(acp.promptCalls.length, 0);
      assert.equal(fatal.length, 1);
      assert.equal(fatal[0]?.code, failure.kind === "protocol_error" ? "acp_protocol" : "acp_transport");
      assert.equal(matrix.sent.length, 0);
      await bridge.stop();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});

void test("prunes removed-room mappings and keeps restored sessions isolated by room", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-bridge-session-"));
  try {
    const clock = new FakeClock();
    const store = await openBridgeStateStore({
      stateDir,
      identity: {
        homeserver: "https://matrix.example.org",
        userId: "@bridge:example.org",
        deviceId: "BRIDGE",
      },
    });
    await store.establishInitialBaseline([]);
    await store.setSessionMapping(ROOM_ONE, "room-one-session");
    await store.setSessionMapping(ROOM_TWO, "removed-room-session");
    const acp = new FakeAcp();
    acp.promptImpl = async (_sessionId, text) => ({
      kind: "turn",
      stopReason: "end_turn",
      text,
    });
    const matrix = new FakeMatrix();
    const bridge = new BridgeCoordinator({
      config: {
        ...config(),
        matrix: { ...config().matrix, allowedRooms: [ROOM_ONE] },
      },
      acp,
      matrix,
      clock,
      stateStore: store,
      loadSession: true,
    });

    const completion = bridge.handleTimelineEvent(event("$isolated-room:example.org", ROOM_ONE, "room one"));
    await waitFor(() => acp.promptCalls.length === 1);
    clock.advanceBy(300);
    await completion;
    assert.equal(store.getSessionMapping(ROOM_TWO), undefined);
    assert.equal(acp.promptCalls[0]?.sessionId, "room-one-session");
    assert.equal(acp.loadCalls[0], "room-one-session");
    await bridge.stop();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

void test("streamed thought paragraphs stay separate and unbolded through Matrix edits", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeLiveMatrix();
  let resolvePrompt!: (outcome: AcpOutcome) => void;
  acp.promptImpl = () =>
    new Promise((resolve) => {
      resolvePrompt = resolve;
    });
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    clock,
  });
  const completion = bridge.handleTimelineEvent(event("$thought-paragraphs:example.org"));
  await waitFor(() => acp.promptCalls.length === 1);
  const sessionId = acp.promptCalls[0]!.sessionId;
  acp.emit({
    sessionId,
    kind: "agent_thought_chunk",
    text: "**First heading**",
  });
  acp.emit({ sessionId, kind: "agent_thought_chunk", text: "\n\n" });
  acp.emit({
    sessionId,
    kind: "agent_thought_chunk",
    text: "**Second heading**",
  });
  await waitFor(() => matrix.html.some((message) => message.formattedBody.includes("Second heading")));
  const current = matrix.html.at(-1);
  assert.equal(current?.body, "💭 First heading\n\n💭 Second heading");
  assert.equal(current?.formattedBody, "<p>💭 First heading</p>\n<p>💭 Second heading</p>");
  acp.emit({ sessionId, kind: "agent_message_chunk", text: "Done" });
  await waitFor(() => matrix.html.some((message) => message.formattedBody.includes("Past agent events (1)")));
  const archived = [...matrix.html]
    .reverse()
    .find((message) => message.formattedBody.includes("Past agent events (1)"));
  assert.match(archived?.formattedBody ?? "", /<p>💭 First heading<\/p>\n<p>💭 Second heading<\/p>/);
  resolvePrompt({ kind: "turn", stopReason: "end_turn" });
  await flush();
  clock.advanceBy(300);
  await completion;
  await bridge.stop();
});

void test("agent text renders complete Markdown once when its message closes", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeLiveMatrix();
  let resolvePrompt!: (outcome: AcpOutcome) => void;
  acp.promptImpl = () =>
    new Promise((resolve) => {
      resolvePrompt = resolve;
    });
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    clock,
  });
  const completion = bridge.handleTimelineEvent(event("$markdown-live:example.org"));
  await waitFor(() => acp.promptCalls.length === 1);
  const sessionId = acp.promptCalls[0]!.sessionId;
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "markdown",
    text: "**Wild",
  });
  await flush();
  assert.equal(matrix.html.length, 0);
  const continuation = " Card**\n\n- One\n- Two\n\n[site](https://example.com) `code` <script>";
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "markdown",
    text: continuation,
  });
  await flush();
  assert.equal(matrix.html.length, 0);
  acp.emit({ sessionId, kind: "agent_thought_chunk", text: "A new thought" });
  await waitFor(() => matrix.html.some((message) => message.body === `**Wild${continuation}`));
  const latest = matrix.html.find((message) => message.body === `**Wild${continuation}`);
  assert.equal(latest?.targetEventId, undefined);
  assert.equal(latest?.body, `**Wild${continuation}`);
  assert.match(latest?.formattedBody ?? "", /<strong>Wild Card<\/strong>/);
  assert.match(latest?.formattedBody ?? "", /<ul>\s*<li>One<\/li>\s*<li>Two<\/li>\s*<\/ul>/);
  assert.match(latest?.formattedBody ?? "", /<a href="https:\/\/example.com">site<\/a>/);
  assert.match(latest?.formattedBody ?? "", /<code>code<\/code>/);
  assert.match(latest?.formattedBody ?? "", /&lt;script&gt;/);
  assert.doesNotMatch(latest?.formattedBody ?? "", /<script>/);
  resolvePrompt({ kind: "turn", stopReason: "end_turn" });
  await flush();
  clock.advanceBy(300);
  await completion;
  assert.equal(matrix.sent.length, 0);
  assert.equal(matrix.html.filter((message) => message.body === latest?.body).length, 1);
  await bridge.stop();
});

void test("tool, thought, and distinct IDs close text in order without text edits", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeLiveMatrix();
  let resolvePrompt!: (outcome: AcpOutcome) => void;
  acp.promptImpl = () =>
    new Promise((resolve) => {
      resolvePrompt = resolve;
    });
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    clock,
  });
  const completion = bridge.handleTimelineEvent(event("$text-boundaries:example.org"));
  await waitFor(() => acp.promptCalls.length === 1);
  const sessionId = acp.promptCalls[0]!.sessionId;

  acp.emit({ sessionId, kind: "agent_message_chunk", text: "Before " });
  acp.emit({ sessionId, kind: "agent_message_chunk", text: "tool" });
  acp.emit({
    sessionId,
    kind: "tool_call_update",
    toolCallId: "missing",
    status: "in_progress",
  });
  acp.emit({ sessionId, kind: "agent_thought_chunk", text: "\n\n" });
  await flush();
  assert.equal(matrix.html.length, 0);
  acp.emit({
    sessionId,
    kind: "tool_call",
    toolCallId: "read",
    title: "read",
    toolKind: "read",
    status: "pending",
  });
  await waitFor(() => matrix.html.length >= 2);
  assert.equal(matrix.html[0]?.body, "Before tool");
  assert.match(matrix.html[1]?.body ?? "", /Read/);

  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "after-tool",
    text: "After ",
  });
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "after-tool",
    text: "tool",
  });
  acp.emit({ sessionId, kind: "agent_thought_chunk", text: "\n\n" });
  await flush();
  assert.equal(matrix.html.filter((message) => message.body === "After tool").length, 0);
  acp.emit({ sessionId, kind: "agent_thought_chunk", text: "Thinking" });
  await waitFor(() => matrix.html.some((message) => message.body === "After tool"));
  const thoughtIndex = matrix.html.findIndex((message) => message.body.includes("Thinking"));
  const textIndex = matrix.html.findIndex((message) => message.body === "After tool");
  assert.ok(thoughtIndex > textIndex);

  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "first",
    text: "One",
  });
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "second",
    text: "Two",
  });
  await waitFor(() => matrix.html.some((message) => message.body === "One"));
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "first",
    text: "stale",
  });
  resolvePrompt({ kind: "turn", stopReason: "end_turn" });
  await flush();
  clock.advanceBy(300);
  await completion;
  assert.equal(matrix.html.filter((message) => message.body === "Two").length, 1);
  assert.equal(
    matrix.html.some(
      (message) =>
        message.targetEventId !== undefined && ["Before tool", "After tool", "One", "Two"].includes(message.body),
    ),
    false,
  );
  assert.equal(
    matrix.html.some((message) => message.body.includes("stale")),
    false,
  );
  assert.equal(matrix.sent.length, 0);
  await bridge.stop();
});

void test("live mcpScript activity includes its ACP code input on send and result edit", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeLiveMatrix();
  let resolvePrompt!: (outcome: AcpOutcome) => void;
  acp.promptImpl = () =>
    new Promise((resolve) => {
      resolvePrompt = resolve;
    });
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    clock,
  });
  const completion = bridge.handleTimelineEvent(event("$script-live:example.org"));
  await waitFor(() => acp.promptCalls.length === 1);
  const sessionId = acp.promptCalls[0]!.sessionId;
  const source = "return { probe: '<sample>', sum: 2 + 3 };";
  acp.emit({
    sessionId,
    kind: "tool_call",
    toolCallId: "script",
    title: "mcpScript",
    toolKind: "other",
    status: "pending",
    rawInput: { code: source },
  });
  await waitFor(() => matrix.html.length > 0);
  assert.match(matrix.html[0]?.formattedBody ?? "", /MCP Script\(/);
  assert.match(matrix.html[0]?.formattedBody ?? "", /<pre><code>return \{ probe: &#39;&lt;sample&gt;&#39;/);
  assert.match(matrix.html[0]?.body ?? "", /Script:\nreturn \{ probe: '<sample>', sum: 2 \+ 3 \};/);
  acp.emit({
    sessionId,
    kind: "tool_call_update",
    toolCallId: "script",
    status: "completed",
    content: [{ type: "content", text: '{"probe":"done"}' }],
  });
  await waitFor(() => matrix.html.some((message) => message.body.includes("done")));
  assert.match(matrix.html.at(-1)?.formattedBody ?? "", /<pre><code>return \{ probe: &#39;&lt;sample&gt;&#39;/);
  assert.match(
    matrix.html.at(-1)?.formattedBody ?? "",
    /<\/details>\n<blockquote><pre><code>\{&quot;probe&quot;:&quot;done&quot;\}<\/code><\/pre><\/blockquote>$/,
  );
  assert.match(matrix.html.at(-1)?.body ?? "", /Script:\nreturn \{ probe: '<sample>', sum: 2 \+ 3 \};/);
  acp.emit({
    sessionId,
    kind: "tool_call_update",
    toolCallId: "script",
    status: "completed",
    content: [{ type: "content", text: "<result>\nline 2\nline 3\nline 4" }],
  });
  await waitFor(() => matrix.html.some((message) => message.body.includes("line 3")));
  const longResult = matrix.html.at(-1);
  assert.match(
    longResult?.formattedBody ?? "",
    /<\/details>\n<blockquote><pre><code>&lt;result&gt;&#10;line 2&#10;line 3&#10;line 4<\/code><\/pre><\/blockquote>$/,
  );
  assert.match(
    longResult?.body ?? "",
    /Script:\nreturn \{ probe: '<sample>', sum: 2 \+ 3 \};\n<result>\nline 2\nline 3\nline 4$/,
  );
  resolvePrompt({ kind: "turn", stopReason: "end_turn" });
  await flush();
  clock.advanceBy(30_000); // Tool-only turns drain at the cap, not the text quiet period.
  await completion;
  await bridge.stop();
});

void test("live activity rolls over after ten events, archives at agent text, and edits late tools", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeLiveMatrix();
  let resolvePrompt!: (outcome: AcpOutcome) => void;
  acp.promptImpl = () =>
    new Promise((resolve) => {
      resolvePrompt = resolve;
    });
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    clock,
  });
  const completion = bridge.handleTimelineEvent(event("$activity:example.org"));
  await waitFor(() => acp.promptCalls.length === 1);
  const sessionId = acp.promptCalls[0]!.sessionId;
  for (let index = 0; index < 9; index += 1) {
    acp.emit({
      sessionId,
      kind: "agent_thought_chunk",
      messageId: `thought-${index}`,
      text: `thought ${index}`,
    });
  }
  acp.emit({
    sessionId,
    kind: "tool_call",
    toolCallId: "late-tool",
    title: "read",
    toolKind: "read",
    status: "pending",
  });
  await waitFor(() => matrix.html.length > 0);
  acp.emit({
    sessionId,
    kind: "agent_thought_chunk",
    messageId: "thought-11",
    text: "eleventh",
  });
  await waitFor(() => matrix.html.some((message) => message.formattedBody.includes("Past agent events (10)")));
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "answer",
    text: "Hello",
  });
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "answer",
    text: " world",
  });
  acp.emit({
    sessionId,
    kind: "tool_call_update",
    toolCallId: "late-tool",
    status: "completed",
    content: [{ type: "content", text: "result" }],
  });
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "answer",
    text: "!",
  });
  await waitFor(() => matrix.html.some((message) => message.formattedBody.includes("result")));
  assert.equal(
    matrix.html.some((message) => message.body === "Hello world!"),
    false,
  );
  const firstBatch = matrix.html.filter((message) => message.formattedBody.includes("Past agent events (10)"));
  assert.equal(firstBatch.at(-1)?.targetEventId, firstBatch[0]?.targetEventId);
  assert.match(firstBatch.at(-1)?.formattedBody ?? "", /<blockquote><pre><code>result<\/code><\/pre><\/blockquote>/);
  assert.equal(
    matrix.html.some((message) => message.formattedBody.includes("Past agent events (1)")),
    true,
  );
  assert.equal(
    matrix.html.some(
      (message) =>
        message.body.includes("eleventh") &&
        message.targetEventId === undefined &&
        !message.formattedBody.includes("Past agent events"),
    ),
    true,
  );
  resolvePrompt({ kind: "turn", stopReason: "end_turn" });
  await flush();
  clock.advanceBy(300);
  await completion;
  assert.equal(matrix.sent.length, 0);
  assert.equal(
    matrix.html.filter((message) => message.body === "Hello world!" && message.targetEventId === undefined).length,
    1,
  );
  acp.emit({
    sessionId,
    kind: "tool_call_update",
    toolCallId: "late-tool",
    status: "failed",
  });
  await flush();
  assert.equal(matrix.html.at(-1)?.body.includes("failed"), false);
  await bridge.stop();
});

void test("agent text collapses the latest activity after its first expanded send", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeLiveMatrix();
  let resolvePrompt!: (outcome: AcpOutcome) => void;
  acp.promptImpl = () =>
    new Promise((resolve) => {
      resolvePrompt = resolve;
    });
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    clock,
  });
  const completion = bridge.handleTimelineEvent(event("$activity-boundary:example.org"));
  await waitFor(() => acp.promptCalls.length === 1);
  const sessionId = acp.promptCalls[0]!.sessionId;
  for (let index = 0; index < 11; index += 1) {
    acp.emit({
      sessionId,
      kind: "agent_thought_chunk",
      messageId: `thought-${index}`,
      text: `thought ${index}`,
    });
  }
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "answer",
    text: "Answer",
  });
  await waitFor(
    () =>
      matrix.html.some((message) => message.formattedBody.includes("Past agent events (10)")) &&
      matrix.html.some((message) => message.formattedBody.includes("Past agent events (1)")),
  );
  assert.equal(
    matrix.html.some((message) => message.body === "Answer"),
    false,
  );
  const latest = matrix.html.filter((message) => message.body.includes("thought 10"));
  assert.ok(latest.length >= 2);
  assert.equal(
    latest.some(
      (message) => message.targetEventId === undefined && !message.formattedBody.includes("Past agent events"),
    ),
    true,
  );
  assert.match(latest.at(-1)?.formattedBody ?? "", /Past agent events \(1\)/);

  acp.emit({
    sessionId,
    kind: "agent_thought_chunk",
    messageId: "next",
    text: "newest",
  });
  await waitFor(
    () =>
      matrix.html.some((message) => message.body.includes("newest")) &&
      matrix.html.some((message) => message.body === "Answer"),
  );
  assert.equal(matrix.html.at(-1)?.formattedBody.includes("Past agent events"), false);
  resolvePrompt({ kind: "turn", stopReason: "end_turn" });
  await flush();
  clock.advanceBy(300);
  await completion;
  await bridge.stop();
});

void test("rapid rollover and agent text never send a new batch already collapsed", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeLiveMatrix();
  let resolvePrompt!: (outcome: AcpOutcome) => void;
  acp.promptImpl = () =>
    new Promise((resolve) => {
      resolvePrompt = resolve;
    });
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    clock,
  });
  const completion = bridge.handleTimelineEvent(event("$rapid-activity:example.org"));
  await waitFor(() => acp.promptCalls.length === 1);
  const sessionId = acp.promptCalls[0]!.sessionId;
  for (let index = 0; index < 11; index += 1) {
    acp.emit({
      sessionId,
      kind: "agent_thought_chunk",
      messageId: `thought-${index}`,
      text: `thought ${index}`,
    });
  }
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "answer",
    text: "Answer",
  });
  acp.emit({
    sessionId,
    kind: "agent_thought_chunk",
    messageId: "next",
    text: "newest",
  });
  await waitFor(
    () =>
      matrix.html.some((message) => message.formattedBody.includes("Past agent events (1)")) &&
      matrix.html.some((message) => message.body.includes("newest")),
  );
  const prior = matrix.html.filter((message) => message.body.includes("thought 10"));
  assert.ok(prior.length >= 2);
  assert.equal(prior[0]?.targetEventId, undefined);
  assert.doesNotMatch(prior[0]?.formattedBody ?? "", /Past agent events/);
  assert.match(prior.at(-1)?.formattedBody ?? "", /Past agent events \(1\)/);
  resolvePrompt({ kind: "turn", stopReason: "end_turn" });
  await flush();
  clock.advanceBy(300);
  await completion;
  await bridge.stop();
});

void test("live Matrix retry reuses the transaction ID and keeps rooms independent", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeLiveMatrix();
  const resolvers: Array<(outcome: AcpOutcome) => void> = [];
  acp.promptImpl = () =>
    new Promise((resolve) => {
      resolvers.push(resolve);
    });
  let failed = false;
  matrix.htmlSend = async (message) => {
    if (!failed && message.roomId === ROOM_ONE) {
      failed = true;
      throw {
        failure: {
          kind: "transient",
          retryable: true,
          sdkRetryable: false,
          retryAfterMs: 0,
        },
      };
    }
    matrix.html.push(message);
    return message.targetEventId ?? `$live-${matrix.html.length}:example.org`;
  };
  const bridge = new BridgeCoordinator({
    config: config(),
    acp,
    matrix,
    clock,
    random: () => 0,
  });
  const one = bridge.handleTimelineEvent(event("$live-one:example.org", ROOM_ONE));
  const two = bridge.handleTimelineEvent(event("$live-two:example.org", ROOM_TWO));
  await waitFor(() => acp.promptCalls.length === 2);
  for (const call of acp.promptCalls) {
    acp.emit({
      sessionId: call.sessionId,
      kind: "agent_message_chunk",
      text: call.sessionId,
    });
    acp.emit({
      sessionId: call.sessionId,
      kind: "tool_call",
      toolCallId: "boundary",
      title: "read",
      toolKind: "read",
      status: "pending",
    });
  }
  await waitFor(() => matrix.attempts.length >= 2);
  clock.advanceBy(0);
  await waitFor(
    () =>
      matrix.html.some((message) => message.roomId === ROOM_ONE && message.body === acp.promptCalls[0]?.sessionId) &&
      matrix.html.some((message) => message.roomId === ROOM_TWO && message.body === acp.promptCalls[1]?.sessionId),
  );
  const attempts = matrix.attempts.filter((message) => message.roomId === ROOM_ONE);
  assert.ok(attempts.length >= 2);
  assert.equal(attempts[0]?.transactionId, attempts[1]?.transactionId);
  assert.equal(
    matrix.html.some((message) => message.roomId === ROOM_TWO),
    true,
  );
  for (const resolve of resolvers) resolve({ kind: "turn", stopReason: "end_turn" });
  await flush();
  clock.advanceBy(300);
  await Promise.all([one, two]);
  await bridge.stop();
});

void test("long live text splits at the Matrix limit without a duplicate final response", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeLiveMatrix();
  let resolvePrompt!: (outcome: AcpOutcome) => void;
  acp.promptImpl = () =>
    new Promise((resolve) => {
      resolvePrompt = resolve;
    });
  const bridge = new BridgeCoordinator({
    config: config({ maxMatrixMessageBytes: 800 }),
    acp,
    matrix,
    clock,
  });
  const completion = bridge.handleTimelineEvent(event("$long-live:example.org"));
  await waitFor(() => acp.promptCalls.length === 1);
  const sessionId = acp.promptCalls[0]!.sessionId;
  const answer = "α&<>🦋".repeat(400);
  for (const chunk of [answer.slice(0, 499), answer.slice(499, 1201), answer.slice(1201)]) {
    acp.emit({ sessionId, kind: "agent_message_chunk", text: chunk });
  }
  await flush();
  assert.equal(matrix.html.length, 0);
  resolvePrompt({ kind: "turn", stopReason: "end_turn" });
  await flush();
  clock.advanceBy(300);
  await completion;
  assert.equal(matrix.html.length > 1, true);
  assert.equal(matrix.html.map((message) => message.body).join(""), answer);
  for (const message of matrix.html) {
    const bytes = matrixHtmlContentBytes(message, message.targetEventId);
    assert.equal(bytes <= 800, true);
    assert.equal(message.targetEventId, undefined);
  }
  assert.equal(matrix.sent.length, 0);
  await bridge.stop();
});

void test("oversized activity truncates detail and rolls over before the encoded Matrix limit", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeLiveMatrix();
  let resolvePrompt!: (outcome: AcpOutcome) => void;
  acp.promptImpl = () =>
    new Promise((resolve) => {
      resolvePrompt = resolve;
    });
  const bridge = new BridgeCoordinator({
    config: config({ maxMatrixMessageBytes: 800 }),
    acp,
    matrix,
    clock,
  });
  const completion = bridge.handleTimelineEvent(event("$oversized-activity:example.org"));
  await waitFor(() => acp.promptCalls.length === 1);
  const sessionId = acp.promptCalls[0]!.sessionId;
  acp.emit({
    sessionId,
    kind: "agent_thought_chunk",
    messageId: "one",
    text: "<&".repeat(3000),
  });
  acp.emit({
    sessionId,
    kind: "agent_thought_chunk",
    messageId: "two",
    text: "second thought",
  });
  await waitFor(() => matrix.html.some((message) => message.body.includes("second thought")));
  assert.equal(
    matrix.html.some((message) => message.body.includes("(truncated)")),
    true,
  );
  resolvePrompt({ kind: "turn", stopReason: "end_turn", text: "done" });
  await flush();
  clock.advanceBy(300);
  await completion;
  for (const message of matrix.html) {
    assert.equal(matrixHtmlContentBytes(message, message.targetEventId) <= 800, true);
    // Activity also reserves enough space for a later edit with a long event ID.
    if (message.body !== "done") {
      assert.equal(matrixHtmlContentBytes(message, `$${"x".repeat(254)}`) <= 800, true);
    }
  }
  await bridge.stop();
});

void test("live timeout keeps partial text once and rejects late chunks in the next turn", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeLiveMatrix();
  const resolvers: Array<(outcome: AcpOutcome) => void> = [];
  acp.promptImpl = () =>
    new Promise((resolve) => {
      resolvers.push(resolve);
    });
  const bridge = new BridgeCoordinator({
    config: config({ maxTurnSeconds: 1 }),
    acp,
    matrix,
    clock,
  });
  const first = bridge.handleTimelineEvent(event("$live-timeout:example.org"));
  await waitFor(() => acp.promptCalls.length === 1);
  const sessionId = acp.promptCalls[0]!.sessionId;
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "first",
    text: "partial",
  });
  await flush();
  assert.equal(matrix.html.length, 0);
  clock.advanceBy(1000);
  assert.equal(acp.cancelCalls.length, 1);
  resolvers.shift()!({ kind: "turn", stopReason: "cancelled" });
  await first;
  assert.equal(matrix.html.filter((message) => message.body === "partial").length, 1);
  assert.equal(matrix.sent.at(-1)?.content.body, "[agent timed out]");
  const second = bridge.handleTimelineEvent(event("$live-after-timeout:example.org"));
  await waitFor(() => acp.promptCalls.length === 2);
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "first",
    text: "stale",
  });
  acp.emit({
    sessionId,
    kind: "agent_message_chunk",
    messageId: "second",
    text: "fresh",
  });
  await flush();
  assert.equal(
    matrix.html.some((message) => message.body === "fresh"),
    false,
  );
  resolvers.shift()!({ kind: "turn", stopReason: "end_turn" });
  await flush();
  clock.advanceBy(300);
  await second;
  assert.equal(matrix.html.filter((message) => message.body === "fresh").length, 1);
  assert.equal(
    matrix.html.some((message) => message.body.includes("stale")),
    false,
  );
  await bridge.stop();
});

void test("thread authorization gates session lookup, creation and loading for rejected events", async () => {
  const bridgeConfig = config();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  const sessionStore = new InMemorySessionStore();
  sessionStore.set({ roomId: ROOM_ONE, sessionId: "known-session" });
  let sessionLookups = 0;
  const get = sessionStore.getConversationRecord.bind(sessionStore);
  sessionStore.getConversationRecord = (identity) => {
    sessionLookups += 1;
    return get(identity);
  };
  const bridge = new BridgeCoordinator({
    config: bridgeConfig,
    acp,
    matrix,
    sessionStore,
    loadSession: true,
    authorizer: createInboundAuthorizer({
      ...bridgeConfig,
      matrix: { ...bridgeConfig.matrix, responseMode: "thread" },
    }),
  });
  const content = {
    msgtype: "m.text",
    body: "follow-up",
    "m.relates_to": { rel_type: "m.thread", event_id: "$known-root" },
  };
  const cases: Partial<InboundMatrixEvent>[] = [
    { sender: "@mallory:example.org" },
    { sender: bridgeConfig.matrix.userId },
    { roomId: "!not-allowed:example.org" },
    { isRedacted: true },
    { type: "m.room.redaction" },
    { content: { ...content, "m.relates_to": { rel_type: "m.thread", event_id: "invalid" } } },
    { content: { ...content, "m.relates_to": { rel_type: "m.replace", event_id: "$old" } } },
  ];
  try {
    for (const [index, overrides] of cases.entries()) {
      await bridge.handleTimelineEvent({ ...event(`$rejected-${index}`), content, ...overrides });
    }
    await flush();
    assert.equal(sessionLookups, 0);
    assert.equal(acp.sessionCount, 0);
    assert.deepEqual(acp.loadCalls, []);
    assert.deepEqual(acp.promptCalls, []);
    assert.deepEqual(matrix.sent, []);
    assert.equal(get({ kind: "room", roomId: ROOM_ONE })?.sessionId, "known-session");
  } finally {
    await bridge.stop();
  }
});

void test("validated thread routing survives eager text, activity retries and late archive edits", async () => {
  const transactionIds: string[] = [];
  for (const [roomId, root] of [
    [ROOM_ONE, "$root-one"],
    [ROOM_ONE, "$root-two"],
    [ROOM_TWO, "$root-one"],
  ]) {
    assert.ok(roomId && root);
    const clock = new FakeClock();
    const acp = new FakeAcp();
    const matrix = new FakeLiveMatrix();
    let resolvePrompt!: (outcome: AcpOutcome) => void;
    acp.promptImpl = () =>
      new Promise((resolve) => {
        resolvePrompt = resolve;
      });
    let first = true;
    matrix.htmlSend = async (message) => {
      if (first) {
        first = false;
        throw { failure: { kind: "transient", retryable: true, sdkRetryable: false, retryAfterMs: 0 } };
      }
      matrix.html.push(message);
      return message.targetEventId ?? `$live-${matrix.html.length}`;
    };
    const settings = config({ maxMatrixMessageBytes: 1400 });
    // Inject the foundation policy to exercise only the outbound boundary;
    // actual thread admission/session scheduling is the next ticket's scope.
    const bridge = new BridgeCoordinator({
      config: settings,
      acp,
      matrix,
      clock,
      random: () => 0,
      authorizer: createInboundAuthorizer({
        ...settings,
        matrix: { ...settings.matrix, responseMode: "thread" },
      }),
    });
    const inbound = {
      ...event("$shared-input", roomId),
      content: { msgtype: "m.text", body: "hello", "m.relates_to": { rel_type: "m.thread", event_id: root } },
    };
    const completion = bridge.handleTimelineEvent(inbound);
    await waitFor(() => acp.promptCalls.length === 1);
    const sessionId = acp.promptCalls[0]!.sessionId;
    acp.emit({ sessionId, kind: "tool_call", toolCallId: "late", title: "read", toolKind: "read", status: "pending" });
    await waitFor(() => matrix.attempts.length > 0);
    clock.advanceBy(0);
    await waitFor(() => matrix.html.length > 0);
    assert.deepEqual(matrix.attempts[0], matrix.attempts[1]);
    transactionIds.push(matrix.attempts[0]!.transactionId);
    acp.emit({ sessionId, kind: "agent_message_chunk", text: "<&😀".repeat(200) });
    acp.emit({ sessionId, kind: "agent_thought_chunk", text: "next thought" });
    await waitFor(() => matrix.html.some((message) => message.body.startsWith("<&😀")));
    acp.emit({
      sessionId,
      kind: "tool_call_update",
      toolCallId: "late",
      status: "completed",
      content: [{ type: "content", text: "late result" }],
    });
    await waitFor(() => matrix.html.some((message) => message.body.includes("late result")));
    const archived = matrix.html.find((message) => message.body.includes("late result"));
    assert.ok(archived?.targetEventId);
    assert.match(archived.formattedBody, /Past agent events/);
    resolvePrompt({ kind: "turn", stopReason: "end_turn" });
    await flush();
    clock.advanceBy(300);
    await completion;
    const text = matrix.html.filter((message) => /^(?:[<&]|😀)+$/u.test(message.body));
    assert.ok(text.length > 1);
    assert.equal(text.map((message) => message.body).join(""), "<&😀".repeat(200));
    for (const message of matrix.html) {
      assert.equal(message.threadRootEventId, root);
      assert.equal(message.threadFallbackEventId, "$shared-input");
      assert.ok(matrixHtmlContentBytes(message, message.targetEventId) <= 1400);
      const content = matrixHtmlContent(message, message.targetEventId);
      if (message.targetEventId === undefined) {
        assert.equal((content["m.relates_to"] as Record<string, unknown>).event_id, root);
      } else {
        assert.deepEqual(content["m.relates_to"], { rel_type: "m.replace", event_id: message.targetEventId });
        assert.equal(
          ((content["m.new_content"] as Record<string, unknown>)["m.relates_to"] as Record<string, unknown>).event_id,
          root,
        );
      }
    }
    assert.equal(matrix.sent.length, 0);
    await bridge.stop();
  }
  assert.equal(new Set(transactionIds).size, 3);
});

function threadConfig(overrides: Partial<BridgeConfig["limits"]> = {}): BridgeConfig {
  const settings = config(overrides);
  return { ...settings, matrix: { ...settings.matrix, responseMode: "thread" } };
}

function threadEvent(eventId: string, root: string, body = "follow-up", roomId = ROOM_ONE): InboundMatrixEvent {
  return {
    ...event(eventId, roomId, body),
    content: {
      msgtype: "m.text",
      body,
      "m.relates_to": {
        rel_type: "m.thread",
        event_id: root,
        is_falling_back: true,
        "m.in_reply_to": { event_id: "$different-fallback" },
      },
    },
  };
}

const methodError = (): AcpOutcome => ({ kind: "method_error", operation: "session_prompt", fatal: false });

function heldPrompts(acp: FakeAcp): Map<string, (outcome: AcpOutcome) => void> {
  const pending = new Map<string, (outcome: AcpOutcome) => void>();
  acp.promptImpl = async (_sessionId, text) => new Promise((resolve) => pending.set(text, resolve));
  return pending;
}

async function withThreadState(
  run: (store: Awaited<ReturnType<typeof openBridgeStateStore>>, stateDir: string) => Promise<void>,
): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-thread-runtime-"));
  try {
    const store = await openBridgeStateStore({
      stateDir,
      identity: {
        homeserver: config().matrix.homeserver,
        userId: config().matrix.userId,
        deviceId: config().matrix.deviceId,
      },
    });
    await store.establishInitialBaseline([]);
    await run(store, stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

void test("thread mode gives top-level messages independent sessions and follows the root rather than fallback", async () => {
  const acp = new FakeAcp();
  acp.promptImpl = async () => methodError();
  const matrix = new FakeMatrix();
  const bridge = new BridgeCoordinator({ config: threadConfig(), acp, matrix });
  await bridge.handleTimelineEvent(event("$root-a", ROOM_ONE, "first"));
  await bridge.handleTimelineEvent({
    ...event("$root-b", ROOM_ONE, "ordinary reply"),
    content: {
      msgtype: "m.text",
      body: "ordinary reply",
      "m.relates_to": { "m.in_reply_to": { event_id: "$root-a" } },
    },
  });
  await bridge.handleTimelineEvent(threadEvent("$follow-a", "$root-a"));
  await bridge.handleTimelineEvent(event("$root-a-other-room", ROOM_TWO));
  assert.deepEqual(
    acp.promptCalls.map(({ sessionId }) => sessionId),
    ["session-1", "session-2", "session-1", "session-3"],
  );
  assert.deepEqual(
    matrix.sent.map(({ threadRootEventId }) => threadRootEventId),
    ["$root-a", "$root-b", "$root-a", "$root-a-other-room"],
  );
  assert.equal(matrix.sent[2]?.threadFallbackEventId, "$follow-a");
  assert.equal(bridge.sessionForRoom(ROOM_ONE), undefined);
  assert.equal(matrix.receipts.length, 4);
  await bridge.stop();
});

void test("a quoted thread prompt ending in reset remains prompt text and preserves its session", async () => {
  const acp = new FakeAcp();
  acp.promptImpl = async () => methodError();
  const matrix = new FakeMatrix();
  const bridge = new BridgeCoordinator({ config: threadConfig(), acp, matrix });
  await bridge.handleTimelineEvent(event("$quote-root"));
  const body = "> Discuss this command\n\n/reset";
  await bridge.handleTimelineEvent(threadEvent("$quoted-reset", "$quote-root", body));
  await bridge.handleTimelineEvent(threadEvent("$after-quote", "$quote-root"));
  assert.equal(acp.promptCalls[1]?.text, body);
  assert.deepEqual(
    acp.promptCalls.map(({ sessionId }) => sessionId),
    ["session-1", "session-1", "session-1"],
  );
  assert.equal(
    matrix.sent.some(({ responseKind }) => responseKind === "reset"),
    false,
  );
  await bridge.stop();
});

void test("unknown threads and rejected roots never create context; top-level reset is unthreaded guidance", async () => {
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  const sessionStore = new InMemorySessionStore();
  const bridge = new BridgeCoordinator({ config: threadConfig({ maxInputBytes: 30 }), acp, matrix, sessionStore });
  await bridge.handleTimelineEvent(threadEvent("$unknown", "$absent"));
  await bridge.handleTimelineEvent(threadEvent("$unknown-reset", "$absent", "/reset"));
  await bridge.handleTimelineEvent(event("$too-large", ROOM_ONE, "x".repeat(31)));
  await bridge.handleTimelineEvent(threadEvent("$rejected-follow", "$too-large"));
  await bridge.handleTimelineEvent(event("$guidance", ROOM_ONE, "/reset"));
  await bridge.handleTimelineEvent(event("$guidance", ROOM_ONE, "/reset"));
  await bridge.handleTimelineEvent(event("$unauthorized-reset", ROOM_ONE, "/reset", "@mallory:example.org"));
  assert.deepEqual(
    matrix.sent.map(({ responseKind }) => responseKind),
    ["unknown_thread", "unknown_thread", "oversized", "unknown_thread", "thread_reset_guidance"],
  );
  assert.equal(matrix.sent[0]?.content.body, "Unknown thread agent session. Please start a new thread.");
  assert.equal(matrix.sent[4]?.content.body, "Use /reset inside a thread to reset its agent session.");
  assert.equal(matrix.sent[4]?.threadRootEventId, undefined);
  assert.equal(acp.sessionCount, 0);
  assert.equal(acp.loadCalls.length, 0);
  assert.equal(acp.promptCalls.length, 0);
  assert.deepEqual([...sessionStore.conversationEntries()], []);
  assert.equal(matrix.receipts.length, 5);
  await bridge.stop();
});

void test("each thread bounds only its waiting queue and selected permit waiters do not count", async () => {
  const acp = new FakeAcp();
  const pending = heldPrompts(acp);
  const matrix = new FakeMatrix();
  const bridge = new BridgeCoordinator({
    config: threadConfig({ maxConcurrentPrompts: 1, maxQueuedTurnsPerThread: 1, maxQueuedTurnsPerRoom: 1 }),
    acp,
    matrix,
  });
  const first = bridge.handleTimelineEvent(event("$queue-root-a", ROOM_ONE, "a1"));
  await waitFor(() => acp.promptCalls.length === 1);
  const a2 = bridge.handleTimelineEvent(threadEvent("$a2", "$queue-root-a", "a2"));
  await bridge.handleTimelineEvent(threadEvent("$a3", "$queue-root-a", "/reset"));
  assert.equal(matrix.sent.at(-1)?.responseKind, "busy");
  assert.equal(matrix.sent.at(-1)?.threadRootEventId, "$queue-root-a");
  const other = bridge.handleTimelineEvent(event("$queue-root-b", ROOM_ONE, "b1"));
  await waitFor(() => acp.sessionCount === 2);
  const b2 = bridge.handleTimelineEvent(threadEvent("$b2", "$queue-root-b", "b2"));
  assert.equal(bridge.getQueueDepth(ROOM_ONE), 2);
  assert.equal(bridge.snapshot.activeRooms, 1);
  assert.equal(bridge.unresolvedPromptCount, 1);
  pending.get("a1")?.(methodError());
  await first;
  await waitFor(() => acp.promptCalls.length === 2);
  assert.equal(acp.promptCalls[1]?.text, "b1");
  pending.get("b1")?.(methodError());
  await other;
  await waitFor(() => acp.promptCalls.length === 3);
  pending.get("a2")?.(methodError());
  await a2;
  await waitFor(() => acp.promptCalls.length === 4);
  pending.get("b2")?.(methodError());
  await b2;
  assert.deepEqual(
    acp.promptCalls.map(({ sessionId }) => sessionId),
    ["session-1", "session-2", "session-1", "session-2"],
  );
  await bridge.stop();
});

void test("session setup runs concurrently outside prompt permits and pending roots route follow-ups", async () => {
  const acp = new FakeAcp();
  const setups: Array<(session: AcpSession) => void> = [];
  acp.createSession = async () => {
    acp.sessionCount += 1;
    return new Promise((resolve) => setups.push(resolve));
  };
  const pending = heldPrompts(acp);
  const matrix = new FakeMatrix();
  const bridge = new BridgeCoordinator({ config: threadConfig({ maxConcurrentPrompts: 1 }), acp, matrix });
  const first = bridge.handleTimelineEvent(event("$pending-a", ROOM_ONE, "a1"));
  const second = bridge.handleTimelineEvent(event("$pending-b", ROOM_ONE, "b1"));
  await waitFor(() => setups.length === 2);
  const follow = bridge.handleTimelineEvent(threadEvent("$pending-follow", "$pending-a", "a2"));
  assert.equal(bridge.snapshot.queuedTurns, 1);
  assert.equal(bridge.unresolvedPromptCount, 0);
  assert.equal(matrix.sent.length, 0);
  setups[1]?.({ sessionId: "b" });
  await waitFor(() => acp.promptCalls.length === 1);
  const third = bridge.handleTimelineEvent(event("$pending-c", ROOM_ONE, "c1"));
  await waitFor(() => setups.length === 3);
  setups[0]?.({ sessionId: "a" });
  setups[2]?.({ sessionId: "c" });
  await flush();
  assert.equal(acp.promptCalls.length, 1);
  pending.get("b1")?.(methodError());
  await second;
  await waitFor(() => acp.promptCalls.length === 2);
  pending.get("a1")?.(methodError());
  await first;
  await waitFor(() => acp.promptCalls.length === 3);
  pending.get("c1")?.(methodError());
  await third;
  await waitFor(() => acp.promptCalls.length === 4);
  pending.get("a2")?.(methodError());
  await follow;
  assert.equal(acp.promptCalls[3]?.sessionId, "a");
  assert.equal(acp.sessionCount, 3);
  await bridge.stop();
});

void test("ordered thread reset and queue rejection leave other active threads and typing untouched", async () => {
  const acp = new FakeAcp();
  const pending = heldPrompts(acp);
  const matrix = new FakeMatrix();
  const bridge = new BridgeCoordinator({ config: threadConfig(), acp, matrix });
  const a = bridge.handleTimelineEvent(event("$reset-a", ROOM_ONE, "a"));
  const b = bridge.handleTimelineEvent(event("$reset-b", ROOM_ONE, "b"));
  await waitFor(() => acp.promptCalls.length === 2);
  const reset = bridge.handleTimelineEvent(threadEvent("$reset-control", "$reset-a", "/reset"));
  const follow = bridge.handleTimelineEvent(threadEvent("$after-reset", "$reset-a", "fresh"));
  await bridge.handleTimelineEvent(threadEvent("$known-oversized", "$reset-b", "x".repeat(1001)));
  assert.equal(
    bridge.sessionForConversation({ kind: "thread", roomId: ROOM_ONE, threadRootEventId: "$reset-b" }),
    "session-2",
  );
  assert.equal(
    matrix.sent.some(({ responseKind }) => responseKind === "reset"),
    false,
  );
  pending.get("a")?.(methodError());
  await a;
  await reset;
  await waitFor(() => acp.promptCalls.length === 3);
  assert.equal(acp.promptCalls[2]?.sessionId, "session-3");
  assert.equal(matrix.sent.find(({ responseKind }) => responseKind === "reset")?.threadRootEventId, "$reset-a");
  assert.equal(
    matrix.typing.some(({ isTyping }) => !isTyping),
    false,
  );
  assert.deepEqual(acp.cancelCalls, []);
  pending.get("fresh")?.(methodError());
  await follow;
  assert.equal(
    matrix.typing.some(({ isTyping }) => !isTyping),
    false,
  );
  pending.get("b")?.(methodError());
  await b;
  assert.equal(matrix.typing.filter(({ isTyping }) => !isTyping).length, 1);
  await bridge.stop();
});

void test("admitted setup is durable before prompt and reset remains known after restart without eager loading", async () => {
  await withThreadState(async (store, stateDir) => {
    const root = { kind: "thread", roomId: ROOM_ONE, threadRootEventId: "$durable-root" } as const;
    const other = { kind: "thread", roomId: ROOM_ONE, threadRootEventId: "$durable-other" } as const;
    await store.setConversationRecord({ ...other, sessionId: "retained-other" });
    await store.setSessionMapping(ROOM_ONE, "retained-room");
    const acp = new FakeAcp();
    let finishSetup!: (session: AcpSession) => void;
    acp.createSession = async () =>
      new Promise((resolve) => {
        finishSetup = resolve;
      });
    acp.promptImpl = async (sessionId) => {
      assert.equal(store.getConversationRecord(root)?.sessionId, sessionId);
      return methodError();
    };
    const matrix = new FakeMatrix();
    const bridge = new BridgeCoordinator({ config: threadConfig(), acp, matrix, stateStore: store, loadSession: true });
    const initial = bridge.handleTimelineEvent(event(root.threadRootEventId));
    await waitFor(() => finishSetup !== undefined);
    assert.deepEqual(store.getConversationRecord(root), root);
    const follow = bridge.handleTimelineEvent(threadEvent("$during-setup", root.threadRootEventId));
    finishSetup({ sessionId: "durable-session" });
    await Promise.all([initial, follow]);
    assert.deepEqual(acp.loadCalls, []);
    await bridge.handleTimelineEvent(threadEvent("$durable-reset", root.threadRootEventId, "/reset"));
    assert.deepEqual(store.getConversationRecord(root), root);
    assert.equal(store.getConversationRecord(other)?.sessionId, "retained-other");
    assert.equal(store.getSessionMapping(ROOM_ONE), "retained-room");
    await bridge.stop();

    const restoredStore = await openBridgeStateStore({
      stateDir,
      identity: {
        homeserver: config().matrix.homeserver,
        userId: config().matrix.userId,
        deviceId: config().matrix.deviceId,
      },
    });
    const restoredAcp = new FakeAcp();
    restoredAcp.promptImpl = async () => methodError();
    const restored = new BridgeCoordinator({
      config: threadConfig(),
      acp: restoredAcp,
      matrix: new FakeMatrix(),
      stateStore: restoredStore,
      loadSession: true,
    });
    assert.equal(restoredAcp.loadCalls.length, 0);
    await restored.handleTimelineEvent(threadEvent("$restart-follow", root.threadRootEventId));
    assert.equal(restoredAcp.sessionCount, 1);
    assert.deepEqual(restoredAcp.loadCalls, []);
    assert.equal(restoredStore.getConversationRecord(root)?.sessionId, "session-1");
    await restored.handleTimelineEvent(threadEvent("$restart-other", other.threadRootEventId));
    assert.deepEqual(restoredAcp.loadCalls, ["retained-other"]);
    assert.equal(restoredAcp.promptCalls[1]?.sessionId, "retained-other");
    await restored.stop();
  });
});

void test("healthy stale-thread recovery suppresses history and keeps every other session intact", async () => {
  await withThreadState(async (store) => {
    const a = { kind: "thread", roomId: ROOM_ONE, threadRootEventId: "$stale-a" } as const;
    const b = { kind: "thread", roomId: ROOM_ONE, threadRootEventId: "$stale-b" } as const;
    await store.setConversationRecord({ ...a, sessionId: "stale" });
    await store.setConversationRecord({ ...b, sessionId: "healthy" });
    const acp = new FakeAcp();
    acp.loadSessionImpl = async ({ sessionId }) => {
      acp.emit({ kind: "agent_message_chunk", sessionId, text: "private old history", messageId: "history" });
      if (sessionId === "stale") throw { kind: "method_error", operation: "session_load", fatal: false };
      return { sessionId };
    };
    acp.promptImpl = async () => methodError();
    const matrix = new FakeLiveMatrix();
    const bridge = new BridgeCoordinator({ config: threadConfig(), acp, matrix, stateStore: store, loadSession: true });
    await bridge.handleTimelineEvent(threadEvent("$stale-follow", a.threadRootEventId));
    assert.equal(store.getConversationRecord(a)?.sessionId, "session-1");
    assert.equal(store.getConversationRecord(b)?.sessionId, "healthy");
    await bridge.handleTimelineEvent(threadEvent("$healthy-follow", b.threadRootEventId));
    assert.deepEqual(acp.loadCalls, ["stale", "healthy"]);
    assert.equal(acp.promptCalls[1]?.sessionId, "healthy");
    assert.equal(JSON.stringify([...matrix.sent, ...matrix.html]).includes("private old history"), false);
    assert.equal(bridge.fatalError, undefined);
    await bridge.stop();
  });
});

void test("without load support prior threads become unknown but live reset identities remain usable", async () => {
  await withThreadState(async (store) => {
    const old = { kind: "thread", roomId: ROOM_ONE, threadRootEventId: "$no-load-old" } as const;
    await store.setConversationRecord({ ...old, sessionId: "unusable" });
    const acp = new FakeAcp();
    acp.promptImpl = async () => methodError();
    const matrix = new FakeMatrix();
    const bridge = new BridgeCoordinator({ config: threadConfig(), acp, matrix, stateStore: store });
    await bridge.handleTimelineEvent(threadEvent("$no-load-follow", old.threadRootEventId));
    assert.equal(matrix.sent.at(-1)?.responseKind, "unknown_thread");
    await bridge.handleTimelineEvent(event("$no-load-new"));
    await bridge.handleTimelineEvent(threadEvent("$no-load-reset", "$no-load-new", "/reset"));
    await bridge.handleTimelineEvent(threadEvent("$no-load-fresh", "$no-load-new"));
    assert.deepEqual(
      acp.promptCalls.map(({ sessionId }) => sessionId),
      ["session-1", "session-2"],
    );
    assert.deepEqual(store.getConversationRecords(), []);
    assert.deepEqual(acp.loadCalls, []);
    await bridge.stop();
  });
});

void test("healthy creation errors preserve admitted thread identity and allow retry without stopping another thread", async () => {
  await withThreadState(async (store) => {
    const acp = new FakeAcp();
    const create = acp.createSession.bind(acp);
    let rejectCreation = true;
    acp.createSession = async (options) => {
      if (rejectCreation) {
        rejectCreation = false;
        throw { kind: "method_error", operation: "session_new", fatal: false };
      }
      return create(options);
    };
    acp.promptImpl = async () => methodError();
    const matrix = new FakeMatrix();
    const bridge = new BridgeCoordinator({ config: threadConfig(), acp, matrix, stateStore: store, loadSession: true });
    await bridge.handleTimelineEvent(event("$failed-root"));
    assert.deepEqual(
      store.getConversationRecord({ kind: "thread", roomId: ROOM_ONE, threadRootEventId: "$failed-root" }),
      { kind: "thread", roomId: ROOM_ONE, threadRootEventId: "$failed-root" },
    );
    assert.equal(matrix.sent.at(-1)?.responseKind, "error");
    assert.equal(matrix.sent.at(-1)?.threadRootEventId, "$failed-root");
    assert.equal(bridge.fatalError, undefined);
    await bridge.handleTimelineEvent(event("$healthy-new-root"));
    await bridge.handleTimelineEvent(threadEvent("$retry-failed-root", "$failed-root"));
    assert.deepEqual(
      acp.promptCalls.map(({ sessionId }) => sessionId),
      ["session-1", "session-2"],
    );
    await bridge.stop();
  });
});

void test("thread session persistence failures cannot prompt or acknowledge reset", async () => {
  for (const operation of ["mapping", "reset"] as const) {
    const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-thread-fault-"));
    try {
      let failWrites = false;
      const store = await openBridgeStateStore({
        stateDir,
        identity: {
          homeserver: config().matrix.homeserver,
          userId: config().matrix.userId,
          deviceId: config().matrix.deviceId,
        },
        faultInjector: async (point) => {
          if (failWrites && point === "rename") throw new Error("private failure");
        },
      });
      await store.establishInitialBaseline([]);
      const identity = { kind: "thread", roomId: ROOM_ONE, threadRootEventId: "$fault-root" } as const;
      await store.setConversationRecord({ ...identity, ...(operation === "reset" ? { sessionId: "saved" } : {}) });
      const acp = new FakeAcp();
      const matrix = new FakeMatrix();
      const bridge = new BridgeCoordinator({
        config: threadConfig(),
        acp,
        matrix,
        stateStore: store,
        loadSession: true,
      });
      failWrites = true;
      await bridge.handleTimelineEvent(
        threadEvent("$fault-event", identity.threadRootEventId, operation === "reset" ? "/reset" : "prompt"),
      );
      assert.equal(bridge.fatalError?.code, "state");
      assert.equal(acp.promptCalls.length, 0);
      assert.equal(matrix.sent.length, 0);
      assert.equal(store.getConversationRecord(identity)?.sessionId, operation === "reset" ? "saved" : undefined);
      await bridge.stop();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});

void test("shutdown cancels active threads, drops their queues and never prompts late setup", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const pending = heldPrompts(acp);
  const create = acp.createSession.bind(acp);
  let finishSetup!: (session: AcpSession) => void;
  acp.createSession = async (options) => {
    if (acp.sessionCount < 2) return create(options);
    return new Promise((resolve) => {
      finishSetup = resolve;
    });
  };
  const matrix = new FakeMatrix();
  const bridge = new BridgeCoordinator({ config: threadConfig(), acp, matrix, clock });
  const a = bridge.handleTimelineEvent(event("$stop-a", ROOM_ONE, "a"));
  const b = bridge.handleTimelineEvent(event("$stop-b", ROOM_ONE, "b"));
  await waitFor(() => acp.promptCalls.length === 2);
  const queued = bridge.handleTimelineEvent(threadEvent("$stop-follow", "$stop-a"));
  const setup = bridge.handleTimelineEvent(event("$stop-setup", ROOM_ONE, "c"));
  await waitFor(() => finishSetup !== undefined);
  const stopped = bridge.stop();
  assert.deepEqual(acp.cancelCalls.sort(), ["session-1", "session-2"]);
  pending.get("a")?.(methodError());
  pending.get("b")?.(methodError());
  finishSetup({ sessionId: "late" });
  await Promise.all([a, b, queued, setup, stopped]);
  assert.equal(acp.promptCalls.length, 2);
  assert.equal(matrix.typing.filter(({ isTyping }) => !isTyping).length, 1);
  assert.equal(matrix.stopped, true);
  assert.equal(acp.closed, true);
  assert.equal(bridge.snapshot.queuedTurns, 0);
});

void test("thread prompt permits release before output drain while typing waits for the last active thread", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const pending = heldPrompts(acp);
  const matrix = new FakeMatrix();
  const bridge = new BridgeCoordinator({ config: threadConfig({ maxConcurrentPrompts: 1 }), acp, matrix, clock });
  const a = bridge.handleTimelineEvent(event("$drain-root-a", ROOM_ONE, "a"));
  const b = bridge.handleTimelineEvent(event("$drain-root-b", ROOM_ONE, "b"));
  await waitFor(() => acp.promptCalls.length === 1);
  pending.get("a")?.({ kind: "turn", stopReason: "end_turn", text: "answer a" });
  await waitFor(() => acp.promptCalls.length === 2);
  assert.equal(bridge.unresolvedPromptCount, 1);
  assert.equal(matrix.sent.length, 0);
  clock.advanceBy(300);
  await a;
  assert.equal(matrix.sent[0]?.threadRootEventId, "$drain-root-a");
  assert.equal(
    matrix.typing.some(({ isTyping }) => !isTyping),
    false,
  );
  clock.advanceBy(10_000);
  assert.equal(matrix.typing.at(-1)?.isTyping, true);
  pending.get("b")?.({ kind: "turn", stopReason: "end_turn", text: "answer b" });
  await flush();
  clock.advanceBy(300);
  await b;
  assert.equal(matrix.sent[1]?.threadRootEventId, "$drain-root-b");
  assert.equal(matrix.typing.at(-1)?.isTyping, false);
  await bridge.stop();
});

void test("simultaneous thread output isolates text splits, tools, thoughts and late archived edits", async () => {
  const acp = new FakeAcp();
  const pending = heldPrompts(acp);
  const matrix = new FakeLiveMatrix();
  const outputOwners = new Map<string, string | undefined>();
  matrix.htmlSend = async (message) => {
    matrix.html.push(message);
    const id = message.targetEventId ?? `$output-${matrix.html.length}`;
    if (message.targetEventId === undefined) outputOwners.set(id, message.threadRootEventId);
    return id;
  };
  const bridge = new BridgeCoordinator({
    config: threadConfig({ maxMatrixMessageBytes: 1600, maxActivityEventsPerMessage: 1 }),
    acp,
    matrix,
  });
  const a = bridge.handleTimelineEvent(event("$live-root-a", ROOM_ONE, "a"));
  const b = bridge.handleTimelineEvent(event("$live-root-b", ROOM_ONE, "b"));
  await waitFor(() => acp.promptCalls.length === 2);
  for (const [index, call] of acp.promptCalls.entries()) {
    acp.emit({
      kind: "tool_call",
      sessionId: call.sessionId,
      toolCallId: "shared-tool-id",
      title: `tool ${index}`,
      status: "pending",
    });
  }
  await waitFor(() => matrix.html.length >= 2);

  for (const [index, call] of acp.promptCalls.entries()) {
    acp.emit({
      kind: "agent_thought_chunk",
      sessionId: call.sessionId,
      messageId: "shared-thought-id",
      text: `thought ${index}`,
    });
    acp.emit({
      kind: "agent_message_chunk",
      sessionId: call.sessionId,
      messageId: "shared-text-id",
      text: `answer ${index} `.repeat(500),
    });
    acp.emit({
      kind: "agent_thought_chunk",
      sessionId: call.sessionId,
      messageId: "closing-thought",
      text: `closing ${index}`,
    });
    acp.emit({
      kind: "tool_call_update",
      sessionId: call.sessionId,
      toolCallId: "shared-tool-id",
      status: "completed",
      content: [{ type: "content", text: `late result ${index}` }],
    });
  }
  await waitFor(() => matrix.html.filter(({ body }) => body.includes("answer")).length >= 2);
  pending.get("a")?.(methodError());
  pending.get("b")?.(methodError());
  await Promise.all([a, b]);
  for (const [index, root] of ["$live-root-a", "$live-root-b"].entries()) {
    const messages = matrix.html.filter(({ threadRootEventId }) => threadRootEventId === root);
    assert.ok(messages.some(({ body }) => body.includes(`thought ${index}`)));
    assert.ok(messages.some(({ body }) => body.includes(`late result ${index}`)));
    assert.ok(messages.filter(({ body }) => body.includes(`answer ${index}`)).length > 1);
    assert.equal(
      messages.some(({ body }) => body.includes(`answer ${1 - index}`) || body.includes(`late result ${1 - index}`)),
      false,
    );
    for (const message of messages) {
      assert.equal(message.threadFallbackEventId, root);
      assert.ok(matrixHtmlContentBytes(message, message.targetEventId) <= 1600);
      if (message.targetEventId !== undefined) {
        assert.equal(outputOwners.get(message.targetEventId), root);
      }
    }
  }
  assert.equal(new Set(matrix.html.map(({ transactionId }) => transactionId)).size, matrix.html.length);
  assert.ok(
    matrix.sent.every(
      ({ threadRootEventId }) => threadRootEventId === "$live-root-a" || threadRootEventId === "$live-root-b",
    ),
  );
  await bridge.stop();
});

void test("a shared ACP setup transport failure is fatal across active threads and carries its root", async () => {
  const acp = new FakeAcp();
  const pending = heldPrompts(acp);
  const create = acp.createSession.bind(acp);
  acp.createSession = async (options) => {
    if (acp.sessionCount === 0) return create(options);
    throw { kind: "transport_error", operation: "session_new", fatal: true };
  };
  const matrix = new FakeMatrix();
  const bridge = new BridgeCoordinator({ config: threadConfig(), acp, matrix });
  const active = bridge.handleTimelineEvent(event("$fatal-active", ROOM_ONE, "active"));
  await waitFor(() => acp.promptCalls.length === 1);
  await bridge.handleTimelineEvent(event("$fatal-setup"));
  assert.equal(bridge.fatalError?.code, "acp_transport");
  assert.equal(matrix.sent.at(-1)?.threadRootEventId, "$fatal-setup");
  assert.deepEqual(acp.cancelCalls, ["session-1"]);
  pending.get("active")?.(methodError());
  await active;
  await bridge.stop();
});

void test("pending durable reset keeps follow-ups queued as known until state changes before acknowledgement", async () => {
  await withThreadState(async (store) => {
    const identity = { kind: "thread", roomId: ROOM_ONE, threadRootEventId: "$pending-reset-root" } as const;
    await store.setConversationRecord({ ...identity, sessionId: "old" });
    const originalReset = store.resetConversation.bind(store);
    let finishReset!: () => void;
    store.resetConversation = async (conversation) => {
      await new Promise<void>((resolve) => {
        finishReset = resolve;
      });
      return originalReset(conversation);
    };
    const acp = new FakeAcp();
    acp.promptImpl = async () => methodError();
    const matrix = new FakeMatrix();
    matrix.send = async (part) => {
      if (part.responseKind === "reset") assert.deepEqual(store.getConversationRecord(identity), identity);
      matrix.sent.push(part);
    };
    const bridge = new BridgeCoordinator({ config: threadConfig(), acp, matrix, stateStore: store, loadSession: true });
    const reset = bridge.handleTimelineEvent(threadEvent("$pending-reset", identity.threadRootEventId, "/reset"));
    await waitFor(() => finishReset !== undefined);
    const follow = bridge.handleTimelineEvent(threadEvent("$pending-reset-follow", identity.threadRootEventId));
    assert.equal(bridge.snapshot.queuedTurns, 1);
    assert.equal(matrix.sent.length, 0);
    assert.equal(acp.sessionCount, 0);
    finishReset();
    await Promise.all([reset, follow]);
    assert.deepEqual(
      matrix.sent.map(({ responseKind }) => responseKind),
      ["reset", "error"],
    );
    assert.equal(acp.promptCalls[0]?.sessionId, "session-1");
    assert.deepEqual(acp.loadCalls, []);
    await bridge.stop();
  });
});

void test("lazy thread loads may overlap an active prompt without consuming additional permits", async () => {
  await withThreadState(async (store) => {
    for (const root of ["$load-a", "$load-b"]) {
      await store.setConversationRecord({ kind: "thread", roomId: ROOM_ONE, threadRootEventId: root, sessionId: root });
    }
    const acp = new FakeAcp();
    const loads = new Map<string, () => void>();
    acp.loadSessionImpl = async ({ sessionId }) =>
      new Promise((resolve) => loads.set(sessionId, () => resolve({ sessionId })));
    const pending = heldPrompts(acp);
    const matrix = new FakeMatrix();
    const bridge = new BridgeCoordinator({
      config: threadConfig({ maxConcurrentPrompts: 1 }),
      acp,
      matrix,
      stateStore: store,
      loadSession: true,
    });
    const a = bridge.handleTimelineEvent(threadEvent("$load-follow-a", "$load-a", "a"));
    const b = bridge.handleTimelineEvent(threadEvent("$load-follow-b", "$load-b", "b"));
    await waitFor(() => acp.loadCalls.length === 2);
    assert.equal(bridge.unresolvedPromptCount, 0);
    assert.equal(matrix.typing.length, 0);
    loads.get("$load-a")?.();
    await waitFor(() => acp.promptCalls.length === 1);
    loads.get("$load-b")?.();
    await flush();
    assert.equal(bridge.unresolvedPromptCount, 1);
    assert.equal(acp.promptCalls.length, 1);
    assert.equal(acp.sessionCount, 0);
    pending.get("a")?.(methodError());
    await a;
    await waitFor(() => acp.promptCalls.length === 2);
    pending.get("b")?.(methodError());
    await b;
    assert.deepEqual(
      acp.promptCalls.map(({ sessionId }) => sessionId),
      ["$load-a", "$load-b"],
    );
    await bridge.stop();
  });
});

void test("mode switches resume only their retained records and removed rooms prune both kinds", async () => {
  await withThreadState(async (store) => {
    const thread = { kind: "thread", roomId: ROOM_ONE, threadRootEventId: "$mode-thread" } as const;
    await store.setConversationRecord({ ...thread, sessionId: "thread-session" });
    await store.setSessionMapping(ROOM_ONE, "room-session");
    await store.setSessionMapping(ROOM_TWO, "removed-room");
    await store.setConversationRecord({
      kind: "thread",
      roomId: ROOM_TWO,
      threadRootEventId: "$removed-thread",
      sessionId: "removed-thread",
    });
    for (const mode of ["thread", "room", "thread"] as const) {
      const settings = config();
      const acp = new FakeAcp();
      acp.promptImpl = async () => methodError();
      const bridge = new BridgeCoordinator({
        config: { ...settings, matrix: { ...settings.matrix, responseMode: mode, allowedRooms: [ROOM_ONE] } },
        acp,
        matrix: new FakeMatrix(),
        stateStore: store,
        loadSession: true,
      });
      await bridge.handleTimelineEvent(
        mode === "thread"
          ? threadEvent(`$mode-${mode}-${store.getConversationRecords().length}`, thread.threadRootEventId)
          : event("$mode-room"),
      );
      assert.deepEqual(acp.loadCalls, [mode === "thread" ? "thread-session" : "room-session"]);
      assert.equal(store.getConversationRecord(thread)?.sessionId, "thread-session");
      assert.equal(store.getSessionMapping(ROOM_ONE), "room-session");
      assert.equal(
        store.getConversationRecords().some(({ roomId }) => roomId === ROOM_TWO),
        false,
      );
      await bridge.stop();
    }
  });
});

void test("thread timeout cancels only its prompt, retains retry routing and leaves another thread typing", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const pending = heldPrompts(acp);
  const matrix = new FakeMatrix();
  const timeoutAttempts: RenderedMatrixPart[] = [];
  matrix.send = async (part) => {
    if (part.responseKind === "timeout") {
      timeoutAttempts.push(part);
      if (timeoutAttempts.length === 1) {
        throw { failure: { kind: "transient", retryable: true, sdkRetryable: false, retryAfterMs: 100 } };
      }
    }
    matrix.sent.push(part);
  };
  const bridge = new BridgeCoordinator({ config: threadConfig({ maxTurnSeconds: 1 }), acp, matrix, clock });
  const a = bridge.handleTimelineEvent(event("$timeout-root-a", ROOM_ONE, "a"));
  await waitFor(() => acp.promptCalls.length === 1);
  clock.advanceBy(500);
  const b = bridge.handleTimelineEvent(event("$timeout-root-b", ROOM_ONE, "b"));
  await waitFor(() => acp.promptCalls.length === 2);
  clock.advanceBy(500);
  assert.deepEqual(acp.cancelCalls, ["session-1"]);
  assert.equal(
    matrix.typing.some(({ isTyping }) => !isTyping),
    false,
  );
  pending.get("a")?.({ kind: "turn", stopReason: "cancelled", text: "partial a" });
  await waitFor(() => timeoutAttempts.length === 1);
  await flush();
  clock.advanceBy(100);
  await a;
  assert.equal(timeoutAttempts.length, 2);
  assert.equal(timeoutAttempts[0]?.transactionId, timeoutAttempts[1]?.transactionId);
  assert.ok(
    timeoutAttempts.every(
      ({ threadRootEventId, threadFallbackEventId }) =>
        threadRootEventId === "$timeout-root-a" && threadFallbackEventId === "$timeout-root-a",
    ),
  );
  assert.equal(matrix.sent[0]?.content.body, "partial a\n\n[agent timed out]");
  assert.equal(
    matrix.typing.some(({ isTyping }) => !isTyping),
    false,
  );
  pending.get("b")?.(methodError());
  await b;
  assert.deepEqual(acp.cancelCalls, ["session-1"]);
  assert.equal(matrix.typing.at(-1)?.isTyping, false);
  assert.equal(acp.promptCalls.length, 2);
  assert.equal(matrix.receipts.length, 2);
  await bridge.stop();
});
