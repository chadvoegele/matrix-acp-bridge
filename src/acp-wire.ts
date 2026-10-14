import { Readable, Writable } from "node:stream";
import type { AnyMessage } from "@agentclientprotocol/sdk";
import { hasOwn, isRecord } from "./object-validation.js";

export type AcpInput = ReadableStream<Uint8Array> | Readable;

export type AcpOutput = WritableStream<Uint8Array> | Writable;

export type FailureKind = "transport" | "protocol";

export type FailureOperation = "eof" | "read" | "write" | "ndjson" | "json-rpc" | "connection";

type WireMessageObserver = (message: AnyMessage, direction: "inbound" | "outbound") => boolean;

export interface FailureNotice {
  readonly kind: FailureKind;
  readonly operation: FailureOperation;
}

class WireFailure extends Error {
  readonly kind: FailureKind;

  readonly operation: FailureOperation;

  constructor(notice: FailureNotice) {
    super("ACP wire failure");
    this.name = "WireFailure";
    this.kind = notice.kind;
    this.operation = notice.operation;
  }
}

export function isJsonRpcId(value: unknown): boolean {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * The SDK's stable connection rejects batches, but it intentionally ignores
 * malformed JSON lines.  Validate the envelope before handing it to the SDK
 * so the bridge can fail closed instead of silently losing protocol traffic.
 */
function isJsonRpcMessage(value: unknown): value is AnyMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    return false;
  }

  if (hasOwn(value, "method")) {
    if (typeof value.method !== "string") {
      return false;
    }
    return !hasOwn(value, "id") || isJsonRpcId(value.id);
  }

  if (!hasOwn(value, "id") || !isJsonRpcId(value.id)) {
    return false;
  }

  const hasResult = hasOwn(value, "result");
  const hasError = hasOwn(value, "error");
  if (hasResult === hasError) {
    return false;
  }

  if (hasError) {
    if (!isRecord(value.error)) {
      return false;
    }
    if (
      typeof value.error.code !== "number" ||
      !Number.isInteger(value.error.code) ||
      typeof value.error.message !== "string"
    ) {
      return false;
    }
  }

  return true;
}

function isWebReadable(value: unknown): value is ReadableStream<Uint8Array> {
  return isRecord(value) && typeof value.getReader === "function";
}

function isWebWritable(value: unknown): value is WritableStream<Uint8Array> {
  return isRecord(value) && typeof value.getWriter === "function";
}

export function convertToWebReadable(input: AcpInput): ReadableStream<Uint8Array> {
  if (isWebReadable(input)) {
    return input;
  }
  return Readable.toWeb(input);
}

export function convertToWebWritable(output: AcpOutput): WritableStream<Uint8Array> {
  if (isWebWritable(output)) {
    return output;
  }
  return Writable.toWeb(output);
}

function decodeMessage(bytes: readonly number[]): AnyMessage | undefined {
  let value: unknown;
  try {
    const text = new TextDecoder("utf8", { fatal: true }).decode(Uint8Array.from(bytes)).trim();
    if (text.length === 0) return;
    value = JSON.parse(text) as unknown;
  } catch {
    throw new WireFailure({ kind: "protocol", operation: "ndjson" });
  }
  if (!isJsonRpcMessage(value)) {
    throw new WireFailure({ kind: "protocol", operation: "json-rpc" });
  }
  return value;
}

export function createStrictNdjsonStream(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  onFailure: (notice: FailureNotice) => void,
  observeMessage?: WireMessageObserver,
): {
  readonly readable: ReadableStream<AnyMessage>;
  readonly writable: WritableStream<AnyMessage>;
} {
  const encoder = new TextEncoder();
  let cancelled = false;
  let inputReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const parseAndEnqueue = (
    line: readonly number[],
    controller: ReadableStreamDefaultController<AnyMessage>,
  ): boolean => {
    let value: AnyMessage | undefined;
    try {
      value = decodeMessage(line);
    } catch (error) {
      const failure = error as WireFailure;
      onFailure({ kind: failure.kind, operation: failure.operation });
      controller.error(failure);
      return false;
    }
    if (value === undefined) return true;

    if (observeMessage !== undefined && !observeMessage(value, "inbound")) {
      controller.error(new WireFailure({ kind: "protocol", operation: "json-rpc" }));
      return false;
    }

    controller.enqueue(value);
    return true;
  };

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      const reader = input.getReader();
      inputReader = reader;
      const line: number[] = [];

      try {
        while (!cancelled) {
          const result = await reader.read();
          if (cancelled) {
            return;
          }
          if (result.done) {
            if (line.length > 0 && !parseAndEnqueue(line, controller)) {
              return;
            }
            onFailure({ kind: "transport", operation: "eof" });
            if (!cancelled) {
              controller.close();
            }
            return;
          }

          const chunk = result.value;
          if (!(chunk instanceof Uint8Array)) {
            onFailure({ kind: "transport", operation: "read" });
            controller.error(new WireFailure({ kind: "transport", operation: "read" }));
            return;
          }

          for (const byte of chunk) {
            if (byte === 0x0a) {
              if (!parseAndEnqueue(line, controller)) {
                return;
              }
              line.length = 0;
            } else {
              line.push(byte);
            }
          }
        }
      } catch {
        if (cancelled) {
          return;
        }
        onFailure({ kind: "transport", operation: "read" });
        controller.error(new WireFailure({ kind: "transport", operation: "read" }));
      } finally {
        // An errored framing stream cannot be cancelled by its consumer.
        // Release the byte source here as well as its reader lock.
        const cancellation = reader.cancel();
        if (inputReader === reader) {
          inputReader = undefined;
        }
        reader.releaseLock();
        await cancellation.catch(() => {});
      }
    },
    cancel(reason) {
      cancelled = true;
      const pendingCancel = inputReader?.cancel(reason);
      if (pendingCancel === undefined) {
        return;
      }
      return pendingCancel.catch(() => {});
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      if (observeMessage !== undefined && !observeMessage(message, "outbound")) {
        throw new WireFailure({ kind: "protocol", operation: "json-rpc" });
      }

      let encoded: Uint8Array;
      try {
        encoded = encoder.encode(`${JSON.stringify(message)}\n`);
      } catch {
        onFailure({ kind: "protocol", operation: "json-rpc" });
        throw new WireFailure({ kind: "protocol", operation: "json-rpc" });
      }

      const writer = output.getWriter();
      try {
        await writer.write(encoded);
      } catch {
        onFailure({ kind: "transport", operation: "write" });
        throw new WireFailure({ kind: "transport", operation: "write" });
      } finally {
        writer.releaseLock();
      }
    },
    // The process output descriptor belongs to the service runner.  Closing
    // the ACP connection must never close that descriptor.
    close() {
      // Intentionally empty.
    },
    abort() {
      // Intentionally empty; the SDK owns connection shutdown.
    },
  });

  return { readable, writable };
}
