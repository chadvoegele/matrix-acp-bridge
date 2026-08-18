import { stdin as processStdin, stdout as processStdout } from "node:process";
import { Readable, Writable } from "node:stream";

import {
  AGENT_METHODS,
  CLIENT_METHODS,
  RequestError,
  client as createSdkClient,
  type AnyMessage,
  type ClientConnection,
  type JsonRpcId,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

import { createCancellationController } from "./cancellation.js";
import { createStderrDiagnosticSink } from "./diagnostics.js";
import type { CancellationSignal, Unsubscribe } from "./cancellation.js";
import type { DiagnosticSink, FatalError, FatalErrorListener } from "./diagnostics.js";
import { hasOwn, isRecord } from "./object-validation.js";
import type { AcpConfig, BridgeConfig } from "./config.js";

export type AcpSessionId = string;
export type AcpMessageId = string;

export type AcpIgnoredUpdateKind =
  | "user_message_chunk"
  | "agent_thought_chunk"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "available_commands"
  | "current_mode_update"
  | "config_option_update"
  | "usage_update"
  | "unknown";

export interface AcpAgentMessageChunk {
  readonly sessionId: AcpSessionId;
  readonly kind: "agent_message_chunk";
  readonly text: string;
  readonly messageId?: AcpMessageId;
}

export interface AcpIgnoredUpdate {
  readonly sessionId: AcpSessionId;
  readonly kind: AcpIgnoredUpdateKind;
  readonly messageId?: AcpMessageId;
}

export type AcpUpdate = AcpAgentMessageChunk | AcpIgnoredUpdate;
export type AcpUpdateListener = (update: AcpUpdate) => void;

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"
  | "unknown";

export type AcpMethodErrorKind =
  | "session_new"
  | "session_load"
  | "session_prompt"
  | "session_cancel"
  | "permission"
  | "other";

/** A method error is safe to surface to the coordinator, not to the user. */
export interface AcpMethodError {
  readonly kind: "method_error";
  readonly operation: AcpMethodErrorKind;
  readonly fatal: false;
}

export interface AcpTransportError {
  readonly kind: "transport_error";
  readonly operation: "initialize" | "session_new" | "session_load" | "session_prompt" | "session_cancel" | "close";
  readonly fatal: true;
}

export interface AcpProtocolError {
  readonly kind: "protocol_error";
  readonly operation: "initialize" | "session_new" | "session_load" | "session_prompt" | "session_cancel" | "close";
  readonly fatal: true;
}

export interface AcpTurnOutcome {
  readonly kind: "turn";
  readonly stopReason: AcpStopReason;
  readonly text?: string;
}

export type AcpOutcome = AcpTurnOutcome | AcpMethodError | AcpTransportError | AcpProtocolError;

export interface AcpInitializeOptions {
  readonly protocolVersion: 1;
  readonly capabilities: {
    readonly filesystem: false;
    readonly terminal: false;
  };
}

export interface AcpInitializeResult {
  readonly protocolVersion: 1;
  /** Absent means that the agent did not advertise optional capabilities. */
  readonly agentCapabilities?: AcpAgentCapabilities;
}

export interface AcpAgentCapabilities {
  /** Whether `session/load` is supported by the initialized agent. */
  readonly loadSession?: boolean;
}

export interface AcpSessionOptions {
  readonly cwd: string;
  readonly mcpServers: readonly [];
}

export interface AcpSessionLoadOptions extends AcpSessionOptions {
  readonly sessionId: AcpSessionId;
}

export type AcpSessionPhase = "loading" | "ready";

export interface AcpSessionPhaseChange {
  readonly sessionId: AcpSessionId;
  readonly phase: AcpSessionPhase;
}

export type AcpSessionPhaseListener = (change: AcpSessionPhaseChange) => void;

export interface AcpSession {
  readonly sessionId: AcpSessionId;
  /** Optional startup text advertised by the agent in session/new metadata. */
  readonly startupInfo?: string;
}

export type AcpPermissionOptionKind = "allow_always" | "allow_once";

export interface AcpPermissionOption {
  readonly kind: AcpPermissionOptionKind;
}

export interface AcpPermissionRequest {
  readonly requestId: string;
  readonly sessionId: AcpSessionId;
  readonly options: readonly AcpPermissionOption[];
}

export type AcpPermissionDecision = AcpPermissionOptionKind | "cancelled";
export type AcpPermissionHandler = (
  request: AcpPermissionRequest,
  cancellation: CancellationSignal,
) => Promise<AcpPermissionDecision>;

export interface AcpClient {
  initialize(options: AcpInitializeOptions): Promise<AcpInitializeResult>;
  createSession(options: AcpSessionOptions): Promise<AcpSession>;
  /** Optional until the ACP session-restoration adapter is enabled. */
  loadSession?(options: AcpSessionLoadOptions): Promise<AcpSession>;
  /** Session loading is a phase, not an update kind or user-visible output. */
  onSessionPhase?(listener: AcpSessionPhaseListener): Unsubscribe;
  prompt(
    sessionId: AcpSessionId,
    text: string,
    cancellation: CancellationSignal,
  ): Promise<AcpOutcome>;
  cancel(sessionId: AcpSessionId): Promise<void>;
  onUpdate(listener: AcpUpdateListener): Unsubscribe;
  onFatalError(listener: FatalErrorListener): Unsubscribe;
  close(): Promise<void>;
}

/** A byte-oriented WHATWG stream or a Node stream suitable for stdio. */
export type AcpInput = ReadableStream<Uint8Array> | Readable;
export type AcpOutput = WritableStream<Uint8Array> | Writable;

export interface AcpTransportOptions {
  /** Injected input for fake-stream tests; defaults to the process input. */
  readonly input?: AcpInput;
  /** Injected output for fake-stream tests; defaults to the process output. */
  readonly output?: AcpOutput;
}

export interface AcpClientOptions extends AcpTransportOptions {
  readonly cwd: string;
  readonly permissionHandler?: AcpPermissionHandler;
  readonly diagnostics?: DiagnosticSink;
}

type FailureKind = "transport" | "protocol";
type FailureOperation = "eof" | "read" | "write" | "ndjson" | "json-rpc" | "connection";
type RequestOperation = Exclude<AcpTransportError["operation"], "close">;
type WireMessageObserver = (message: AnyMessage, direction: "inbound" | "outbound") => boolean;

interface FailureNotice {
  readonly kind: FailureKind;
  readonly operation: FailureOperation;
}

interface PendingPermission {
  readonly controller: ReturnType<typeof createCancellationController>;
  readonly completion: Promise<RequestPermissionResponse>;
}

interface TextGroup {
  readonly messageId?: string;
  text: string;
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

function noop(): void {
  // Used for unsubscribe callbacks and intentionally has no side effects.
}

function isJsonRpcId(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
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

function toWebReadable(input: AcpInput): ReadableStream<Uint8Array> {
  if (isWebReadable(input)) {
    return input;
  }
  return Readable.toWeb(input);
}

function toWebWritable(output: AcpOutput): WritableStream<Uint8Array> {
  if (isWebWritable(output)) {
    return output;
  }
  return Writable.toWeb(output);
}

function decodeLine(bytes: readonly number[]): string {
  return new TextDecoder("utf8", { fatal: true })
    .decode(Uint8Array.from(bytes))
    .trim();
}

function createStrictNdjsonStream(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  onFailure: (notice: FailureNotice) => void,
  observeMessage?: WireMessageObserver,
): { readonly readable: ReadableStream<AnyMessage>; readonly writable: WritableStream<AnyMessage> } {
  const encoder = new TextEncoder();
  let cancelled = false;
  let inputReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const parseAndEnqueue = (
    line: readonly number[],
    controller: ReadableStreamDefaultController<AnyMessage>,
  ): boolean => {
    let text: string;
    try {
      text = decodeLine(line);
    } catch {
      onFailure({ kind: "protocol", operation: "ndjson" });
      controller.error(new WireFailure({ kind: "protocol", operation: "ndjson" }));
      return false;
    }

    if (text.length === 0) {
      return true;
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      onFailure({ kind: "protocol", operation: "ndjson" });
      controller.error(new WireFailure({ kind: "protocol", operation: "ndjson" }));
      return false;
    }

    if (!isJsonRpcMessage(value)) {
      onFailure({ kind: "protocol", operation: "json-rpc" });
      controller.error(new WireFailure({ kind: "protocol", operation: "json-rpc" }));
      return false;
    }

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
            if (byte === 0x0A) {
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
        if (inputReader === reader) {
          inputReader = undefined;
        }
        reader.releaseLock();
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

function requestError(value: unknown): value is RequestError {
  if (value instanceof RequestError) {
    return true;
  }
  return (
    isRecord(value) &&
    typeof value.code === "number" &&
    typeof value.message === "string"
  );
}

function isNormalizedOutcome(value: unknown): value is AcpOutcome {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  return (
    value.kind === "method_error" ||
    value.kind === "transport_error" ||
    value.kind === "protocol_error"
  );
}

function methodError(operation: AcpMethodError["operation"]): AcpMethodError {
  return { kind: "method_error", operation, fatal: false };
}

function transportError(operation: RequestOperation): AcpTransportError {
  return { kind: "transport_error", operation, fatal: true };
}

function protocolError(operation: RequestOperation): AcpProtocolError {
  return { kind: "protocol_error", operation, fatal: true };
}

function stopReason(value: unknown): AcpStopReason | undefined {
  if (value === "end_turn" || value === "max_tokens" || value === "max_turn_requests") {
    return value;
  }
  if (value === "refusal" || value === "cancelled") {
    return value;
  }
  if (typeof value === "string") {
    return "unknown";
  }
  return undefined;
}

function messageId(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function startupInfo(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value._meta) || !isRecord(value._meta.piAcp)) {
    return undefined;
  }
  const text = value._meta.piAcp.startupInfo;
  return typeof text === "string" && text.length > 0 ? text : undefined;
}

function isAllowPermissionKind(
  value: string,
): value is AcpPermissionOption["kind"] {
  return value === "allow_always" || value === "allow_once";
}

function permissionRequestId(value: JsonRpcId): string {
  return typeof value === "string" ? value : String(value);
}

function wireId(value: unknown): string {
  return `${typeof value}:${String(value)}`;
}

const DEFAULT_PERMISSION_HANDLER: AcpPermissionHandler = (request) => {
  const allowAlways = request.options.find((option) => option.kind === "allow_always");
  if (allowAlways !== undefined) {
    return Promise.resolve("allow_always");
  }
  const allowOnce = request.options.find((option) => option.kind === "allow_once");
  return Promise.resolve(allowOnce === undefined ? "cancelled" : "allow_once");
};

function resolvedOptions(
  value: AcpConfig | BridgeConfig | AcpClientOptions,
  transport: AcpTransportOptions,
): AcpClientOptions {
  const candidate = value as AcpClientOptions;
  const nestedAcp = (value as Partial<BridgeConfig>).acp;
  const cwd = candidate.cwd ?? nestedAcp?.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new TypeError("ACP cwd must be a non-empty string");
  }

  const input = candidate.input ?? transport.input;
  const output = candidate.output ?? transport.output;
  return {
    cwd,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(candidate.permissionHandler === undefined
      ? {}
      : { permissionHandler: candidate.permissionHandler }),
    ...(candidate.diagnostics === undefined ? {} : { diagnostics: candidate.diagnostics }),
  };
}

/**
 * ACP v1 client bound to the process's input and output streams.
 *
 * The adapter never spawns, supervises, or kills an agent process.  The
 * service runner owns that process and supplies its descriptors to this
 * connection.
 */
export class InheritedStdioAcpClient implements AcpClient {
  readonly #cwd: string;
  readonly #diagnostics: DiagnosticSink;
  readonly #permissionHandler: AcpPermissionHandler;
  readonly #listeners = new Set<AcpUpdateListener>();
  readonly #sessionPhaseListeners = new Set<AcpSessionPhaseListener>();
  readonly #fatalListeners = new Set<FatalErrorListener>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  readonly #activeTurns = new Map<string, TextGroup[]>();
  readonly #startupInfoBySession = new Map<string, string>();
  /** Coalesce the signal-triggered and coordinator-triggered cancel paths. */
  readonly #cancelRequests = new Map<string, Promise<void>>();
  readonly #outstandingRequests = new Set<string>();
  readonly #incomingRequests = new Set<string>();

  readonly #connection: ClientConnection;
  #initialized = false;
  #agentCapabilities: AcpAgentCapabilities = {};
  #closing = false;
  #fatalError: FatalError | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(
    options: AcpClientOptions,
  ) {
    const resolved = resolvedOptions(options, {});
    this.#cwd = resolved.cwd;
    this.#diagnostics = resolved.diagnostics ?? createStderrDiagnosticSink();
    this.#permissionHandler = resolved.permissionHandler ?? DEFAULT_PERMISSION_HANDLER;

    const input = toWebReadable(resolved.input ?? processStdin);
    const output = toWebWritable(resolved.output ?? processStdout);
    const stream = createStrictNdjsonStream(input, output, (notice) => {
      this.#handleTransportFailure(notice);
    }, (message, direction) => this.#observeWireMessage(message, direction));

    const app = createSdkClient({ name: "matrix-acp-bridge" })
      .onRequest(CLIENT_METHODS.session_request_permission, ({ params, requestId }) =>
        this.#handlePermission(params, requestId),
      )
      .onNotification(CLIENT_METHODS.session_update, ({ params }) => {
        this.#handleUpdate(params);
      });

    this.#connection = app.connect(stream);
    this.#connection.signal.addEventListener("abort", () => {
      if (!this.#closing && this.#fatalError === undefined) {
        this.#reportFatal("transport", "connection");
      }
    });
    void this.#connection.closed.then(() => {
      if (!this.#closing && this.#fatalError === undefined) {
        this.#reportFatal("transport", "connection");
      }
    });
  }

  initialize(options: AcpInitializeOptions): Promise<AcpInitializeResult> {
    return this.#initialize(options);
  }

  async #initialize(options: AcpInitializeOptions): Promise<AcpInitializeResult> {
    if (
      options.protocolVersion !== 1 ||
      options.capabilities.filesystem !== false ||
      options.capabilities.terminal !== false
    ) {
      const error = protocolError("initialize");
      this.#reportFatal("protocol", "initialize");
      // ACP outcomes are structured protocol values, not Error instances.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw error;
    }

    if (this.#initialized) {
      return { protocolVersion: 1, agentCapabilities: this.#agentCapabilities };
    }

    try {
      const response = await this.#connection.agent.request(AGENT_METHODS.initialize, {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      if (!isRecord(response) || response.protocolVersion !== 1) {
        const error = protocolError("initialize");
        this.#reportFatal("protocol", "initialize");
        // ACP outcomes are structured protocol values, not Error instances.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw error;
      }
      const advertisedCapabilities = isRecord(response.agentCapabilities)
        && typeof response.agentCapabilities.loadSession === "boolean"
        ? { loadSession: response.agentCapabilities.loadSession }
        : {};
      this.#agentCapabilities = advertisedCapabilities;
      this.#initialized = true;
      return { protocolVersion: 1, agentCapabilities: advertisedCapabilities };
    } catch (error) {
      if (isNormalizedOutcome(error)) {
        throw error;
      }
      // ACP outcomes are structured protocol values, not Error instances.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw this.#classifyFailure("initialize", error, true);
    }
  }

  async createSession(_options: AcpSessionOptions): Promise<AcpSession> {
    if (!this.#initialized) {
      const error = protocolError("session_new");
      this.#reportFatal("protocol", "session_new");
      // ACP outcomes are structured protocol values, not Error instances.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw error;
    }

    try {
      const response = await this.#connection.agent.request(AGENT_METHODS.session_new, {
        cwd: this.#cwd,
        mcpServers: [],
      });
      if (!isRecord(response) || typeof response.sessionId !== "string") {
        const error = protocolError("session_new");
        this.#reportFatal("protocol", "session_new");
        // ACP outcomes are structured protocol values, not Error instances.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw error;
      }
      const advertisedStartupInfo = startupInfo(response);
      if (advertisedStartupInfo !== undefined) {
        this.#startupInfoBySession.set(response.sessionId, advertisedStartupInfo);
      }
      return {
        sessionId: response.sessionId,
        ...(advertisedStartupInfo === undefined ? {} : { startupInfo: advertisedStartupInfo }),
      };
    } catch (error) {
      if (isNormalizedOutcome(error)) {
        throw error;
      }
      // ACP outcomes are structured protocol values, not Error instances.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw this.#classifyFailure("session_new", error, true);
    }
  }

  async loadSession(options: AcpSessionLoadOptions): Promise<AcpSession> {
    if (!this.#initialized) {
      const error = protocolError("session_load");
      this.#reportFatal("protocol", "session_load");
      // ACP outcomes are structured protocol values, not Error instances.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw error;
    }

    this.#emitSessionPhase({ sessionId: options.sessionId, phase: "loading" });
    try {
      const response = await this.#connection.agent.request(AGENT_METHODS.session_load, {
        sessionId: options.sessionId,
        cwd: this.#cwd,
        mcpServers: [],
      });
      if (!isRecord(response)) {
        const error = protocolError("session_load");
        this.#reportFatal("protocol", "session_load");
        // ACP outcomes are structured protocol values, not Error instances.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw error;
      }
      return { sessionId: options.sessionId };
    } catch (error) {
      if (isNormalizedOutcome(error)) {
        throw error;
      }
      // ACP outcomes are structured protocol values, not Error instances.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw this.#classifyFailure("session_load", error, false);
    } finally {
      this.#emitSessionPhase({ sessionId: options.sessionId, phase: "ready" });
    }
  }

  async prompt(
    sessionId: string,
    text: string,
    cancellation: CancellationSignal,
  ): Promise<AcpOutcome> {
    if (!this.#initialized) {
      const error = protocolError("session_prompt");
      this.#reportFatal("protocol", "session_prompt");
      return error;
    }

    const groups: TextGroup[] = [];
    this.#activeTurns.set(sessionId, groups);
    const removeCancellation = cancellation.onCancel(() => {
      void this.cancel(sessionId).catch(() => {});
    });

    try {
      const response = await this.#connection.agent.request(AGENT_METHODS.session_prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      if (!isRecord(response)) {
        const error = protocolError("session_prompt");
        this.#reportFatal("protocol", "session_prompt");
        return error;
      }
      const reason = stopReason(response.stopReason);
      if (reason === undefined) {
        const error = protocolError("session_prompt");
        this.#reportFatal("protocol", "session_prompt");
        return error;
      }
      const collected = groups.map((group) => group.text).join("\n\n");
      const outcome: AcpTurnOutcome = {
        kind: "turn",
        stopReason: reason,
        ...(collected.length === 0 ? {} : { text: collected }),
      };
      return outcome;
    } catch (error) {
      if (isNormalizedOutcome(error)) {
        return error;
      }
      return this.#classifyFailure("session_prompt", error, false);
    } finally {
      removeCancellation();
      if (this.#activeTurns.get(sessionId) === groups) {
        this.#activeTurns.delete(sessionId);
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const existing = this.#cancelRequests.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const request = (async (): Promise<void> => {
      try {
        await this.#connection.agent.notify(AGENT_METHODS.session_cancel, { sessionId });
      } catch (error) {
        if (this.#closing) {
          return;
        }
        const outcome = this.#classifyFailure("session_cancel", error, false);
        if (outcome.kind === "method_error") {
          return;
        }
        // ACP outcomes are structured protocol values, not Error instances.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw outcome;
      }
    })();
    this.#cancelRequests.set(sessionId, request);
    try {
      await request;
    } finally {
      if (this.#cancelRequests.get(sessionId) === request) {
        this.#cancelRequests.delete(sessionId);
      }
    }
  }

  onUpdate(listener: AcpUpdateListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  onSessionPhase(listener: AcpSessionPhaseListener): Unsubscribe {
    this.#sessionPhaseListeners.add(listener);
    return () => {
      this.#sessionPhaseListeners.delete(listener);
    };
  }

  onFatalError(listener: FatalErrorListener): Unsubscribe {
    if (this.#fatalError !== undefined) {
      try {
        listener(this.#fatalError);
      } catch {
        // A listener must not interfere with transport shutdown.
      }
      return noop;
    }
    this.#fatalListeners.add(listener);
    return () => {
      this.#fatalListeners.delete(listener);
    };
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }

    this.#closing = true;
    this.#closePromise = (async () => {
      for (const pending of this.#pendingPermissions.values()) {
        pending.controller.cancel("transport closing");
      }
      await Promise.allSettled(
        [...this.#pendingPermissions.values()].map((pending) => pending.completion),
      );

      // Let the SDK's request responder flush cancellation responses before
      // aborting its connection and rejecting the remaining requests.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      this.#connection.close();
      await this.#connection.closed;
    })();
    return this.#closePromise;
  }

  #handleTransportFailure(notice: FailureNotice): void {
    this.#reportFatal(notice.kind, notice.operation);
  }

  #emitSessionPhase(change: Parameters<AcpSessionPhaseListener>[0]): void {
    for (const listener of this.#sessionPhaseListeners) {
      try {
        listener(change);
      } catch {
        // Phase observers must not affect the ACP request lifecycle.
      }
    }
  }

  #observeWireMessage(message: AnyMessage, direction: "inbound" | "outbound"): boolean {
    if (!isRecord(message)) {
      this.#reportFatal("protocol", "json-rpc");
      return false;
    }

    const record = message as Record<string, unknown>;
    const hasMethod = hasOwn(message, "method");
    const hasId = hasOwn(message, "id");
    if (direction === "inbound" && hasMethod && !this.#validInboundParams(record)) {
      this.#reportFatal("protocol", "json-rpc");
      return false;
    }
    if (direction === "outbound") {
      if (hasMethod && hasId) {
        this.#outstandingRequests.add(wireId(record.id));
        return true;
      }
      if (!hasMethod && hasId) {
        const key = wireId(record.id);
        if (!this.#incomingRequests.delete(key)) {
          this.#reportFatal("protocol", "json-rpc");
          return false;
        }
      }
      return true;
    }

    if (hasMethod && hasId) {
      const key = wireId(record.id);
      if (this.#incomingRequests.has(key)) {
        this.#reportFatal("protocol", "json-rpc");
        return false;
      }
      this.#incomingRequests.add(key);
      return true;
    }
    if (!hasMethod && hasId) {
      const key = wireId(record.id);
      if (!this.#outstandingRequests.delete(key)) {
        this.#reportFatal("protocol", "json-rpc");
        return false;
      }
    }
    return true;
  }

  #validInboundParams(message: Record<string, unknown>): boolean {
    if (typeof message.method !== "string") {
      return false;
    }

    if (message.method === CLIENT_METHODS.session_update) {
      if (!isRecord(message.params) || typeof message.params.sessionId !== "string") {
        return false;
      }
      return isRecord(message.params.update) &&
        typeof message.params.update.sessionUpdate === "string";
    }

    if (message.method === CLIENT_METHODS.session_request_permission) {
      if (!isRecord(message.params) || typeof message.params.sessionId !== "string") {
        return false;
      }
      if (!isRecord(message.params.toolCall) || typeof message.params.toolCall.toolCallId !== "string") {
        return false;
      }
      return Array.isArray(message.params.options);
    }

    if (message.method === "$/cancel_request") {
      return isRecord(message.params) && isJsonRpcId(message.params.requestId);
    }

    return true;
  }

  #reportFatal(kind: FailureKind, operation: string): void {
    if (this.#fatalError !== undefined) {
      return;
    }

    const code = kind === "protocol" ? "acp_protocol" : "acp_transport";
    const error: FatalError = {
      code,
      message: kind === "protocol" ? "ACP protocol failure" : "ACP transport failure",
    };
    this.#fatalError = error;
    this.#diagnostic("error", "acp-fatal", { code, operation });

    for (const listener of this.#fatalListeners) {
      try {
        listener(error);
      } catch {
        // Fatal notification is best effort; transport state remains closed.
      }
    }

    if (!this.#connection.signal.aborted) {
      this.#connection.close();
    }
  }

  #classifyFailure(
    operation: RequestOperation,
    error: unknown,
    fatalMethodError: boolean,
  ): AcpOutcome {
    if (isNormalizedOutcome(error)) {
      return error;
    }

    if (requestError(error)) {
      if (!fatalMethodError) {
        return methodError(
          operation === "session_prompt" || operation === "session_cancel" || operation === "session_load"
            ? operation
            : "other",
        );
      }
      this.#reportFatal("protocol", operation);
      return protocolError(operation);
    }

    if (this.#fatalError?.code === "acp_protocol") {
      return protocolError(operation);
    }
    if (this.#fatalError !== undefined || this.#closing) {
      return transportError(operation);
    }

    this.#reportFatal("transport", operation);
    return transportError(operation);
  }

  async #handlePermission(
    parameters: RequestPermissionRequest,
    requestId: JsonRpcId,
  ): Promise<RequestPermissionResponse> {
    const normalizedOptions: AcpPermissionOption[] = parameters.options
      .filter((option) => isAllowPermissionKind(option.kind))
      .map((option) => ({ kind: option.kind as AcpPermissionOption["kind"] }));
    const request: AcpPermissionRequest = {
      requestId: permissionRequestId(requestId),
      sessionId: parameters.sessionId,
      options: normalizedOptions,
    };
    const controller = createCancellationController();
    const completion = this.#runPermission(request, parameters, controller);
    const key = request.requestId;
    const pending: PendingPermission = { controller, completion };
    this.#pendingPermissions.set(key, pending);
    try {
      return await completion;
    } finally {
      if (this.#pendingPermissions.get(key) === pending) {
        this.#pendingPermissions.delete(key);
      }
    }
  }

  async #runPermission(
    request: AcpPermissionRequest,
    rawRequest: RequestPermissionRequest,
    controller: ReturnType<typeof createCancellationController>,
  ): Promise<RequestPermissionResponse> {
    let removeCancellation: Unsubscribe = noop;
    const cancelled = new Promise<AcpPermissionDecision>((resolve) => {
      removeCancellation = controller.signal.onCancel(() => {
        resolve("cancelled");
      });
    });

    try {
      const handlerResult = Promise.resolve()
        .then(() => this.#permissionHandler(request, controller.signal))
        .catch(() => "cancelled" as const);
      const decision = await Promise.race([handlerResult, cancelled]);
      if (decision === "cancelled") {
        return { outcome: { outcome: "cancelled" } };
      }

      const selected = rawRequest.options.find((option) => option.kind === decision);
      if (selected === undefined) {
        return { outcome: { outcome: "cancelled" } };
      }
      return {
        outcome: {
          outcome: "selected",
          optionId: selected.optionId,
        },
      };
    } finally {
      removeCancellation();
    }
  }

  #handleUpdate(parameters: SessionNotification): void {
    const update = parameters.update as unknown as Record<string, unknown>;
    const sessionId = parameters.sessionId;
    const kind = update.sessionUpdate;
    const id = messageId(update.messageId);

    if (kind === "agent_message_chunk") {
      const content = update.content;
      if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") {
        return;
      }

      if (this.#startupInfoBySession.get(sessionId) === content.text) {
        // pi-acp emits this prelude once, but it schedules the notification
        // after session/new.  Consume the marker even when the notification
        // wins the race with the first prompt.
        this.#startupInfoBySession.delete(sessionId);
        return;
      }

      const groups = this.#activeTurns.get(sessionId);
      if (groups === undefined) {
        return;
      }
      this.#collectText(groups, content.text, id);
      const mapped: AcpAgentMessageChunk = {
        sessionId,
        kind: "agent_message_chunk",
        text: content.text,
        ...(id === undefined ? {} : { messageId: id }),
      };
      this.#notifyUpdate(mapped);
      return;
    }

    const ignoredKind = this.#ignoredUpdateKind(kind);
    const mapped: AcpIgnoredUpdate = {
      sessionId,
      kind: ignoredKind,
      ...(id === undefined ? {} : { messageId: id }),
    };
    this.#notifyUpdate(mapped);
  }

  #ignoredUpdateKind(value: unknown): AcpIgnoredUpdate["kind"] {
    switch (value) {
      case "user_message_chunk": {
        return "user_message_chunk";
      }
      case "agent_thought_chunk": {
        return "agent_thought_chunk";
      }
      case "tool_call": {
        return "tool_call";
      }
      case "tool_call_update": {
        return "tool_call_update";
      }
      case "plan":
      case "plan_update":
      case "plan_removed": {
        return "plan";
      }
      case "available_commands_update": {
        return "available_commands";
      }
      case "current_mode_update": {
        return "current_mode_update";
      }
      case "config_option_update": {
        return "config_option_update";
      }
      case "usage_update": {
        return "usage_update";
      }
      default: {
        return "unknown";
      }
    }
  }

  #collectText(groups: TextGroup[], text: string, id: string | undefined): void {
    const last = groups.at(-1);
    if (last === undefined) {
      groups.push(id === undefined ? { text } : { messageId: id, text });
      return;
    }

    if (id !== undefined && last.messageId !== undefined && last.messageId !== id) {
      groups.push({ messageId: id, text });
      return;
    }

    last.text += text;
  }

  #notifyUpdate(update: AcpUpdate): void {
    for (const listener of this.#listeners) {
      try {
        listener(update);
      } catch {
        this.#diagnostic("error", "acp-update-listener-failed", {});
      }
    }
  }

  #diagnostic(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    fields: Record<string, string>,
  ): void {
    try {
      this.#diagnostics.emit(level, event, fields);
    } catch {
      // Diagnostics are deliberately non-fatal to the ACP transport.
    }
  }
}

export function createAcpClient(
  options: AcpClientOptions,
): AcpClient;
export function createAcpClient(
  config: BridgeConfig,
  transport?: AcpTransportOptions,
): AcpClient;
export function createAcpClient(
  config: AcpConfig,
  transport?: AcpTransportOptions,
): AcpClient;
export function createAcpClient(
  value: AcpConfig | BridgeConfig | AcpClientOptions,
  transport: AcpTransportOptions = {},
): AcpClient {
  return new InheritedStdioAcpClient(resolvedOptions(value, transport));
}

export type { AcpConfig } from "./config.js";
