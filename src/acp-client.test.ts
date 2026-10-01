import assert from "node:assert/strict";
import test from "node:test";

import {
  createAcpClient,
  ACP_ACTIVITY_UPDATE_MAX_BYTES,
  type AcpClient,
  type AcpSteeringOutcome,
  type AcpToolCallUpdate,
  type AcpAgentThoughtChunk,
} from "./acp-client.js";
import { AcpActivityModel } from "./acp-activity.js";
import { renderAcpActivity } from "./acp-activity-rendering.js";
import { createCancellationController } from "./cancellation.js";
import type { DiagnosticSink, FatalError } from "./diagnostics.js";
import { FakeClock } from "./test-support/fake-clock.js";

const CWD = "/srv/agent-workspace";
const INIT_OPTIONS = {
  protocolVersion: 1 as const,
  capabilities: { filesystem: false as const, terminal: false as const },
};

interface FakeInput {
  readonly stream: ReadableStream<Uint8Array>;
  push(value: unknown): void;
  close(): void;
  fail(error?: unknown): void;
}

function createFakeInput(): FakeInput {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
    },
  });
  return {
    stream,
    push(value) {
      const text = typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
      controller?.enqueue(encoder.encode(text));
    },
    close() {
      controller?.close();
    },
    fail(error = new Error("fake input failed")) {
      controller?.error(error);
    },
  };
}

interface FakeOutput {
  readonly stream: WritableStream<Uint8Array>;
  readonly frames: unknown[];
  nextFrame(): Promise<Record<string, unknown>>;
}

function createFakeOutput(): FakeOutput {
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: unknown[] = [];
  const waiters: Array<(frame: Record<string, unknown>) => void> = [];

  const consume = (): void => {
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.trim().length === 0) {
        continue;
      }
      const frame = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter === undefined) {
        frames.push(frame);
      } else {
        waiter(frame);
      }
    }
  };

  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      consume();
    },
  });

  return {
    stream,
    frames,
    nextFrame() {
      const queued = frames.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued as Record<string, unknown>);
      }
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(resolve);
          if (index !== -1) {
            waiters.splice(index, 1);
          }
          reject(new Error("timed out waiting for ACP frame"));
        }, 1000);
        waiters.push((frame) => {
          clearTimeout(timeout);
          resolve(frame);
        });
      });
    },
  };
}

function createDiagnostics(): DiagnosticSink {
  return {
    emit() {
      // Test diagnostics are intentionally discarded.
    },
    debug() {
      // no-op
    },
    info() {
      // no-op
    },
    warn() {
      // no-op
    },
    error() {
      // no-op
    },
  };
}

function rpcResponse(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcNotification(method: string, parameters: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", method, params: parameters };
}

function rpcRequest(id: unknown, method: string, parameters: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, params: parameters };
}

function assertProtocolFrame(frame: Record<string, unknown>): void {
  assert.equal(frame.jsonrpc, "2.0");
  assert.ok(typeof frame.method === "string" || "result" in frame || "error" in frame);
}

function fatalSignal(client: AcpClient): {
  readonly errors: FatalError[];
  readonly done: Promise<FatalError>;
} {
  const errors: FatalError[] = [];
  // eslint-disable-next-line unicorn/consistent-function-scoping -- resolver is test-local state
  let resolveDone: (error: FatalError) => void = () => {};
  const done = new Promise<FatalError>((resolve) => {
    resolveDone = resolve;
  });
  client.onFatalError((error) => {
    errors.push(error);
    resolveDone(error);
  });
  return { errors, done };
}

async function initialize(
  client: AcpClient,
  input: FakeInput,
  output: FakeOutput,
  // eslint-disable-next-line unicorn/no-object-as-default-parameter -- test helper defaults mirror ACP responses
  result: Record<string, unknown> = { protocolVersion: 1 },
): Promise<void> {
  const promise = client.initialize(INIT_OPTIONS);
  const frame = await output.nextFrame();
  assert.deepEqual(frame.params, {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  input.push(rpcResponse(frame.id, result));
  await promise;
}

async function createSession(
  client: AcpClient,
  input: FakeInput,
  output: FakeOutput,
  // eslint-disable-next-line unicorn/no-object-as-default-parameter -- test helper defaults mirror ACP responses
  result: Record<string, unknown> = { sessionId: "session-1" },
): Promise<string> {
  const promise = client.createSession({
    cwd: "/caller-supplied-cwd",
    mcpServers: [],
  });
  const frame = await output.nextFrame();
  assert.deepEqual(frame.params, { cwd: CWD, mcpServers: [] });
  input.push(rpcResponse(frame.id, result));
  const session = await promise;
  return session.sessionId;
}

function newClient(input: FakeInput, output: FakeOutput, extra: Record<string, unknown> = {}): AcpClient {
  return createAcpClient({
    cwd: CWD,
    input: input.stream,
    output: output.stream,
    diagnostics: createDiagnostics(),
    ...extra,
  } as Parameters<typeof createAcpClient>[0]);
}

function steer(client: AcpClient, sessionId: string, text: string, timeoutMs = 1000): Promise<AcpSteeringOutcome> {
  if (client.steer === undefined) throw new Error("production client must implement steering");
  return client.steer(sessionId, text, timeoutMs);
}

void test("binds exact ACP v1 initialize and lazy session/new requests", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);

  assert.equal(output.frames.length, 0);
  await initialize(client, input, output);
  const sessionId = await createSession(client, input, output);
  assert.equal(sessionId, "session-1");

  for (const frame of output.frames) {
    assertProtocolFrame(frame as Record<string, unknown>);
  }
  await client.close();
});

void test("retains the agent loadSession capability while defaulting absent capabilities to false", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);

  const initializePromise = client.initialize(INIT_OPTIONS);
  const frame = await output.nextFrame();
  input.push(
    rpcResponse(frame.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    }),
  );
  assert.deepEqual(await initializePromise, {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  });
  assert.deepEqual(await client.initialize(INIT_OPTIONS), {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  });

  const secondInput = createFakeInput();
  const secondOutput = createFakeOutput();
  const secondClient = newClient(secondInput, secondOutput);
  const secondInitialize = secondClient.initialize(INIT_OPTIONS);
  const secondFrame = await secondOutput.nextFrame();
  secondInput.push(rpcResponse(secondFrame.id, { protocolVersion: 1 }));
  assert.deepEqual(await secondInitialize, {
    protocolVersion: 1,
    agentCapabilities: {},
  });

  await client.close();
  await secondClient.close();
});

void test("loads a saved ACP session with the configured cwd and suppresses raw method failures", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  await initialize(client, input, output, {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  });
  if (client.loadSession === undefined) {
    throw new Error("loadSession capability was not installed");
  }
  const phases: string[] = [];
  client.onSessionPhase?.((change) => phases.push(`${change.sessionId}:${change.phase}`));
  const loading = client.loadSession({
    cwd: "/caller-supplied-cwd",
    mcpServers: [],
    sessionId: "saved-session",
  });
  const frame = await output.nextFrame();
  assert.equal(frame.method, "session/load");
  assert.deepEqual(frame.params, {
    sessionId: "saved-session",
    cwd: CWD,
    mcpServers: [],
  });
  input.push(rpcResponse(frame.id, {}));
  assert.deepEqual(await loading, { sessionId: "saved-session" });
  assert.deepEqual(phases, ["saved-session:loading", "saved-session:ready"]);
  await client.close();
});

void test("classifies a healthy session/load method error without poisoning transport", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  await initialize(client, input, output, {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  });
  if (client.loadSession === undefined) {
    throw new Error("loadSession capability was not installed");
  }
  const fatal = fatalSignal(client);
  const loading = client.loadSession({
    cwd: CWD,
    mcpServers: [],
    sessionId: "stale-session",
  });
  const frame = await output.nextFrame();
  input.push({
    jsonrpc: "2.0",
    id: frame.id,
    error: { code: -32_000, message: "stale session" },
  });
  await assert.rejects(loading, (error: unknown) => {
    assert.deepEqual(error, {
      kind: "method_error",
      operation: "session_load",
      fatal: false,
    });
    return true;
  });
  assert.equal(fatal.errors.length, 0);
  await client.close();
});

void test("rejects a non-v1 negotiated version and emits one protocol fatal", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  const fatal = fatalSignal(client);

  const initializePromise = client.initialize(INIT_OPTIONS);
  const frame = await output.nextFrame();
  input.push(rpcResponse(frame.id, { protocolVersion: 2 }));

  await assert.rejects(initializePromise, (error: unknown) => {
    assert.deepEqual(error, {
      kind: "protocol_error",
      operation: "initialize",
      fatal: true,
    });
    return true;
  });
  await fatal.done;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fatal.errors.length, 1);
  assert.equal(fatal.errors[0]?.code, "acp_protocol");
  await client.close();
});

void test("maps text and ignored updates and joins distinct message IDs", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  await initialize(client, input, output);
  const sessionId = await createSession(client, input, output);
  const updates: unknown[] = [];
  client.onUpdate((update) => updates.push(update));

  const prompt = client.prompt(sessionId, "hello", {
    cancelled: false,
    reason: undefined,
    onCancel() {
      return () => {};
    },
  });
  const promptFrame = await output.nextFrame();
  assert.deepEqual(promptFrame.params, {
    sessionId,
    prompt: [{ type: "text", text: "hello" }],
  });
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello " },
        messageId: "message-1",
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends one ordered protocol frame
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "world" },
        messageId: "message-1",
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends one ordered protocol frame
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "next" },
        messageId: "message-2",
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends one ordered protocol frame
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "hidden" },
        messageId: "thought-1",
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends one ordered protocol frame
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "AA==", mimeType: "image/png" },
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends one ordered protocol frame
  input.push(rpcResponse(promptFrame.id, { stopReason: "end_turn" }));

  const outcome = await prompt;
  assert.deepEqual(outcome, {
    kind: "turn",
    stopReason: "end_turn",
    text: "hello world\n\nnext",
  });
  assert.deepEqual(updates, [
    {
      sessionId,
      kind: "agent_message_chunk",
      text: "hello ",
      messageId: "message-1",
    },
    {
      sessionId,
      kind: "agent_message_chunk",
      text: "world",
      messageId: "message-1",
    },
    {
      sessionId,
      kind: "agent_message_chunk",
      text: "next",
      messageId: "message-2",
    },
    {
      sessionId,
      kind: "agent_thought_chunk",
      text: "hidden",
      messageId: "thought-1",
    },
  ]);
  await client.close();
});

void test("preserves bounded thought and tool activity with optional fields and pi terminal metadata", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  await initialize(client, input, output);
  const sessionId = await createSession(client, input, output);
  const updates: unknown[] = [];
  client.onUpdate((update) => updates.push(update));
  const prompt = client.prompt(sessionId, "hello", {
    cancelled: false,
    reason: undefined,
    onCancel() {
      return () => {};
    },
  });
  const frame = await output.nextFrame();
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought",
        content: { type: "text", text: "thinking" },
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends one ordered protocol frame
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        kind: "edit",
        status: "pending",
        title: "write",
        rawInput: { path: "/tmp/example", content: "x".repeat(20_000) },
        locations: [{ path: "/tmp/example", line: 3 }],
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends one ordered protocol frame
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        content: [{ type: "diff", path: "/tmp/example", oldText: null, newText: "new" }],
        _meta: {
          terminal_output: { terminal_id: "terminal-1", data: "ok" },
          terminal_exit: {
            terminal_id: "terminal-1",
            exit_code: 0,
            signal: null,
          },
        },
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends one ordered protocol frame
  input.push(rpcResponse(frame.id, { stopReason: "end_turn" }));
  await prompt;
  assert.deepEqual(updates[0], {
    sessionId,
    kind: "agent_thought_chunk",
    messageId: "thought",
    text: "thinking",
  });
  assert.deepEqual(updates[1], {
    sessionId,
    kind: "tool_call",
    toolCallId: "tool-1",
    title: "write",
    toolKind: "edit",
    status: "pending",
    rawInput: { path: "/tmp/example", content: "x".repeat(20_000) },
    locations: [{ path: "/tmp/example", line: 3 }],
  });
  assert.deepEqual(updates[2], {
    sessionId,
    kind: "tool_call_update",
    toolCallId: "tool-1",
    status: "completed",
    content: [{ type: "diff", path: "/tmp/example", oldText: null, newText: "new" }],
    terminalOutput: { terminalId: "terminal-1", data: "ok" },
    terminalExit: { terminalId: "terminal-1", exitCode: 0, signal: null },
  });
  await client.close();
});

void test("client activity remains Unicode-safe and visibly truncated through rendering", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  await initialize(client, input, output);
  const sessionId = await createSession(client, input, output);
  const model = new AcpActivityModel();
  client.onUpdate((update) => model.accept(update));
  const prompt = client.prompt(sessionId, "hello", {
    cancelled: false,
    reason: undefined,
    onCancel() {
      return () => {};
    },
  });
  const frame = await output.nextFrame();
  const push = (update: unknown) => input.push(rpcNotification("session/update", { sessionId, update }));
  push({
    sessionUpdate: "agent_thought_chunk",
    messageId: "thought",
    content: { type: "text", text: `${"a".repeat(8190)}😀tail` },
  });
  push({
    sessionUpdate: "agent_thought_chunk",
    messageId: "thought",
    content: { type: "text", text: "later thought" },
  });
  push({
    sessionUpdate: "tool_call",
    toolCallId: "tool",
    title: "read",
    kind: "read",
  });
  push({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool",
    status: "completed",
    content: [
      {
        type: "content",
        content: { type: "text", text: `${"b".repeat(8190)}😀tail` },
      },
    ],
  });
  push({
    sessionUpdate: "tool_call",
    toolCallId: "many",
    title: "read",
    kind: "read",
  });
  push({
    sessionUpdate: "tool_call_update",
    toolCallId: "many",
    status: "completed",
    content: Array.from({ length: 33 }, (_, index) => ({
      type: "content",
      content: { type: "text", text: String(index) },
    })),
  });
  input.push(rpcResponse(frame.id, { stopReason: "end_turn" }));
  await prompt;
  assert.equal(model.events.length, 3);
  const [thought, tool, many] = model.events;
  assert.ok(thought && tool && many);
  for (const event of [thought, tool, many]) {
    const rendered = renderAcpActivity(event);
    assert.match(rendered.body, /\(truncated\)/u);
    assert.match(rendered.formattedBody, /\(truncated\)/u);
    assert.doesNotMatch(rendered.body, /�/u);
  }
  assert.equal(thought.type, "thought");
  assert.equal(tool.type, "tool");
  assert.equal(many.type, "tool");
  if (thought.type === "thought") {
    assert.equal(Buffer.byteLength(thought.text, "utf8"), 8192);
    assert.ok(thought.text.startsWith("a".repeat(8190)));
  }
  if (tool.type === "tool")
    assert.equal(tool.content?.[0]?.type === "content" && tool.content[0].text, "b".repeat(8190));
  if (many.type === "tool") assert.equal(many.contentCut, true);
  await client.close();
});

void test("large terminal notification preserves the first and last UTF-8 bytes", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  await initialize(client, input, output);
  const sessionId = await createSession(client, input, output);
  const updates: unknown[] = [];
  client.onUpdate((update) => updates.push(update));
  const prompt = client.prompt(sessionId, "hello", {
    cancelled: false,
    reason: undefined,
    onCancel() {
      return () => {};
    },
  });
  const frame = await output.nextFrame();
  const data = `FIRST_OUTPUT${"😀".repeat(100_000)}LAST_OUTPUT`;
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        _meta: { terminal_output: { data } },
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends one ordered protocol frame
  input.push(rpcResponse(frame.id, { stopReason: "end_turn" }));
  await prompt;
  const terminal = (updates[0] as AcpToolCallUpdate).terminalOutput;
  assert.equal(terminal?.originalBytes, Buffer.byteLength(data, "utf8"));
  assert.ok(Buffer.byteLength(terminal?.data ?? "", "utf8") <= ACP_ACTIVITY_UPDATE_MAX_BYTES);
  assert.match(terminal?.data ?? "", /^FIRST_OUTPUT/u);
  assert.match(terminal?.data ?? "", /LAST_OUTPUT$/u);
  assert.doesNotMatch(terminal?.data ?? "", /�/u);
  await client.close();
});

void test("activity ingestion keeps substantial output and shares one budget across fields", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  await initialize(client, input, output);
  const sessionId = await createSession(client, input, output);
  const updates: AcpToolCallUpdate[] = [];
  const thoughts: AcpAgentThoughtChunk[] = [];
  client.onUpdate((update) => {
    if (update.kind === "tool_call" || update.kind === "tool_call_update") updates.push(update);
    if (update.kind === "agent_thought_chunk") thoughts.push(update);
  });
  const prompt = client.prompt(sessionId, "hello", {
    cancelled: false,
    reason: undefined,
    onCancel() {
      return () => {};
    },
  });
  const frame = await output.nextFrame();
  const text = "😀".repeat(16_384);
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "small",
        title: "read",
        kind: "read",
        content: [{ type: "content", content: { type: "text", text } }],
        _meta: { terminal_output: { data: text } },
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends ordered protocol frames
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "large",
        title: "edit",
        kind: "edit",
        locations: [{ path: "file" }],
        content: [
          { type: "diff", path: "file", oldText: text, newText: text },
          { type: "content", content: { type: "text", text } },
        ],
        _meta: { terminal_output: { data: text } },
        rawInput: { code: text },
        rawOutput: { content: [{ text }] },
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends ordered protocol frames
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "large",
        rawInput: { code: text.repeat(3) },
        rawOutput: { text: text.repeat(3) },
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends ordered protocol frames
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: "😀".repeat(ACP_ACTIVITY_UPDATE_MAX_BYTES / 4),
        },
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends ordered protocol frames
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: `${"a".repeat(ACP_ACTIVITY_UPDATE_MAX_BYTES - 1)}😀`,
        },
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends ordered protocol frames
  input.push(rpcResponse(frame.id, { stopReason: "end_turn" }));
  await prompt;
  const [small, large] = updates;
  assert.ok(small && large);
  assert.equal(small.content?.[0]?.type === "content" && small.content[0].text, text);
  assert.equal(small.activityCut, undefined);
  assert.equal(small.terminalOutput?.data, text);
  assert.equal(small.terminalOutput?.originalBytes, undefined);
  assert.equal(large.activityCut, true);
  const strings = [
    large.toolCallId,
    large.title,
    large.toolKind,
    large.locations?.[0]?.path,
    large.terminalOutput?.data,
  ];
  for (const item of large.content ?? []) {
    if (item.type === "content") strings.push(item.text);
    if (item.type === "diff") strings.push(item.path, item.oldText ?? "", item.newText);
  }
  const retainedBytes = strings.reduce((sum, value) => sum + Buffer.byteLength(value ?? "", "utf8"), 0);
  assert.ok(retainedBytes <= ACP_ACTIVITY_UPDATE_MAX_BYTES);
  assert.ok(retainedBytes > 8192);
  assert.ok(large.rawInput === undefined || JSON.stringify(large.rawInput) === "{}");
  assert.ok(large.rawOutput === undefined || JSON.stringify(large.rawOutput) === "{}");
  assert.doesNotMatch(strings.join(""), /�/u);
  const raw = updates[2]!;
  assert.ok(raw.rawInput && typeof raw.rawInput === "object" && !Array.isArray(raw.rawInput));
  assert.ok(raw.rawOutput && typeof raw.rawOutput === "object" && !Array.isArray(raw.rawOutput));
  const rawInput = raw.rawInput as { code: string };
  const rawOutput = raw.rawOutput as { text: string };
  assert.equal(rawInput.code, text.repeat(3));
  assert.ok(Buffer.byteLength(rawOutput.text, "utf8") < Buffer.byteLength(text.repeat(3), "utf8"));
  assert.ok(
    Buffer.byteLength(rawInput.code + rawOutput.text + "codetextlarge", "utf8") <= ACP_ACTIVITY_UPDATE_MAX_BYTES,
  );
  assert.equal(raw.activityCut, true);
  assert.doesNotMatch(rawOutput.text, /�/u);
  assert.equal(Buffer.byteLength(thoughts[0]!.text, "utf8"), ACP_ACTIVITY_UPDATE_MAX_BYTES);
  assert.equal(thoughts[0]!.textCut, undefined);
  assert.equal(Buffer.byteLength(thoughts[1]!.text, "utf8"), ACP_ACTIVITY_UPDATE_MAX_BYTES - 1);
  assert.equal(thoughts[1]!.textCut, true);
  assert.doesNotMatch(thoughts[1]!.text, /�/u);
  const model = new AcpActivityModel();
  model.accept(small);
  assert.match(renderAcpActivity(model.events[0]!).body, /\(truncated\)/u);
  await client.close();
});

void test("malformed optional activity fields do not escape into updates or diagnostics", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const diagnostics: unknown[] = [];
  const client = newClient(input, output, {
    diagnostics: {
      ...createDiagnostics(),
      emit(_level: unknown, _event: unknown, fields: unknown) {
        diagnostics.push(fields);
      },
    },
  });
  await initialize(client, input, output);
  const sessionId = await createSession(client, input, output);
  const updates: unknown[] = [];
  client.onUpdate((update) => updates.push(update));
  const prompt = client.prompt(sessionId, "hello", {
    cancelled: false,
    reason: undefined,
    onCancel() {
      return () => {};
    },
  });
  const frame = await output.nextFrame();
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-2",
        title: 8,
        status: false,
        content: [
          { type: "diff", path: 4 },
          { type: "content", content: { type: "image", data: "private" } },
        ],
        locations: [{ path: 3 }],
        rawInput: { invalid: undefined },
        _meta: {
          terminal_output: { data: 9 },
          terminal_exit: { exit_code: "private" },
        },
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends one ordered protocol frame
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-3",
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends one ordered protocol frame
  input.push(rpcResponse(frame.id, { stopReason: "end_turn" }));
  await prompt;
  assert.deepEqual(updates, [
    {
      sessionId,
      kind: "tool_call_update",
      toolCallId: "tool-2",
      content: [],
      locations: [],
      rawInput: {},
      terminalExit: {},
    },
    { sessionId, kind: "tool_call_update", toolCallId: "tool-3" },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("private"), false);
  await client.close();
});

void test("ignores agent text updates before a prompt while preserving later prompt text", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  await initialize(client, input, output);
  const sessionId = await createSession(client, input, output);
  const updates: unknown[] = [];
  client.onUpdate((update) => updates.push(update));

  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "startup history" },
        messageId: "startup-message",
      },
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, []);

  const prompt = client.prompt(sessionId, "hello", {
    cancelled: false,
    reason: undefined,
    onCancel() {
      return () => {};
    },
  });
  const promptFrame = await output.nextFrame();
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "answer" },
        messageId: "answer-message",
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends one ordered protocol frame
  input.push(rpcResponse(promptFrame.id, { stopReason: "end_turn" }));

  assert.deepEqual(await prompt, {
    kind: "turn",
    stopReason: "end_turn",
    text: "answer",
  });
  assert.deepEqual(updates, [
    {
      sessionId,
      kind: "agent_message_chunk",
      text: "answer",
      messageId: "answer-message",
    },
  ]);
  await client.close();
});

void test("suppresses a session startup prelude that races the first prompt", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  await initialize(client, input, output);
  const sessionId = await createSession(client, input, output, {
    sessionId: "session-1",
    _meta: { piAcp: { startupInfo: "startup prelude" } },
  });
  const updates: unknown[] = [];
  client.onUpdate((update) => updates.push(update));

  const prompt = client.prompt(sessionId, "hello", {
    cancelled: false,
    reason: undefined,
    onCancel() {
      return () => {};
    },
  });
  const promptFrame = await output.nextFrame();
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "startup prelude" },
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends one ordered protocol frame
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "actual " },
        messageId: "answer-message",
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends one ordered protocol frame
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "prompt text" },
        messageId: "answer-message",
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- FakeInput.push sends one ordered protocol frame
  input.push(rpcResponse(promptFrame.id, { stopReason: "end_turn" }));

  assert.deepEqual(await prompt, {
    kind: "turn",
    stopReason: "end_turn",
    text: "actual prompt text",
  });
  assert.deepEqual(updates, [
    {
      sessionId,
      kind: "agent_message_chunk",
      text: "actual ",
      messageId: "answer-message",
    },
    {
      sessionId,
      kind: "agent_message_chunk",
      text: "prompt text",
      messageId: "answer-message",
    },
  ]);
  await client.close();
});

for (const timing of ["before", "during"] as const) {
  void test(`routes pi-acp notifications to diagnostics ${timing} prompts in independent sessions`, async () => {
    const input = createFakeInput();
    const output = createFakeOutput();
    const diagnostics: unknown[] = [];
    const client = newClient(input, output, {
      diagnostics: {
        ...createDiagnostics(),
        emit(level: string, event: string, fields: unknown) {
          diagnostics.push({ level, event, fields });
        },
      },
    });
    await initialize(client, input, output);
    const updates: unknown[] = [];
    client.onUpdate((update) => updates.push(update));
    const banner = "MCP: 2 servers connected (48 tools)";
    const notices = [
      { level: "info", text: banner },
      { level: "warning", text: "private authentication warning" },
      { level: "error", text: "private connection failure" },
    ];
    for (const sessionId of ["thread-1", "thread-2"]) {
      await createSession(client, input, output, { sessionId });
      const sendNotices = (): void => {
        for (const notice of notices) {
          input.push(
            rpcNotification("session/update", {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: notice.text },
                _meta: { piAcp: { notify: { level: notice.level } } },
              },
            }),
          );
        }
      };
      if (timing === "before") {
        sendNotices();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const prompt = client.prompt(sessionId, "hello", {
        cancelled: false,
        reason: undefined,
        onCancel() {
          return () => {};
        },
      });
      const frame = await output.nextFrame();
      if (timing === "during") sendNotices();
      // Identical, untagged assistant text must survive; never filter by text.
      input.push(
        rpcNotification("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: banner },
            _meta: { piAcp: { notify: "not a notification marker" } },
          },
        }),
      );
      // eslint-disable-next-line unicorn/no-array-push-push -- ordered protocol frames
      input.push(rpcResponse(frame.id, { stopReason: "end_turn" }));
      assert.deepEqual(await prompt, { kind: "turn", stopReason: "end_turn", text: banner });
    }
    assert.deepEqual(
      updates,
      ["thread-1", "thread-2"].map((sessionId) => ({
        sessionId,
        kind: "agent_message_chunk",
        text: banner,
      })),
    );
    assert.deepEqual(
      diagnostics,
      ["thread-1", "thread-2"].flatMap((sessionId) =>
        ["info", "warn", "error"].map((level) => ({
          level,
          event: "acp-extension-notification",
          fields: { sessionId },
        })),
      ),
    );
    assert.equal(JSON.stringify(diagnostics).includes("private"), false);
    await client.close();
  });
}

void test("returns healthy-transport prompt errors without poisoning the connection", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  const fatal = fatalSignal(client);
  await initialize(client, input, output);
  const sessionId = await createSession(client, input, output);

  const failedPrompt = client.prompt(sessionId, "first", {
    cancelled: false,
    reason: undefined,
    onCancel() {
      return () => {};
    },
  });
  const failedFrame = await output.nextFrame();
  input.push({
    jsonrpc: "2.0",
    id: failedFrame.id,
    error: { code: -32_000, message: "agent secret must not escape" },
  });
  assert.deepEqual(await failedPrompt, {
    kind: "method_error",
    operation: "session_prompt",
    fatal: false,
  });
  assert.equal(fatal.errors.length, 0);

  const healthyPrompt = client.prompt(sessionId, "second", {
    cancelled: false,
    reason: undefined,
    onCancel() {
      return () => {};
    },
  });
  const healthyFrame = await output.nextFrame();
  input.push(rpcResponse(healthyFrame.id, { stopReason: "end_turn" }));
  assert.deepEqual(await healthyPrompt, {
    kind: "turn",
    stopReason: "end_turn",
  });
  await client.close();
});

void test("auto-selects allow_always, falls back to allow_once, and cancels otherwise", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  await initialize(client, input, output);
  const sessionId = await createSession(client, input, output);

  const permission = (id: number, options: unknown[]) => {
    input.push(
      rpcRequest(id, "session/request_permission", {
        sessionId,
        toolCall: { toolCallId: `tool-${id}` },
        options,
      }),
    );
  };
  const always = {
    optionId: "always",
    name: "Always",
    kind: "allow_always",
  };
  const once = {
    optionId: "once",
    name: "Once",
    kind: "allow_once",
  };

  permission(10, [once, always]);
  assert.deepEqual((await output.nextFrame()).result, {
    outcome: { outcome: "selected", optionId: "always" },
  });
  permission(11, [once]);
  assert.deepEqual((await output.nextFrame()).result, {
    outcome: { outcome: "selected", optionId: "once" },
  });
  permission(12, [{ optionId: "reject", name: "Reject", kind: "reject_once" }]);
  assert.deepEqual((await output.nextFrame()).result, {
    outcome: { outcome: "cancelled" },
  });
  await client.close();
});

void test("cancellation sends session/cancel and preserves the cancelled stop reason", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  await initialize(client, input, output);
  const sessionId = await createSession(client, input, output);
  let cancelListener: ((reason?: string) => void) | undefined;
  const cancellation = {
    cancelled: false,
    reason: undefined,
    onCancel(listener: (reason?: string) => void) {
      cancelListener = listener;
      return () => {};
    },
  };

  const prompt = client.prompt(sessionId, "stop", cancellation);
  const promptFrame = await output.nextFrame();
  cancelListener?.("test cancellation");
  const cancelFrame = await output.nextFrame();
  assert.deepEqual(cancelFrame, {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId },
  });
  input.push(rpcResponse(promptFrame.id, { stopReason: "cancelled" }));
  assert.deepEqual(await prompt, { kind: "turn", stopReason: "cancelled" });
  await client.close();
});

void test("close answers pending permission requests with cancelled", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  // eslint-disable-next-line unicorn/consistent-function-scoping -- resolver is test-local state
  let markHandlerStarted: () => void = () => {};
  const handlerStarted = new Promise<void>((resolve) => {
    markHandlerStarted = resolve;
  });
  const client = createAcpClient({
    cwd: CWD,
    input: input.stream,
    output: output.stream,
    diagnostics: createDiagnostics(),
    permissionHandler: async (_request, cancellation) =>
      new Promise((resolve) => {
        markHandlerStarted();
        cancellation.onCancel(() => resolve("allow_once"));
      }),
  });
  await initialize(client, input, output);
  input.push(
    rpcRequest(20, "session/request_permission", {
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-20" },
      options: [{ optionId: "once", name: "Once", kind: "allow_once" }],
    }),
  );

  await handlerStarted;
  await client.close();
  const response = output.frames.find((frame) => (frame as Record<string, unknown>).id === 20) as
    Record<string, unknown> | undefined;
  assert.deepEqual(response?.result, { outcome: { outcome: "cancelled" } });
});

void test("EOF, malformed NDJSON, malformed JSON-RPC, and stream failures each signal once", async () => {
  const cases: Array<{
    readonly name: string;
    readonly trigger: (input: FakeInput) => void;
    readonly code: FatalError["code"];
  }> = [
    {
      name: "EOF",
      trigger: (input) => input.close(),
      code: "acp_transport",
    },
    {
      name: "malformed NDJSON",
      trigger: (input) => input.push("not-json\n"),
      code: "acp_protocol",
    },
    {
      name: "malformed JSON-RPC",
      trigger: (input) => input.push({ jsonrpc: "2.0", id: 1 }),
      code: "acp_protocol",
    },
    {
      name: "unknown response ID",
      trigger: (input) => input.push({ jsonrpc: "2.0", id: 1, result: {} }),
      code: "acp_protocol",
    },
    {
      name: "read failure",
      trigger: (input) => input.fail(),
      code: "acp_transport",
    },
  ];

  for (const current of cases) {
    const input = createFakeInput();
    const output = createFakeOutput();
    const client = newClient(input, output);
    const fatal = fatalSignal(client);
    current.trigger(input);
    const error = await fatal.done;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(error.code, current.code, current.name);
    assert.equal(fatal.errors.length, 1, current.name);
    await client.close();
  }
});

void test("a writable stream failure is fatal and diagnostics never enter stdout", async () => {
  const input = createFakeInput();
  let writes = 0;
  const output = new WritableStream<Uint8Array>({
    write() {
      writes += 1;
      throw new Error("secret output failure");
    },
  });
  const client = createAcpClient({
    cwd: CWD,
    input: input.stream,
    output,
    diagnostics: createDiagnostics(),
  });
  const fatal = fatalSignal(client);
  await assert.rejects(client.initialize(INIT_OPTIONS));
  const error = await fatal.done;
  assert.equal(error.code, "acp_transport");
  assert.equal(writes, 1);
  await client.close();
});

void test("steering capability requires strictly true initialize metadata and preserves loadSession", async () => {
  const metadata: unknown[] = [
    undefined,
    null,
    false,
    1,
    "steering",
    [],
    {},
    { steering: null },
    { steering: [] },
    { steering: true },
    { steering: {} },
    { steering: { supported: false } },
    { steering: { supported: "true" } },
    { steering: { supported: 1 } },
    { steering: { supported: null } },
    { steering: { supported: true, unrelated: "ignored" }, unrelated: true },
  ];
  for (const [index, value] of metadata.entries()) {
    const input = createFakeInput();
    const output = createFakeOutput();
    const client = newClient(input, output);
    const fatal = fatalSignal(client);
    const initializing = client.initialize(INIT_OPTIONS);
    const frame = await output.nextFrame();
    const loadSession = index % 2 === 0;
    input.push(
      rpcResponse(frame.id, {
        protocolVersion: 1,
        // Advertising steering in agentCapabilities must not enable the extension.
        agentCapabilities: { loadSession, steering: true },
        ...(value === undefined ? {} : { _meta: value }),
      }),
    );
    const expected = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession,
        ...(index === metadata.length - 1 ? { steering: true } : {}),
      },
    };
    assert.deepEqual(await initializing, expected, `metadata case ${index}`);
    assert.deepEqual(await client.initialize(INIT_OPTIONS), expected);
    assert.equal(fatal.errors.length, 0);
    await client.close();
  }
});

void test("steering replies concurrently on its own wire ID and preserves prompt text, activity and cancellation", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const clock = new FakeClock();
  const client = newClient(input, output, { clock });
  const fatal = fatalSignal(client);
  await initialize(client, input, output, { protocolVersion: 1, _meta: { steering: { supported: true } } });
  const sessionId = await createSession(client, input, output);
  const cancellation = createCancellationController();
  const updates: unknown[] = [];
  client.onUpdate((update) => updates.push(update));
  let promptSettled = false;
  const prompt = client.prompt(sessionId, "original", cancellation.signal).then((outcome) => {
    promptSettled = true;
    return outcome;
  });
  const promptFrame = await output.nextFrame();
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "original-message",
        content: { type: "text", text: "before " },
      },
    }),
  );
  const steering = steer(client, sessionId, "adjust\nwith Unicode: 🧭", 2000);
  const frame = await output.nextFrame();
  assert.notEqual(frame.id, promptFrame.id);
  assert.deepEqual(frame, {
    jsonrpc: "2.0",
    id: frame.id,
    method: "_session/steering",
    params: {
      sessionId,
      prompt: [{ type: "text", text: "adjust\nwith Unicode: 🧭" }],
      _meta: { steering: { idleBehavior: "promptRequired" } },
    },
  });
  input.push(rpcResponse(frame.id, { outcome: "injected", _meta: { unrelated: "ignored" } }));
  assert.deepEqual(await steering, { kind: "steering", outcome: "injected" });
  assert.equal(promptSettled, false);
  assert.equal(clock.pendingTimerCount, 0);
  assert.equal(output.frames.length, 0);
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "original-tool",
        title: "read",
        status: "pending",
      },
    }),
  );
  // eslint-disable-next-line unicorn/no-array-push-push -- distinct ordered ACP frames
  input.push(
    rpcNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "original-message",
        content: { type: "text", text: "after" },
      },
    }),
  );
  cancellation.cancel("original turn cancelled");
  assert.deepEqual(await output.nextFrame(), { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  input.push(rpcResponse(promptFrame.id, { stopReason: "cancelled" }));
  assert.deepEqual(await prompt, { kind: "turn", stopReason: "cancelled", text: "before after" });
  assert.equal(updates.length, 3);
  assert.equal((updates[1] as { kind: string }).kind, "tool_call");
  assert.equal(fatal.errors.length, 0);
  await client.close();
});

void test("idle opt-in promptRequired returns a decision without automatically sending a prompt", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  await initialize(client, input, output);
  const sessionId = await createSession(client, input, output);
  const steering = steer(client, sessionId, "idle");
  const frame = await output.nextFrame();
  assert.equal(frame.method, "_session/steering");
  assert.deepEqual(frame.params, {
    sessionId,
    prompt: [{ type: "text", text: "idle" }],
    _meta: { steering: { idleBehavior: "promptRequired" } },
  });
  input.push(rpcResponse(frame.id, { outcome: "promptRequired", reason: "noRunningTurn", extra: true }));
  assert.deepEqual(await steering, { kind: "steering", outcome: "promptRequired", reason: "noRunningTurn" });
  assert.equal(output.frames.length, 0);
  await client.close();
});

void test("a prompt may finish before steering without losing the outstanding steering decision", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  await initialize(client, input, output);
  const sessionId = await createSession(client, input, output);
  const prompt = client.prompt(sessionId, "original", createCancellationController().signal);
  const promptFrame = await output.nextFrame();
  let steeringSettled = false;
  const steering = steer(client, sessionId, "boundary").then((outcome) => {
    steeringSettled = true;
    return outcome;
  });
  const frame = await output.nextFrame();
  input.push(rpcResponse(promptFrame.id, { stopReason: "end_turn" }));
  assert.deepEqual(await prompt, { kind: "turn", stopReason: "end_turn" });
  assert.equal(steeringSettled, false);
  input.push(rpcResponse(frame.id, { outcome: "promptRequired", reason: "noRunningTurn" }));
  assert.deepEqual(await steering, { kind: "steering", outcome: "promptRequired", reason: "noRunningTurn" });
  assert.equal(output.frames.length, 0);
  await client.close();
});

void test("healthy steering errors distinguish method-not-found, preserve the prompt and redact raw errors", async () => {
  for (const code of [-32_603, -32_602, -32_601, -32_000]) {
    const input = createFakeInput();
    const output = createFakeOutput();
    const clock = new FakeClock();
    const diagnostics: unknown[] = [];
    const client = newClient(input, output, {
      clock,
      diagnostics: {
        ...createDiagnostics(),
        emit(...values: unknown[]) {
          diagnostics.push(values);
        },
      },
    });
    const fatal = fatalSignal(client);
    await initialize(client, input, output);
    const sessionId = await createSession(client, input, output);
    const prompt = client.prompt(sessionId, "original", createCancellationController().signal);
    const promptFrame = await output.nextFrame();
    const steering = steer(client, sessionId, "private-steering-input");
    const frame = await output.nextFrame();
    input.push({
      jsonrpc: "2.0",
      id: frame.id,
      error: {
        code,
        message: "private-steering-error",
        data: { secret: "private-steering-data" },
      },
    });
    assert.deepEqual(await steering, {
      kind: "method_error",
      operation: "session_steering",
      fatal: false,
      methodNotFound: code === -32_601,
    });
    assert.equal(fatal.errors.length, 0);
    assert.equal(clock.pendingTimerCount, 0);
    assert.equal(JSON.stringify(diagnostics).includes("private-steering"), false);
    assert.equal(output.frames.length, 0);
    input.push(
      rpcNotification("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "intact" },
        },
      }),
    );
    // eslint-disable-next-line unicorn/no-array-push-push -- distinct ordered ACP frames
    input.push(rpcResponse(promptFrame.id, { stopReason: "end_turn" }));
    assert.deepEqual(await prompt, { kind: "turn", stopReason: "end_turn", text: "intact" });
    // The same transport remains usable even when its extension was unavailable.
    assert.equal(await createSession(client, input, output), "session-1");
    await client.close();
  }
});

void test("malformed, unknown and detached steering outcomes fail closed without redelivery", async () => {
  const results: unknown[] = [
    null,
    [],
    "injected",
    1,
    {},
    { outcome: null },
    { outcome: "unknown-private-outcome" },
    { outcome: "promptRequired" },
    { outcome: "promptRequired", reason: "unknown" },
    { outcome: "promptRequired", reason: null },
    { outcome: "startedNewTurn" },
  ];
  for (const result of results) {
    const input = createFakeInput();
    const output = createFakeOutput();
    const clock = new FakeClock();
    const diagnostics: unknown[] = [];
    const client = newClient(input, output, {
      clock,
      diagnostics: {
        ...createDiagnostics(),
        emit(...values: unknown[]) {
          diagnostics.push(values);
        },
      },
    });
    const fatal = fatalSignal(client);
    await initialize(client, input, output);
    const prompt = client.prompt("session-1", "original", createCancellationController().signal);
    await output.nextFrame();
    const steering = steer(client, "session-1", "private-steering-input");
    const frame = await output.nextFrame();
    input.push(rpcResponse(frame.id, result));
    assert.deepEqual(await steering, { kind: "protocol_error", operation: "session_steering", fatal: true });
    assert.deepEqual(await prompt, { kind: "protocol_error", operation: "session_prompt", fatal: true });
    assert.equal(fatal.errors.length, 1);
    assert.equal(fatal.errors[0]?.code, "acp_protocol");
    assert.equal(clock.pendingTimerCount, 0);
    assert.equal(output.frames.length, 0);
    assert.equal(JSON.stringify(diagnostics).includes("private"), false);
    assert.deepEqual(await steer(client, "session-1", "late"), {
      kind: "protocol_error",
      operation: "session_steering",
      fatal: true,
    });
    assert.equal(output.frames.length, 0);
    await client.close();
  }
});

void test("lost steering response times out fatally without retry, cancellation or prompt fallback", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const clock = new FakeClock();
  const client = newClient(input, output, { clock });
  const fatal = fatalSignal(client);
  await initialize(client, input, output);
  const prompt = client.prompt("session-1", "original", createCancellationController().signal);
  await output.nextFrame();
  let settled = false;
  const steering = steer(client, "session-1", "ambiguous", 2000).then((outcome) => {
    settled = true;
    return outcome;
  });
  await output.nextFrame();
  clock.advanceBy(1999);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(fatal.errors.length, 0);
  clock.advanceBy(1);
  assert.deepEqual(await steering, { kind: "transport_error", operation: "session_steering", fatal: true });
  assert.deepEqual(await prompt, { kind: "transport_error", operation: "session_prompt", fatal: true });
  assert.equal(fatal.errors.length, 1);
  assert.equal(fatal.errors[0]?.code, "acp_transport");
  assert.equal(clock.pendingTimerCount, 0);
  assert.equal(output.frames.length, 0);
  await client.close();
});

void test("steering transport and wire failures settle both outstanding requests exactly once", async () => {
  const cases: Array<{ trigger: (input: FakeInput, id: unknown) => void; kind: string }> = [
    { trigger: (input) => input.close(), kind: "transport_error" },
    { trigger: (input) => input.fail(new Error("private-read-error")), kind: "transport_error" },
    { trigger: (input) => input.push("malformed-private-json\n"), kind: "protocol_error" },
    { trigger: (input) => input.push(rpcResponse("unknown-id", { outcome: "injected" })), kind: "protocol_error" },
    { trigger: (input, id) => input.push({ jsonrpc: "2.0", id, error: { code: "private" } }), kind: "protocol_error" },
  ];
  for (const { trigger, kind } of cases) {
    const input = createFakeInput();
    const output = createFakeOutput();
    const clock = new FakeClock();
    const client = newClient(input, output, { clock });
    const fatal = fatalSignal(client);
    await initialize(client, input, output);
    const prompt = client.prompt("session-1", "original", createCancellationController().signal);
    await output.nextFrame();
    const steering = steer(client, "session-1", "adjust");
    const frame = await output.nextFrame();
    trigger(input, frame.id);
    assert.deepEqual(await steering, { kind, operation: "session_steering", fatal: true });
    assert.deepEqual(await prompt, { kind, operation: "session_prompt", fatal: true });
    assert.equal(fatal.errors.length, 1);
    assert.equal(clock.pendingTimerCount, 0);
    assert.equal(output.frames.length, 0);
    await client.close();
  }
});

void test("close interrupts steering and prompt and prevents new steering RPCs", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const clock = new FakeClock();
  const client = newClient(input, output, { clock });
  const fatal = fatalSignal(client);
  await initialize(client, input, output);
  const prompt = client.prompt("session-1", "original", createCancellationController().signal);
  await output.nextFrame();
  const steering = steer(client, "session-1", "adjust");
  const frame = await output.nextFrame();
  const closing = client.close();
  assert.deepEqual(await steer(client, "session-1", "late"), {
    kind: "transport_error",
    operation: "session_steering",
    fatal: true,
  });
  // A response racing orderly close must not revive an injection decision.
  input.push(rpcResponse(frame.id, { outcome: "injected" }));
  assert.deepEqual(await steering, { kind: "transport_error", operation: "session_steering", fatal: true });
  assert.deepEqual(await prompt, { kind: "transport_error", operation: "session_prompt", fatal: true });
  await closing;
  assert.equal(clock.pendingTimerCount, 0);
  assert.equal(fatal.errors.length, 0);
  assert.equal(output.frames.length, 0);
});

void test("a steering write failure closes the connection and settles the original prompt", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const clock = new FakeClock();
  let failWrites = false;
  let writes = 0;
  const failingOutput = new WritableStream<Uint8Array>({
    async write(chunk) {
      writes += 1;
      if (failWrites) throw new Error("private-steering-write-error");
      const writer = output.stream.getWriter();
      try {
        await writer.write(chunk);
      } finally {
        writer.releaseLock();
      }
    },
  });
  const client = newClient(input, output, { output: failingOutput, clock });
  const fatal = fatalSignal(client);
  await initialize(client, input, output);
  const prompt = client.prompt("session-1", "original", createCancellationController().signal);
  await output.nextFrame();
  failWrites = true;
  assert.deepEqual(await steer(client, "session-1", "adjust"), {
    kind: "transport_error",
    operation: "session_steering",
    fatal: true,
  });
  assert.deepEqual(await prompt, { kind: "transport_error", operation: "session_prompt", fatal: true });
  assert.equal(fatal.errors.length, 1);
  assert.equal(fatal.errors[0]?.code, "acp_transport");
  assert.equal(writes, 3);
  assert.equal(clock.pendingTimerCount, 0);
  assert.equal(output.frames.length, 0);
  await client.close();
});

void test("duplicate steering responses cannot be routed to the still-running prompt", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const client = newClient(input, output);
  const fatal = fatalSignal(client);
  await initialize(client, input, output);
  const prompt = client.prompt("session-1", "original", createCancellationController().signal);
  await output.nextFrame();
  const steering = steer(client, "session-1", "adjust");
  const frame = await output.nextFrame();
  input.push(rpcResponse(frame.id, { outcome: "injected" }));
  assert.deepEqual(await steering, { kind: "steering", outcome: "injected" });
  input.push(rpcResponse(frame.id, { outcome: "injected" }));
  assert.deepEqual(await prompt, { kind: "protocol_error", operation: "session_prompt", fatal: true });
  assert.equal(fatal.errors.length, 1);
  assert.equal(fatal.errors[0]?.code, "acp_protocol");
  assert.equal(output.frames.length, 0);
  await client.close();
});

void test("independent sessions can have simultaneous steering requests with reversed responses", async () => {
  const input = createFakeInput();
  const output = createFakeOutput();
  const clock = new FakeClock();
  const client = newClient(input, output, { clock });
  await initialize(client, input, output);
  const first = steer(client, "session-first", "first");
  const second = steer(client, "session-second", "second");
  const firstFrame = await output.nextFrame();
  const secondFrame = await output.nextFrame();
  assert.notEqual(firstFrame.id, secondFrame.id);
  assert.equal((firstFrame.params as { sessionId: string }).sessionId, "session-first");
  assert.equal((secondFrame.params as { sessionId: string }).sessionId, "session-second");
  input.push(rpcResponse(secondFrame.id, { outcome: "promptRequired", reason: "noRunningTurn" }));
  assert.deepEqual(await second, { kind: "steering", outcome: "promptRequired", reason: "noRunningTurn" });
  assert.equal(clock.pendingTimerCount, 1);
  input.push(rpcResponse(firstFrame.id, { outcome: "injected" }));
  assert.deepEqual(await first, { kind: "steering", outcome: "injected" });
  assert.equal(clock.pendingTimerCount, 0);
  await client.close();
});
