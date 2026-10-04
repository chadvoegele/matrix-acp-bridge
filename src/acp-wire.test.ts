import assert from "node:assert/strict";
import test from "node:test";
import type { AnyMessage } from "@agentclientprotocol/sdk";
import { createStrictNdjsonStream, type FailureNotice } from "./acp-wire.js";

function createInput() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    push: (bytes: Uint8Array) => controller.enqueue(bytes),
    close: () => controller.close(),
    isCancelled: () => cancelled,
  };
}

function createOutput() {
  const chunks: Uint8Array[] = [];
  let closed = false;
  const stream = new WritableStream<Uint8Array>({
    write(bytes) {
      chunks.push(bytes);
    },
    close() {
      closed = true;
    },
  });
  return { stream, chunks, isClosed: () => closed };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

void test("ACP wire preserves split UTF-8, blank lines and multiple JSON-RPC frames", async () => {
  const input = createInput();
  const output = createOutput();
  const failures: FailureNotice[] = [];
  const wire = createStrictNdjsonStream(input.stream, output.stream, (failure) => failures.push(failure));
  const reader = wire.readable.getReader();
  const frame = { jsonrpc: "2.0", method: "session/update", params: { text: "🙂" } };
  const bytes = new TextEncoder().encode(
    `\r\n${JSON.stringify(frame)}\n${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`,
  );
  for (const byte of bytes) input.push(Uint8Array.of(byte));
  assert.deepEqual((await reader.read()).value, frame);
  assert.deepEqual((await reader.read()).value, { jsonrpc: "2.0", id: 1, result: {} });
  await reader.cancel();
  reader.releaseLock();
  await flush();
  assert.deepEqual(failures, []);
  assert.equal(input.isCancelled(), true);
  assert.equal(input.stream.locked, false);
});

void test("ACP wire accepts an unterminated final frame then reports EOF once", async () => {
  const input = createInput();
  const failures: FailureNotice[] = [];
  const wire = createStrictNdjsonStream(input.stream, createOutput().stream, (failure) => failures.push(failure));
  const reader = wire.readable.getReader();
  const frame = { jsonrpc: "2.0", id: "one", result: {} };
  input.push(new TextEncoder().encode(JSON.stringify(frame)));
  input.close();
  assert.deepEqual((await reader.read()).value, frame);
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
  assert.deepEqual(failures, [{ kind: "transport", operation: "eof" }]);
  assert.equal(input.stream.locked, false);
});

void test("ACP wire rejects malformed input before forwarding to protocol observers", async () => {
  for (const bytes of [
    Uint8Array.of(0xff, 0x0a),
    new TextEncoder().encode("not json\n"),
    new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":1,"message":"private"}}\n'),
  ]) {
    const input = createInput();
    const failures: FailureNotice[] = [];
    let observed = 0;
    const wire = createStrictNdjsonStream(
      input.stream,
      createOutput().stream,
      (failure) => failures.push(failure),
      () => {
        observed += 1;
        return true;
      },
    );
    const reader = wire.readable.getReader();
    input.push(bytes);
    await assert.rejects(reader.read(), { message: "ACP wire failure" });
    reader.releaseLock();
    assert.equal(observed, 0);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.kind, "protocol");
    assert.equal(input.stream.locked, false);
  }
});

void test("ACP wire writes NDJSON, releases output locks and preserves the inherited descriptor on close", async () => {
  const input = createInput();
  const output = createOutput();
  const wire = createStrictNdjsonStream(input.stream, output.stream, () => {});
  const writer = wire.writable.getWriter();
  const frame: AnyMessage = { jsonrpc: "2.0", method: "initialize", id: 1, params: {} };
  await writer.write(frame);
  assert.equal(new TextDecoder().decode(output.chunks[0]), `${JSON.stringify(frame)}\n`);
  assert.equal(output.stream.locked, false);
  await writer.close();
  writer.releaseLock();
  assert.equal(output.isClosed(), false);
  await wire.readable.cancel();
});

void test("ACP wire write failure reports only safe metadata and releases the output lock", async () => {
  const input = createInput();
  const failures: FailureNotice[] = [];
  const output = new WritableStream<Uint8Array>({
    write() {
      throw new Error("private credential");
    },
  });
  const wire = createStrictNdjsonStream(input.stream, output, (failure) => failures.push(failure));
  const writer = wire.writable.getWriter();
  await assert.rejects(writer.write({ jsonrpc: "2.0", id: 1, result: {} }), { message: "ACP wire failure" });
  assert.deepEqual(failures, [{ kind: "transport", operation: "write" }]);
  assert.equal(output.locked, false);
  writer.releaseLock();
  await wire.readable.cancel();
});

void test("fatal ACP framing cancels the byte source and releases its reader", async () => {
  const input = createInput();
  const wire = createStrictNdjsonStream(input.stream, createOutput().stream, () => {});
  const reader = wire.readable.getReader();
  input.push(new TextEncoder().encode("invalid\n"));
  await assert.rejects(reader.read());
  reader.releaseLock();
  await flush();
  assert.equal(input.isCancelled(), true);
  assert.equal(input.stream.locked, false);
});
