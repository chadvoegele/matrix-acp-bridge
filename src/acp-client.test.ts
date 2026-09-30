import assert from "node:assert/strict";
import test from "node:test";

import {
  createAcpClient,
  ACP_ACTIVITY_UPDATE_MAX_BYTES,
  type AcpClient,
  type AcpToolCallUpdate,
  type AcpAgentThoughtChunk,
} from "./acp-client.js";
import { AcpActivityModel } from "./acp-activity.js";
import { renderAcpActivity } from "./acp-activity-rendering.js";
import type { DiagnosticSink, FatalError } from "./diagnostics.js";

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
