import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BridgeCoordinator } from "./bridge.js";
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
    },
    acp: { cwd: "/tmp" },
    limits: {
      maxInputBytes: 1000,
      maxOutputBytes: 10_000,
      maxMatrixMessageBytes: 10_000,
      maxQueuedTurnsPerRoom: 1,
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

function event(
  eventId: string | undefined,
  roomId = ROOM_ONE,
  body = "hello",
  sender = SENDER,
): InboundMatrixEvent {
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
  readonly typing: Array<{ roomId: string; isTyping: boolean; timeoutMs: number }> = [];
  readonly receipts: Array<{ roomId: string; eventId: string }> = [];
  readonly operationOrder: string[] = [];
  intakeStopped = false;
  stopped = false;
  send: (part: RenderedMatrixPart) => Promise<void> = async (part) => {
    this.sent.push(part);
  };

  whoAmI(): Promise<MatrixIdentity> {
    return Promise.resolve({ userId: "@bridge:example.org", deviceId: "BRIDGE" });
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
  promptImpl: (
    sessionId: string,
    text: string,
    cancellation: CancellationSignal,
  ) => Promise<AcpOutcome> = async () => ({ kind: "turn", stopReason: "end_turn" });
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
  acp.promptImpl = async () => ({ kind: "turn", stopReason: "end_turn", text: "reinserted" });
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
  promptResults.shift()!({ kind: "method_error", operation: "session_prompt", fatal: false });
  await flush();
  assert.equal(acp.promptCalls.length, 2);
  promptResults.shift()!({ kind: "turn", stopReason: "end_turn", text: "two" });
  await flush();
  clock.advanceBy(300);
  await Promise.all([first, second]);
  assert.equal(matrix.sent.some((part) => part.content.body === "[agent error]"), true);
  assert.equal(matrix.sent.some((part) => part.content.body === "two"), true);
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

  resolvers.shift()!({ kind: "turn", stopReason: "end_turn", text: "answer one" });
  await flush();
  assert.equal(acp.promptCalls.length, 2);
  assert.equal(acp.promptCalls[1]?.text, "room two");
  assert.notEqual(acp.promptCalls[0]?.sessionId, acp.promptCalls[1]?.sessionId);
  resolvers.shift()!({ kind: "turn", stopReason: "end_turn", text: "answer two" });
  await flush();
  clock.advanceBy(300);
  await Promise.all([first, second]);
  assert.deepEqual(
    matrix.sent.map((part) => part.content.body).sort(),
    ["answer one", "answer two"],
  );
  await bridge.stop();
});

void test("correlates message IDs, drains trailing output, and ignores stale chunks", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  let resolvePrompt!: (outcome: AcpOutcome) => void;
  acp.promptImpl = () => new Promise<AcpOutcome>((resolve) => {
    resolvePrompt = resolve;
  });
  const bridge = new BridgeCoordinator({ config: config(), acp, matrix, clock });

  const completion = bridge.handleTimelineEvent(event("$turn:example.org"));
  await flush();
  const sessionId = acp.promptCalls[0]?.sessionId;
  assert.ok(sessionId);
  acp.emit({ sessionId, kind: "agent_message_chunk", messageId: "message-a", text: "one" });
  resolvePrompt({ kind: "turn", stopReason: "end_turn" });
  await flush();
  acp.emit({ sessionId, kind: "agent_message_chunk", messageId: "message-b", text: "two" });
  clock.advanceBy(300);
  await completion;
  assert.equal(matrix.sent[0]?.content.body, "one\n\ntwo");

  let secondResolve!: (outcome: AcpOutcome) => void;
  acp.promptImpl = () => new Promise<AcpOutcome>((resolve) => {
    secondResolve = resolve;
  });
  const second = bridge.handleTimelineEvent(event("$turn-two:example.org"));
  await flush();
  acp.emit({ sessionId, kind: "agent_message_chunk", messageId: "message-a", text: "stale" });
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
  acp.promptImpl = () => new Promise<AcpOutcome>((resolve) => {
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
  acp.promptImpl = () => new Promise<AcpOutcome>((resolve) => {
    resolvePrompt = resolve;
  });
  const bridge = new BridgeCoordinator({ config: config(), acp, matrix, clock });
  const fatal: FatalError[] = [];
  bridge.onFatalError((error) => fatal.push(error));

  const completion = bridge.handleTimelineEvent(event("$drain-cap:example.org"));
  await flush();
  const sessionId = acp.promptCalls[0]?.sessionId;
  assert.ok(sessionId);
  resolvePrompt({ kind: "turn", stopReason: "end_turn" });
  await flush();
  clock.advanceBy(29_900);
  acp.emit({ sessionId, kind: "agent_message_chunk", messageId: "changing", text: "first" });
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
      throw { failure: { kind: "transient", retryable: true, sdkRetryable: false } };
    }
    matrix.sent.push(part);
  };
  acp.promptImpl = async () => ({ kind: "turn", stopReason: "end_turn", text: "answer" });
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
  acp.promptImpl = async () => ({ kind: "turn", stopReason: "end_turn", text: "answer" });
  const bridge = new BridgeCoordinator({ config: config(), acp, matrix, clock });

  const completion = bridge.handleTimelineEvent(event("$typing:example.org"));
  await flush();
  assert.deepEqual(matrix.typing[0], { roomId: ROOM_ONE, isTyping: true, timeoutMs: 30_000 });
  clock.advanceBy(300);
  await completion;
  assert.equal(matrix.typing.at(-1)?.isTyping, false);
  assert.deepEqual(matrix.receipts, [{ roomId: ROOM_ONE, eventId: "$typing:example.org" }]);
  await bridge.stop();
});

void test("typing refreshes every 20 seconds through output drain and stops before delivery", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  let finishPrompt!: () => void;
  acp.promptImpl = async (sessionId) => new Promise<AcpOutcome>((resolve) => {
    finishPrompt = () => {
      acp.emit({ sessionId, kind: "agent_message_chunk", messageId: "answer", text: "answer" });
      resolve({ kind: "turn", stopReason: "end_turn" });
    };
  });
  const bridge = new BridgeCoordinator({ config: config(), acp, matrix, clock });

  const completion = bridge.handleTimelineEvent(event("$typing-cadence:example.org"));
  await waitFor(() => acp.promptCalls.length === 1);
  assert.deepEqual(matrix.typing, [{ roomId: ROOM_ONE, isTyping: true, timeoutMs: 30_000 }]);

  clock.advanceBy(19_999);
  assert.equal(matrix.typing.length, 1);
  clock.advanceBy(1);
  assert.deepEqual(matrix.typing.at(-1), { roomId: ROOM_ONE, isTyping: true, timeoutMs: 30_000 });

  finishPrompt();
  await flush();
  await flush();
  clock.advanceBy(300);
  await completion;

  assert.deepEqual(matrix.typing.map(({ isTyping }) => isTyping), [true, true, false]);
  assert.equal(matrix.operationOrder.indexOf("typing:off") < matrix.operationOrder.indexOf("message:agent"), true);
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
  await bridge.handleTimelineEvent(event("$receipt-unauthorized:example.org", ROOM_ONE, "hello", "@mallory:example.org"));
  await bridge.handleTimelineEvent(event("$receipt-self:example.org", ROOM_ONE, "hello", "@bridge:example.org"));
  await bridge.handleTimelineEvent({
    ...event("$receipt-unsupported:example.org"),
    type: "m.room.name",
  });
  await bridge.handleTimelineEvent({
    ...event("$receipt-malformed:example.org"),
    content: { msgtype: "m.text", body: "hello", "m.relates_to": { "m.replace": { event_id: "$old" } } },
  });
  // eslint-disable-next-line unicorn/no-useless-undefined -- omitted event IDs are explicit test input
  await bridge.handleTimelineEvent(event(undefined));
  assert.deepEqual(matrix.receipts, [{ roomId: ROOM_ONE, eventId: "$receipt-ordinary:example.org" }]);
  assert.deepEqual(matrix.typing.map(({ isTyping }) => isTyping), [true, false]);
  await bridge.stop();

  const oversizedAcp = new FakeAcp();
  const oversizedMatrix = new FakeMatrix();
  const oversizedBridge = new BridgeCoordinator({
    config: config({ maxInputBytes: 3 }),
    acp: oversizedAcp,
    matrix: oversizedMatrix,
  });
  await oversizedBridge.handleTimelineEvent(event("$receipt-oversized:example.org", ROOM_ONE, "long"));
  assert.deepEqual(oversizedMatrix.receipts, [{
    roomId: ROOM_ONE,
    eventId: "$receipt-oversized:example.org",
  }]);
  assert.equal(oversizedMatrix.typing.length, 0);
  assert.equal(oversizedAcp.promptCalls.length, 0);
  await oversizedBridge.stop();

  const busyAcp = new FakeAcp();
  const busyMatrix = new FakeMatrix();
  const busyResolvers: Array<(outcome: AcpOutcome) => void> = [];
  busyAcp.promptImpl = async () => new Promise<AcpOutcome>((resolve) => {
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
  assert.equal(busyMatrix.receipts.some(({ eventId }) => eventId === "$receipt-busy-three:example.org"), true);
  busyResolvers.shift()?.({ kind: "method_error", operation: "session_prompt", fatal: false });
  await busyFirst;
  await waitFor(() => busyAcp.promptCalls.length === 2);
  busyResolvers.shift()?.({ kind: "method_error", operation: "session_prompt", fatal: false });
  await busySecond;
  assert.deepEqual(busyMatrix.typing.map(({ isTyping }) => isTyping), [true, false, true, false]);
  await busyBridge.stop();
});

void test("typing and receipt failures are sanitized, nonfatal, and never retried independently", async () => {
  const records: Array<{ level: string; event: string; fields: Readonly<Record<string, unknown>> | undefined }> = [];
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
  const bridge = new BridgeCoordinator({ config: config(), acp, matrix, diagnostics });

  await bridge.handleTimelineEvent(event("$ephemeral-failure:example.org"));
  assert.equal(matrix.sent[0]?.responseKind, "error");
  assert.equal(bridge.fatalError, undefined);
  assert.equal(records.length, 3);
  assert.equal(records.every(({ event }) => event === "typing-operation-failed" || event === "receipt-operation-failed"), true);
  assert.equal(records.some(({ fields }) => JSON.stringify(fields).includes("response body")), false);
  await bridge.stop();
});

void test("timeout stops typing immediately while ACP cancellation is pending", async () => {
  const clock = new FakeClock();
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  let finishPrompt!: () => void;
  acp.promptImpl = async () => new Promise<AcpOutcome>((resolve) => {
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
  assert.deepEqual(matrix.typing.map(({ isTyping }) => isTyping), [true, false]);
  assert.deepEqual(acp.cancelCalls, ["session-1"]);

  finishPrompt();
  await completion;
  assert.deepEqual(matrix.typing.map(({ isTyping }) => isTyping), [true, false]);
  await bridge.stop();
});

void test("fatal and graceful shutdown cleanup both turn typing off", async () => {
  for (const mode of ["fatal", "shutdown"] as const) {
    const clock = new FakeClock();
    const acp = new FakeAcp();
    const matrix = new FakeMatrix();
    acp.promptImpl = async () => new Promise<AcpOutcome>(() => {
      // Keep the prompt unresolved so cleanup, rather than normal rendering,
      // is responsible for ending the typing indicator.
    });
    const bridge = new BridgeCoordinator({ config: config(), acp, matrix, clock });
    void bridge.handleTimelineEvent(event(`$typing-${mode}:example.org`));
    await waitFor(() => acp.promptCalls.length === 1);

    const stopping = mode === "fatal"
      ? (() => {
          acp.emitFatal({ code: "acp_transport", message: "ACP failed" });
          return bridge.stop();
        })()
      : bridge.stop();
    assert.deepEqual(matrix.typing.map(({ isTyping }) => isTyping), [true, false]);
    clock.advanceBy(1000);
    await stopping;
  }
});

void test("queued, semaphore-blocked, loading, and omitted catch-up events never type", async () => {
  const queuedAcp = new FakeAcp();
  const queuedMatrix = new FakeMatrix();
  const queuedResolvers: Array<(outcome: AcpOutcome) => void> = [];
  queuedAcp.promptImpl = async () => new Promise<AcpOutcome>((resolve) => {
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
  assert.deepEqual(queuedMatrix.typing.map(({ isTyping }) => isTyping), [true]);
  queuedResolvers.shift()?.({ kind: "method_error", operation: "session_prompt", fatal: false });
  await first;
  await waitFor(() => queuedAcp.promptCalls.length === 2);
  queuedResolvers.shift()?.({ kind: "method_error", operation: "session_prompt", fatal: false });
  await second;
  await queuedBridge.stop();

  const semaphoreAcp = new FakeAcp();
  const semaphoreMatrix = new FakeMatrix();
  const semaphoreResolvers: Array<(outcome: AcpOutcome) => void> = [];
  semaphoreAcp.promptImpl = async () => new Promise<AcpOutcome>((resolve) => {
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
  assert.deepEqual(semaphoreMatrix.typing.map(({ isTyping }) => isTyping), [true]);
  semaphoreResolvers.shift()?.({ kind: "method_error", operation: "session_prompt", fatal: false });
  await permitHolder;
  await waitFor(() => semaphoreAcp.promptCalls.length === 2);
  semaphoreResolvers.shift()?.({ kind: "method_error", operation: "session_prompt", fatal: false });
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
    loadingAcp.loadSessionImpl = async () => new Promise<AcpSession>((resolve) => {
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
    assert.deepEqual(loadingMatrix.typing.map(({ isTyping }) => isTyping), [true, false]);
    await loadingEvent;
    await loadingBridge.stop();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }

  const catchupAcp = new FakeAcp();
  const catchupMatrix = new FakeMatrix();
  let finishCatchup!: (outcome: AcpOutcome) => void;
  catchupAcp.promptImpl = async () => new Promise<AcpOutcome>((resolve) => {
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
  assert.deepEqual(catchupMatrix.typing.map(({ isTyping }) => isTyping), [true]);
  assert.equal(catchupMatrix.receipts.some(({ eventId }) => eventId === "$catchup-omitted:example.org"), false);
  finishCatchup({ kind: "method_error", operation: "session_prompt", fatal: false });
  await catchupFirst;
  await waitFor(() => catchupAcp.promptCalls.length === 2);
  finishCatchup({ kind: "method_error", operation: "session_prompt", fatal: false });
  await catchupQueued;
  await catchupBridge.stop();
});

void test("exact reset is queued as a control and the next prompt creates a fresh session", async () => {
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  acp.promptImpl = async () => ({ kind: "turn", stopReason: "end_turn", text: "fresh" });
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

  const ordinaryBodies = [
    "/reset ",
    " /reset",
    "/reset argument",
    "/reset\n",
    "//reset",
    "> quoted\n\n/reset",
  ];
  for (const [index, body] of ordinaryBodies.entries()) {
    await bridge.handleTimelineEvent(event(`$ordinary-reset-${index}:example.org`, ROOM_ONE, body));
  }
  await bridge.handleTimelineEvent(event("$unauthorized-reset:example.org", ROOM_ONE, "/reset", "@mallory:example.org"));
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
  assert.deepEqual(acp.promptCalls.map(({ text }) => text), ordinaryBodies);
  assert.equal(matrix.sent.some((part) => part.content.body === "Agent session reset."), true);
  assert.equal(typingAfterReset, 0);
  assert.equal(
    matrix.receipts.filter(({ eventId }) => eventId === "$reply-reset:example.org").length,
    1,
  );
  assert.equal(matrix.receipts.some(({ eventId }) => eventId === "$unauthorized-reset:example.org"), false);
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
  assert.equal(matrix.sent.some((part) => part.responseKind === "busy"), true);
  assert.equal(acp.promptCalls.some(({ text }) => text === "/reset"), false);

  resolveFirst({ kind: "method_error", operation: "session_prompt", fatal: false });
  await Promise.all([first, earlierQueued, reset]);
  assert.deepEqual(acp.promptCalls.map(({ text }) => text), ["first", "earlier queued"]);
  assert.equal(matrix.sent.some((part) => part.content.body === "Agent session reset."), true);

  const afterReset = bridge.handleTimelineEvent(event("$ordered-after-reset:example.org", ROOM_ONE, "after reset"));
  await afterReset;
  assert.deepEqual(acp.promptCalls.map(({ text }) => text), ["first", "earlier queued", "after reset"]);
  assert.notEqual(acp.promptCalls[0]?.sessionId, acp.promptCalls[2]?.sessionId);
  await bridge.stop();
});

void test("reset bypasses a saturated global prompt permit", async () => {
  const acp = new FakeAcp();
  const matrix = new FakeMatrix();
  let resolvePrompt!: (outcome: AcpOutcome) => void;
  acp.promptImpl = async () => new Promise<AcpOutcome>((resolve) => {
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

  resolvePrompt({ kind: "method_error", operation: "session_prompt", fatal: false });
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
      throw { failure: { kind: "transient", retryable: true, sdkRetryable: false } };
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
    throw { failure: { kind: "permanent", retryable: false, sdkRetryable: false } };
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
    acp.promptImpl = async () => ({ kind: "turn", stopReason: "end_turn", text: "loaded answer" });
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
    acp.promptImpl = async () => ({ kind: "turn", stopReason: "end_turn", text: "new answer" });
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
    assert.deepEqual(acp.loadOptions, [{
      cwd: "/tmp",
      mcpServers: [],
      sessionId: "saved-session",
    }]);
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
    const diagnostics: Array<{ level: string; event: string; fields: Readonly<Record<string, unknown>> | undefined }> = [];
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
      return { kind: "method_error", operation: "session_load", fatal: false } as unknown as AcpSession;
    };
    acp.promptImpl = async () => ({ kind: "turn", stopReason: "end_turn", text: "replacement" });
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
    assert.equal(diagnostics.some((entry) => JSON.stringify(entry.fields).includes("stale-session")), false);
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
    acp.promptImpl = async (_sessionId, text) => ({ kind: "turn", stopReason: "end_turn", text });
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
