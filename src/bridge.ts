import { createCancellationController } from "./cancellation.js";
import { createHash } from "node:crypto";
import { AcpActivityModel, type AcpActivity } from "./acp-activity.js";
import { AcpActivityBatches, type ActivityBatch } from "./acp-activity-batches.js";
import { renderMatrixTextChunks } from "./matrix-text-rendering.js";
import type { MatrixSafeHtml } from "./matrix-html.js";
import { systemClock } from "./clock.js";
import type { CancellationController, Unsubscribe } from "./cancellation.js";
import type { Clock, TimerHandle } from "./clock.js";
import type { DiagnosticFields, DiagnosticSink, FatalError, FatalErrorListener } from "./diagnostics.js";
import type { BridgeConfig } from "./config.js";
import { isRecord, numberProperty, stringProperty } from "./object-validation.js";
import {
  createInboundAuthorizer,
  isValidMatrixEventId,
  type AcceptedInboundDecision,
  type InboundAuthorizationDecision,
  type InboundAuthorizer,
  type OversizedInboundDecision,
  type NormalizedInboundEvent,
} from "./authorization.js";
import { conversationIdentityForEvent, conversationKey, type ConversationIdentity } from "./conversation-identity.js";
import { InMemorySessionStore } from "./session-store.js";
import {
  matrixHtmlContentBytes,
  matrixHtmlEditContentBytes,
  type MatrixHtmlBody,
  type MatrixOutputRouting,
} from "./matrix-message-content.js";
import type { SessionStore } from "./session-store.js";
import type { AcpClient, AcpOutcome, AcpSession, AcpSessionId, AcpUpdate } from "./acp-client.js";
import {
  renderMatrixResponse,
  type MatrixResponseDescriptor,
  type RenderableResponse,
  type RenderedMatrixPart,
} from "./response-rendering.js";
import type { BridgeStateStore } from "./bridge-state.js";
import type {
  InboundMatrixEvent,
  MatrixBridgeAdapter,
  MatrixEventId,
  MatrixFailureClassification,
  MatrixRoomId,
  MatrixHtmlMessage,
} from "./matrix-client.js";

const QUIET_DRAIN_MS = 300;
const STREAMING_DRAIN_CAP_MS = 30_000;
const TYPING_TIMEOUT_MS = 30_000;
// Leave enough time for another refresh if one request is delayed or fails.
const TYPING_REFRESH_MS = 10_000;
const CLOSED_MESSAGE_ID_LIMIT = 1000;
const EVENT_ID_LIMIT = 10_000;
const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16_000, 30_000] as const;
const MAX_TIMER_MS = 2_147_483_647;

const noop = (): void => undefined;

/**
 * A result returned by the asynchronous intake methods.  The completion of
 * the response is represented by the returned promise itself; the result is
 * useful to callers that want to distinguish admission from a duplicate or a
 * policy rejection without inspecting diagnostics.
 */
export type BridgeAdmission = "ignored" | "duplicate" | "accepted" | "busy" | "oversized";

/** Called at the durable terminal boundary, before Matrix response delivery. */
export type BridgeTerminalCompletion = () => Promise<void>;

export interface BridgeCoordinatorOptions {
  readonly config: BridgeConfig;
  readonly acp: AcpClient;
  readonly matrix: MatrixBridgeAdapter;
  /** A policy object or a test-friendly authorization function. */
  readonly authorizer?: InboundAuthorizer | ((event: InboundMatrixEvent) => InboundAuthorizationDecision);
  readonly sessionStore?: SessionStore;
  readonly stateStore?: BridgeStateStore;
  readonly loadSession?: boolean;
  readonly clock?: Clock;
  readonly diagnostics?: DiagnosticSink;
  /** Injected for deterministic full-jitter retry tests. */
  readonly random?: () => number;
  /** MatrixClientAdapter already suppresses pre-PREPARED events. */
  readonly intakeOpen?: boolean;
  /** Main opens dispatch after post-ready startup validation. */
  readonly dispatchOpen?: boolean;
}

export interface BridgeSnapshot {
  readonly intakeOpen: boolean;
  readonly dispatchOpen: boolean;
  readonly stopping: boolean;
  readonly fatal: FatalError | undefined;
  readonly deduplicatedEventCount: number;
  readonly activeRooms: number;
  readonly queuedTurns: number;
  readonly unresolvedPrompts: number;
}

interface MutableQueueEntry {
  readonly event: NormalizedInboundEvent;
  readonly terminalCompletion: BridgeTerminalCompletion | undefined;
  readonly resolve: () => void;
  readonly completion: Promise<void>;
  completed: boolean;
}

interface RoomState {
  readonly roomId: MatrixRoomId;
  readonly outbound: OutboundMutex;
  readonly conversations: Map<string, ConversationState>;
}

interface ConversationState {
  readonly identity: ConversationIdentity;
  readonly room: RoomState;
  readonly waiting: MutableQueueEntry[];
  active: MutableQueueEntry | undefined;
  sessionId: AcpSessionId | undefined;
}

interface ActiveRun {
  readonly entry: MutableQueueEntry;
  readonly room: RoomState;
  readonly conversation: ConversationState;
  sessionId: AcpSessionId | undefined;
  controller: CancellationController | undefined;
  turn: TurnCollector | undefined;
  promptStarted: boolean;
  promptResolved: boolean;
  cancelSent: boolean;
  typingTimer: TimerHandle;
  typingStarted: boolean;
}

interface TextGroup {
  readonly messageId: string | undefined;
  text: string;
  closed: boolean;
  sentLength: number;
}

interface ActivityBatchDelivery {
  eventId?: MatrixEventId;
  revision: number;
  pending: boolean;
  dirty: boolean;
}

interface TurnCollector extends MatrixOutputRouting {
  readonly sessionId: AcpSessionId;
  readonly groups: TextGroup[];
  readonly activity: AcpActivityModel;
  readonly activityBatches: AcpActivityBatches;
  readonly batchDeliveries: WeakMap<ActivityBatch, ActivityBatchDelivery>;
  outboundTail: Promise<void>;
  liveFailed: boolean;
  lastTextGroup: TextGroup | undefined;
  readonly room: RoomState;
  readonly inboundEventId: MatrixEventId;
  readonly messageIds: Set<string>;
  readonly messageOrder: string[];
  hasText: boolean;
  lastTextChangeAt: number;
  promptResolved: boolean;
  drainComplete: boolean;
  closed: boolean;
  quietTimer: TimerHandle;
  deadlineTimer: TimerHandle;
  resolveDrain: ((result: DrainResult) => void) | undefined;
}

interface DrainResult {
  readonly text: string;
  readonly fatal: boolean;
}

interface PromptResult {
  readonly outcome: AcpOutcome | undefined;
  readonly timedOut: boolean;
  readonly graceExpired: boolean;
}

type SessionFailureCode = "acp_transport" | "acp_protocol" | "state";

interface SessionResolution {
  readonly session?: AcpSession;
  readonly failureCode?: SessionFailureCode;
  readonly creationFailure?: boolean;
  readonly methodFailure?: boolean;
}

interface DeliveryOptions {
  readonly allowDuringStop?: boolean;
  readonly retry?: boolean;
}

interface RetryWait {
  readonly cancel: () => void;
}

function boolProperty(value: unknown, ...names: readonly string[]): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }
  return undefined;
}

function retryAfterFromError(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const retryGetter = value.getRetryAfterMs;
  if (typeof retryGetter === "function") {
    try {
      const result = retryGetter.call(value) as unknown;
      if (typeof result === "number" && Number.isFinite(result) && result >= 0) {
        return result;
      }
    } catch {
      // Fall through to the raw Matrix metadata forms.
    }
  }
  const headers = value.httpHeaders ?? value.headers;
  if (isRecord(headers) && typeof headers.get === "function") {
    try {
      const header = (headers.get as (name: string) => unknown).call(headers, "Retry-After");
      if (typeof header === "string" && /^\d+$/u.test(header)) {
        const seconds = Number(header);
        if (Number.isSafeInteger(seconds)) {
          return seconds * 1000;
        }
      }
      if (typeof header === "string" && header.length > 0) {
        const timestamp = Date.parse(header);
        if (!Number.isNaN(timestamp)) {
          return Math.max(0, timestamp - Date.now());
        }
      }
    } catch {
      // A malformed server hint is treated as absent.
    }
  }
  return undefined;
}

function isAcpOutcome(value: unknown): value is AcpOutcome {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === "turn") {
    return typeof value.stopReason === "string";
  }
  if (value.kind === "method_error") {
    return value.fatal === false;
  }
  return (value.kind === "transport_error" || value.kind === "protocol_error") && value.fatal === true;
}

function normalizeStopReason(outcome: AcpOutcome): AcpOutcome {
  if (outcome.kind !== "turn") {
    return outcome;
  }
  switch (outcome.stopReason) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
    case "cancelled":
    case "unknown": {
      return outcome;
    }
    default: {
      return { ...outcome, stopReason: "unknown" };
    }
  }
}

function isFatalAcpOutcome(value: unknown): boolean {
  return (
    isRecord(value) && (value.kind === "transport_error" || value.kind === "protocol_error") && value.fatal === true
  );
}

function isMethodError(value: unknown): boolean {
  return isRecord(value) && value.kind === "method_error" && value.fatal === false;
}

function isSessionLoadMethodError(value: unknown): boolean {
  return isRecord(value) && isMethodError(value) && value.operation === "session_load";
}

function acpError(operation: "session_prompt" | "session_cancel"): AcpOutcome {
  return { kind: "transport_error", operation, fatal: true };
}

function safeErrorMessage(fallback: string): string {
  // Raw ACP/Matrix errors are deliberately never placed in diagnostics or
  // fatal messages.  This helper only selects a fixed message.
  return fallback;
}

function clampTimer(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(MAX_TIMER_MS, Math.floor(value));
}

function secondsToMilliseconds(seconds: number): number {
  return clampTimer(seconds * 1000);
}

function sessionOptions(config: BridgeConfig): {
  readonly cwd: string;
  readonly mcpServers: readonly [];
} {
  return { cwd: config.acp.cwd, mcpServers: [] };
}

function joinedGroups(groups: readonly TextGroup[]): string {
  let result = "";
  for (const group of groups) {
    if (!group.text) continue;
    if (result) result += "\n\n";
    result += group.text;
  }
  return result;
}

function routingForEvent(event: NormalizedInboundEvent): MatrixOutputRouting {
  return event.threadRootEventId === undefined
    ? {}
    : { threadRootEventId: event.threadRootEventId, threadInReplyToEventId: event.eventId };
}

function routingForTurn(turn: TurnCollector): MatrixOutputRouting {
  return {
    ...(turn.threadRootEventId === undefined ? {} : { threadRootEventId: turn.threadRootEventId }),
    ...(turn.threadInReplyToEventId === undefined ? {} : { threadInReplyToEventId: turn.threadInReplyToEventId }),
  };
}

function liveTransactionId(turn: TurnCollector, kind: string, index: number, revision: number): string {
  const digest = createHash("sha256")
    .update(
      turn.threadRootEventId === undefined
        ? `${turn.room.roomId}\u0000${turn.inboundEventId}\u0000${kind}\u0000${index}\u0000${revision}`
        : JSON.stringify([turn.room.roomId, turn.inboundEventId, kind, index, revision, turn.threadRootEventId]),
    )
    .digest("hex");
  return `matrix-acp-live-${digest}`;
}

function normalizeThrownPrompt(value: unknown): AcpOutcome {
  if (isAcpOutcome(value)) {
    return value;
  }
  return acpError("session_prompt");
}

function sessionFailureCode(value: unknown): SessionFailureCode {
  if (isRecord(value) && value.kind === "protocol_error") {
    return "acp_protocol";
  }
  if (isRecord(value) && value.kind === "transport_error") {
    return "acp_transport";
  }
  return "acp_protocol";
}

function normalizeFailureClassification(value: unknown): MatrixFailureClassification | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value.failure ?? value.classification ?? value;
  if (!isRecord(candidate)) {
    return undefined;
  }
  const kind = candidate.kind;
  const retryable = candidate.retryable;
  if ((kind !== "transient" && kind !== "permanent") || typeof retryable !== "boolean") {
    return undefined;
  }
  const retryAfterMs = numberProperty(candidate, "retryAfterMs", "retry_after_ms");
  const sdkRetryable = boolProperty(candidate, "sdkRetryable", "sdk_retryable") ?? false;
  const httpStatus = numberProperty(candidate, "httpStatus", "status", "statusCode");
  const errcode = stringProperty(candidate, "errcode", "errorCode");
  return {
    kind,
    retryable,
    sdkRetryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(errcode === undefined ? {} : { errcode }),
  };
}

function matrixFailureFor(error: unknown): MatrixFailureClassification {
  const explicit = normalizeFailureClassification(error);
  if (explicit !== undefined) {
    return explicit;
  }

  const status = numberProperty(error, "httpStatus", "status", "statusCode");
  const retryAfterMs = numberProperty(error, "retryAfterMs", "retry_after_ms");
  const data = isRecord(error) ? error.data : undefined;
  const dataRetryAfter = numberProperty(data, "retry_after_ms");
  const effectiveRetryAfter = retryAfterMs ?? dataRetryAfter ?? retryAfterFromError(error);
  const transientStatus = status === 408 || status === 429 || (status !== undefined && status >= 500 && status < 600);
  const code = stringProperty(error, "code");
  const name = stringProperty(error, "name");
  const message = stringProperty(error, "message")?.toLowerCase() ?? "";
  const networkFailure =
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    message.includes("network") ||
    message.includes("socket") ||
    message.includes("connection") ||
    message.includes("fetch") ||
    message.includes("timed out");
  const sdkRetryable = boolProperty(error, "sdkRetryable", "isRetryable", "retryable") === true;
  const retryable = transientStatus || networkFailure || sdkRetryable;
  return {
    kind: retryable ? "transient" : "permanent",
    retryable,
    sdkRetryable,
    ...(effectiveRetryAfter === undefined ? {} : { retryAfterMs: effectiveRetryAfter }),
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(name === undefined ? {} : { errcode: name }),
  };
}

function retryDelay(failure: MatrixFailureClassification, attempt: number, random: () => number): number {
  if (failure.retryAfterMs !== undefined && Number.isFinite(failure.retryAfterMs)) {
    return clampTimer(Math.max(0, failure.retryAfterMs));
  }
  const cap = DEFAULT_RETRY_DELAYS_MS[Math.min(attempt, DEFAULT_RETRY_DELAYS_MS.length - 1)] ?? 30_000;
  let sample = 0.5;
  try {
    sample = random();
  } catch {
    sample = 0.5;
  }
  if (!Number.isFinite(sample)) {
    sample = 0.5;
  }
  return Math.floor(cap * Math.min(1, Math.max(0, sample)));
}

/** FIFO async mutex used for complete Matrix responses, not just one part. */
class OutboundMutex {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release: (() => void) | undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(operation).finally(() => {
      release?.();
    });
  }
}

interface PermitWaiter {
  readonly resolve: (release: (() => void) | undefined) => void;
  cancelled: boolean;
}

/** A small cancellable semaphore for unresolved ACP prompt requests. */
class PromptSemaphore {
  #available: number;

  readonly #waiters: PermitWaiter[] = [];

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("maxConcurrentPrompts must be a positive safe integer");
    }
    this.#available = limit;
  }

  acquire(): Promise<(() => void) | undefined> {
    if (this.#available > 0) {
      this.#available -= 1;
      let released = false;
      return Promise.resolve(() => {
        if (released) {
          return;
        }
        released = true;
        this.#releaseOne();
      });
    }
    return new Promise((resolve) => {
      this.#waiters.push({ resolve, cancelled: false });
    });
  }

  cancelWaiters(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        continue;
      }
      waiter.cancelled = true;
      // eslint-disable-next-line unicorn/no-useless-undefined -- undefined releases a cancelled waiter without a permit
      waiter.resolve(undefined);
    }
  }

  get available(): number {
    return this.#available;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  #releaseOne(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined || waiter.cancelled) {
        continue;
      }
      let released = false;
      waiter.resolve(() => {
        if (released) {
          return;
        }
        released = true;
        this.#releaseOne();
      });
      return;
    }
    this.#available += 1;
  }
}

function makeQueueEntry(
  event: NormalizedInboundEvent,
  terminalCompletion: BridgeTerminalCompletion | undefined,
): MutableQueueEntry {
  let resolve!: () => void;
  const completion = new Promise<void>((done) => {
    resolve = done;
  });
  return { event, terminalCompletion, resolve, completion, completed: false };
}

/**
 * Coordinates Matrix intake, per-conversation ACP turns, and outbound delivery.
 *
 * The class does not start either adapter.  `beginStartup`, `openIntake`, and
 * `enableDispatch` are deliberately separate so `main.ts` can implement the
 * startup ordering from the specification without placing lifecycle policy in
 * this module.
 */
export class BridgeCoordinator {
  readonly #config: BridgeConfig;

  readonly #acp: AcpClient;

  readonly #matrix: MatrixBridgeAdapter;

  readonly #authorizer: InboundAuthorizer | ((event: InboundMatrixEvent) => InboundAuthorizationDecision);

  readonly #sessionStore: SessionStore;

  readonly #stateStore: BridgeStateStore | undefined;

  readonly #loadSession: boolean;

  readonly #clock: Clock;

  readonly #diagnostics: DiagnosticSink | undefined;

  readonly #random: () => number;

  readonly #rooms = new Map<MatrixRoomId, RoomState>();

  readonly #eventIds = new Set<MatrixEventId>();

  readonly #eventOrder: MatrixEventId[] = [];

  readonly #closedMessageIds = new Map<AcpSessionId, { readonly set: Set<string>; readonly order: string[] }>();

  readonly #turnsBySession = new Map<AcpSessionId, TurnCollector>();

  readonly #activeRuns = new Set<ActiveRun>();

  readonly #retryWaits = new Set<RetryWait>();

  readonly #fatalListeners = new Set<FatalErrorListener>();

  readonly #idleWaiters = new Set<() => void>();

  readonly #semaphore: PromptSemaphore;

  readonly #subscriptions: Unsubscribe[] = [];

  readonly #loadingSessions = new Set<AcpSessionId>();

  #intakeOpen: boolean;

  #dispatchOpen: boolean;

  #stopping = false;

  #stopped = false;

  #fatal: FatalError | undefined;

  #outboundOperations = 0;

  #unresolvedPrompts = 0;

  #stopPromise: Promise<void> | undefined;

  #resolveStop: (() => void) | undefined;

  #stopDeadlineTimer: TimerHandle;

  #stopFinalizeStarted = false;

  #initializePromise: Promise<void> | undefined;

  #sessionStatePreparation: Promise<void> | undefined;

  constructor(options: BridgeCoordinatorOptions);
  constructor(
    config: BridgeConfig,
    acp: AcpClient,
    matrix: MatrixBridgeAdapter,
    options?: Omit<BridgeCoordinatorOptions, "config" | "acp" | "matrix">,
  );
  constructor(
    optionsOrConfig: BridgeCoordinatorOptions | BridgeConfig,
    acpArgument?: AcpClient,
    matrixArgument?: MatrixBridgeAdapter,
    additionalOptions: Omit<BridgeCoordinatorOptions, "config" | "acp" | "matrix"> = {},
  ) {
    const options =
      "config" in optionsOrConfig
        ? optionsOrConfig
        : ({
            ...additionalOptions,
            config: optionsOrConfig,
            acp: acpArgument,
            matrix: matrixArgument,
          } as BridgeCoordinatorOptions);
    const acp = options.acp;
    const matrix = options.matrix;
    if (acp === undefined || matrix === undefined) {
      throw new TypeError("BridgeCoordinator requires ACP and Matrix adapters");
    }

    this.#config = options.config;
    this.#acp = acp;
    this.#matrix = matrix;
    this.#clock = options.clock ?? systemClock;
    this.#diagnostics = options.diagnostics;
    this.#random = options.random ?? Math.random;
    this.#sessionStore = options.sessionStore ?? new InMemorySessionStore();
    this.#stateStore = options.stateStore;
    this.#loadSession = options.loadSession === true;
    this.#authorizer =
      options.authorizer ??
      createInboundAuthorizer({
        allowedRooms: this.#config.matrix.allowedRooms,
        allowedSenders: this.#config.matrix.allowedSenders,
        bridgeUserId: this.#config.matrix.userId,
        maxInputBytes: this.#config.limits.maxInputBytes,
        encryption: this.#config.matrix.encryption,
        responseMode: this.#config.matrix.responseMode,
        ...(this.#diagnostics === undefined ? {} : { diagnostics: this.#diagnostics }),
        clock: this.#clock,
      });
    this.#semaphore = new PromptSemaphore(this.#config.limits.maxConcurrentPrompts);
    this.#intakeOpen = options.intakeOpen ?? true;
    this.#dispatchOpen = options.dispatchOpen ?? true;

    for (const roomId of this.#config.matrix.allowedRooms) {
      this.#rooms.set(roomId, this.#newRoom(roomId));
    }

    this.#subscribe();
  }

  get intakeOpen(): boolean {
    return this.#intakeOpen;
  }

  get dispatchOpen(): boolean {
    return this.#dispatchOpen;
  }

  get stopping(): boolean {
    return this.#stopping;
  }

  get fatalError(): FatalError | undefined {
    return this.#fatal;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  get snapshot(): BridgeSnapshot {
    let queuedTurns = 0;
    let activeRooms = 0;
    for (const room of this.#rooms.values()) {
      for (const conversation of room.conversations.values()) {
        queuedTurns += conversation.waiting.length;
      }
      if ([...room.conversations.values()].some((conversation) => conversation.active !== undefined)) {
        activeRooms += 1;
      }
    }
    return {
      intakeOpen: this.#intakeOpen,
      dispatchOpen: this.#dispatchOpen,
      stopping: this.#stopping,
      fatal: this.#fatal,
      deduplicatedEventCount: this.#eventIds.size,
      activeRooms,
      queuedTurns,
      unresolvedPrompts: this.#unresolvedPrompts,
    };
  }

  get deduplicatedEventCount(): number {
    return this.#eventIds.size;
  }

  get unresolvedPromptCount(): number {
    return this.#unresolvedPrompts;
  }

  getQueueDepth(roomId: MatrixRoomId): number {
    return [...(this.#rooms.get(roomId)?.conversations.values() ?? [])].reduce(
      (count, conversation) => count + conversation.waiting.length,
      0,
    );
  }

  isRoomActive(roomId: MatrixRoomId): boolean {
    return [...(this.#rooms.get(roomId)?.conversations.values() ?? [])].some(
      (conversation) => conversation.active !== undefined,
    );
  }

  sessionForRoom(roomId: MatrixRoomId): AcpSessionId | undefined {
    return this.sessionForConversation({ kind: "room", roomId });
  }

  sessionForConversation(identity: ConversationIdentity): AcpSessionId | undefined {
    return (
      this.#rooms.get(identity.roomId)?.conversations.get(conversationKey(identity))?.sessionId ??
      this.#sessionStore.getConversationRecord(identity)?.sessionId
    );
  }

  beginStartup(): void {
    if (this.#stopping || this.#fatal !== undefined) {
      return;
    }
    this.#intakeOpen = false;
    this.#dispatchOpen = false;
  }

  /** Open post-PREPARED Matrix intake while retaining the dispatch gate. */
  openIntake(): void {
    if (this.#stopping || this.#fatal !== undefined) {
      return;
    }
    this.#intakeOpen = true;
  }

  closeIntake(): void {
    this.#intakeOpen = false;
  }

  stopIntake(): void {
    this.closeIntake();
    try {
      this.#matrix.stopIntake();
    } catch {
      // Intake shutdown is best effort; the coordinator remains fail-closed.
    }
  }

  disableDispatch(): void {
    this.#dispatchOpen = false;
  }

  enableDispatch(): void {
    if (this.#stopping || this.#fatal !== undefined) {
      return;
    }
    this.#dispatchOpen = true;
    for (const room of this.#rooms.values()) {
      for (const conversation of room.conversations.values()) {
        this.#pumpConversation(conversation);
      }
    }
  }

  setGates(gates: { readonly intakeOpen?: boolean; readonly dispatchOpen?: boolean }): void {
    if (gates.intakeOpen === false) {
      this.closeIntake();
    } else if (gates.intakeOpen === true) {
      this.openIntake();
    }
    if (gates.dispatchOpen === false) {
      this.disableDispatch();
    } else if (gates.dispatchOpen === true) {
      this.enableDispatch();
    }
  }

  onFatalError(listener: FatalErrorListener): Unsubscribe {
    if (this.#fatal !== undefined) {
      try {
        listener(this.#fatal);
      } catch {
        // A notification hook must not affect lifecycle handling.
      }
      return noop;
    }
    this.#fatalListeners.add(listener);
    return () => {
      this.#fatalListeners.delete(listener);
    };
  }

  /** Initialize ACP v1 with the bridge's deliberately empty capabilities. */
  initializeAcp(): Promise<void> {
    if (this.#initializePromise !== undefined) {
      return this.#initializePromise;
    }
    this.#initializePromise = (async () => {
      try {
        const result = await this.#acp.initialize({
          protocolVersion: 1,
          capabilities: { filesystem: false, terminal: false },
        });
        if (result.protocolVersion !== 1) {
          throw new Error("unsupported ACP protocol version");
        }
      } catch (error) {
        this.#triggerFatal({
          code: isFatalAcpOutcome(error) ? "acp_protocol" : "startup",
          message: safeErrorMessage("ACP initialization failed"),
        });
        throw new Error("ACP initialization failed");
      }
    })();
    return this.#initializePromise;
  }

  /**
   * MatrixSyncCoordinator calls this method after durable batch registration.
   * It is also public for deterministic unit tests and alternate adapters.
   */
  handleTimelineEvent(event: InboundMatrixEvent, terminalCompletion?: BridgeTerminalCompletion): Promise<void> {
    return this.#submit(event, terminalCompletion);
  }

  /** Wait until work already admitted to the coordinator has completed. */
  async waitForIdle(): Promise<void> {
    if (this.#isIdle()) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#idleWaiters.add(resolve);
    });
  }

  /**
   * Stop intake, cancel active ACP prompts, drop waiting turns, and finish
   * active Matrix requests for at most the configured grace period.
   */
  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) {
      return this.#stopPromise;
    }
    this.#stopping = true;
    this.#intakeOpen = false;
    this.#dispatchOpen = false;
    try {
      this.#matrix.stopIntake();
    } catch {
      // Continue shutdown even if the adapter's intake hook throws.
    }
    this.#dropWaitingTurns();
    this.#semaphore.cancelWaiters();
    for (const run of this.#activeRuns) {
      void this.#stopTyping(run);
      if (run.promptStarted && !run.promptResolved && run.sessionId !== undefined) {
        this.#requestCancel(run, "bridge shutdown");
      }
    }

    this.#stopPromise = new Promise<void>((resolve) => {
      this.#resolveStop = resolve;
    });
    const graceMs = secondsToMilliseconds(this.#config.limits.shutdownGraceSeconds);
    this.#stopDeadlineTimer = this.#clock.setTimeout(() => {
      this.#finalizeStop(true);
    }, graceMs);
    this.#maybeFinalizeStop();
    return this.#stopPromise;
  }

  #subscribe(): void {
    const subscriptions: Unsubscribe[] = [
      this.#matrix.onFatalError((error) => {
        this.#triggerFatal(error);
      }),
      this.#acp.onUpdate((update) => {
        this.#handleAcpUpdate(update);
      }),
      ...(this.#acp.onSessionPhase === undefined
        ? []
        : [
            this.#acp.onSessionPhase((change) => {
              if (change.phase === "loading") {
                this.#loadingSessions.add(change.sessionId);
              } else {
                this.#loadingSessions.delete(change.sessionId);
              }
            }),
          ]),
      this.#acp.onFatalError((error) => {
        this.#triggerFatal(error);
      }),
    ];
    this.#subscriptions.push(...subscriptions);
  }

  async #submit(event: InboundMatrixEvent, terminalCompletion?: BridgeTerminalCompletion): Promise<void> {
    const admission = this.#admit(event);
    if (admission === "ignored" || admission === "duplicate") {
      return;
    }

    const inboundRouting = admission.kind === "accepted" ? admission.event : admission.routing;
    const { eventId, roomId } = inboundRouting;
    const identity = conversationIdentityForEvent(inboundRouting, this.#config.matrix.responseMode);
    const routing: MatrixOutputRouting =
      identity.kind === "thread"
        ? { threadRootEventId: identity.threadRootEventId, threadInReplyToEventId: eventId }
        : {};
    const known = identity.kind === "room" || this.#knownThread(identity);

    if (identity.kind === "thread" && inboundRouting.threadRootEventId !== undefined && !known) {
      if (!(await this.#completeTerminal(terminalCompletion))) return;
      this.#receipt(event);
      await this.#deliverDescriptor(roomId, eventId, { kind: "unknown_thread" }, routing);
      return;
    }
    if (admission.kind === "oversized") {
      if (!(await this.#completeTerminal(terminalCompletion))) return;
      this.#receipt(event);
      await this.#deliverDescriptor(roomId, eventId, { kind: "oversized" }, routing);
      return;
    }
    const normalized = admission.event;
    if (identity.kind === "thread" && normalized.threadRootEventId === undefined && normalized.body === "/reset") {
      if (!(await this.#completeTerminal(terminalCompletion))) return;
      this.#receipt(event);
      await this.#deliverDescriptor(roomId, eventId, { kind: "thread_reset_guidance" });
      return;
    }

    const room = this.#room(roomId);
    const key = conversationKey(identity);
    const conversation = room.conversations.get(key) ?? {
      identity,
      room,
      waiting: [],
      active: undefined,
      sessionId: undefined,
    };
    const queueLimit =
      identity.kind === "thread"
        ? this.#config.limits.maxQueuedTurnsPerThread
        : this.#config.limits.maxQueuedTurnsPerRoom;
    if (conversation.active !== undefined && conversation.waiting.length >= queueLimit) {
      if (event.isCatchUp === true) {
        this.#diagnostic("warn", "catch-up-event-omitted", {
          roomId,
          reason: identity.kind === "thread" ? "thread-queue-bound" : "room-queue-bound",
        });
        await this.#completeTerminal(terminalCompletion);
        return;
      }
      if (!(await this.#completeTerminal(terminalCompletion))) return;
      this.#receipt(event);
      await this.#deliverDescriptor(roomId, eventId, { kind: "busy" }, routing);
      return;
    }
    // Admission records the routing identity immediately. Follow-ups arriving
    // during setup/reset remain known; rejected roots never enter this map.
    room.conversations.set(key, conversation);
    if (identity.kind === "thread" && !known) this.#sessionStore.setConversationRecord(identity);
    const entry = makeQueueEntry(
      {
        ...normalized,
        ...(identity.kind === "thread" ? { threadRootEventId: identity.threadRootEventId } : {}),
      },
      terminalCompletion,
    );
    if (conversation.active === undefined) {
      conversation.active = entry;
      this.#pumpConversation(conversation);
    } else {
      conversation.waiting.push(entry);
    }
    this.#receipt(event);
    await entry.completion;
  }

  async #completeTerminal(terminalCompletion: BridgeTerminalCompletion | undefined): Promise<boolean> {
    if (terminalCompletion === undefined) {
      return true;
    }
    try {
      await terminalCompletion();
      return true;
    } catch {
      this.#triggerFatal({
        code: "state",
        message: "Private bridge state failure",
      });
      return false;
    }
  }

  #knownThread(identity: ConversationIdentity): boolean {
    return (
      this.#rooms.get(identity.roomId)?.conversations.has(conversationKey(identity)) === true ||
      this.#sessionStore.getConversationRecord(identity) !== undefined ||
      (this.#loadSession && this.#stateStore?.getConversationRecord(identity) !== undefined)
    );
  }

  #admit(event: InboundMatrixEvent): AcceptedInboundDecision | OversizedInboundDecision | "ignored" | "duplicate" {
    if (!this.#intakeOpen || this.#stopping || this.#fatal !== undefined) {
      return "ignored";
    }
    const eventId = isRecord(event) && typeof event.eventId === "string" ? event.eventId : undefined;
    if (eventId === undefined || !isValidMatrixEventId(eventId)) {
      // Missing/invalid IDs are intentionally silent: there is no stable
      // transaction ID and therefore no safe user-facing response.
      return "ignored";
    }
    if (this.#eventIds.has(eventId)) {
      return "duplicate";
    }
    this.#rememberEventId(eventId);

    let decision: InboundAuthorizationDecision;
    try {
      decision = typeof this.#authorizer === "function" ? this.#authorizer(event) : this.#authorizer.authorize(event);
    } catch {
      this.#diagnostic("error", "inbound-policy-failed", {
        eventId,
        roomId: typeof event.roomId === "string" ? event.roomId : null,
      });
      return "ignored";
    }
    return decision.kind === "rejected" ? "ignored" : decision;
  }

  #rememberEventId(eventId: MatrixEventId): void {
    this.#eventIds.add(eventId);
    this.#eventOrder.push(eventId);
    if (this.#eventOrder.length > EVENT_ID_LIMIT) {
      const oldest = this.#eventOrder.shift();
      if (oldest !== undefined) {
        this.#eventIds.delete(oldest);
      }
    }
  }

  #newRoom(roomId: MatrixRoomId): RoomState {
    return {
      roomId,
      outbound: new OutboundMutex(),
      conversations: new Map(),
    };
  }

  #room(roomId: MatrixRoomId): RoomState {
    const existing = this.#rooms.get(roomId);
    if (existing !== undefined) {
      return existing;
    }
    const room = this.#newRoom(roomId);
    this.#rooms.set(roomId, room);
    return room;
  }

  #pumpConversation(conversation: ConversationState): void {
    if (!this.#dispatchOpen || this.#stopping || this.#fatal !== undefined) {
      return;
    }
    let entry = conversation.active;
    if (entry === undefined) {
      entry = conversation.waiting.shift();
      if (entry === undefined) {
        return;
      }
      conversation.active = entry;
    }
    if (entry === undefined || this.#activeRunsForEntry(entry)) {
      return;
    }
    const run: ActiveRun = {
      entry,
      room: conversation.room,
      conversation,
      sessionId: undefined,
      controller: undefined,
      turn: undefined,
      promptStarted: false,
      promptResolved: false,
      cancelSent: false,
      typingTimer: undefined,
      typingStarted: false,
    };
    this.#activeRuns.add(run);
    void this.#executeRun(run).catch(() => {
      // The run is always converted into a response or a fatal state.  This
      // guard protects the event loop if an injected adapter violates its
      // promise contract.
      this.#triggerFatal({
        code: "acp_transport",
        message: "Bridge turn failed",
      });
      this.#finishRun(run);
    });
  }

  #activeRunsForEntry(entry: MutableQueueEntry): boolean {
    for (const run of this.#activeRuns) {
      if (run.entry === entry) {
        return true;
      }
    }
    return false;
  }

  async #executeRun(run: ActiveRun): Promise<void> {
    try {
      if (this.#stopping || this.#fatal !== undefined) {
        return;
      }

      if (run.entry.event.body === "/reset") {
        try {
          // Commit the durable deletion before changing the live view.  A
          // failed replacement is fatal, and must not make the coordinator
          // look reset while the persisted mapping is still usable.
          if (!(await this.#prepareSessionState())) return;
          if (this.#loadSession) await this.#stateStore?.resetConversation(run.conversation.identity);
          this.#sessionStore.resetConversation(run.conversation.identity);
          run.conversation.sessionId = undefined;
        } catch {
          this.#triggerFatal({
            code: "state",
            message: "Private bridge state failure",
          });
          return;
        }
        this.#diagnostic("info", "room-context-reset", {
          roomId: run.room.roomId,
        });
        const resetParts = renderMatrixResponse({
          roomId: run.room.roomId,
          inboundEventId: run.entry.event.eventId,
          ...routingForEvent(run.entry.event),
          outcome: { kind: "reset" },
          maxOutputBytes: this.#config.limits.maxOutputBytes,
          maxMatrixMessageBytes: this.#config.limits.maxMatrixMessageBytes,
        });
        if (!(await this.#completeTerminal(run.entry.terminalCompletion))) {
          return;
        }
        await this.#deliverParts(run.room, resetParts, { retry: true });
        return;
      }

      const resolution = await this.#sessionForConversation(run.conversation);
      if (resolution.session === undefined) {
        if (resolution.methodFailure === true) {
          if (!(await this.#completeTerminal(run.entry.terminalCompletion))) return;
          await this.#deliverDescriptor(
            run.room.roomId,
            run.entry.event.eventId,
            { kind: "error" },
            routingForEvent(run.entry.event),
          );
          return;
        }
        if (
          resolution.creationFailure === true &&
          (resolution.failureCode === "acp_transport" || resolution.failureCode === "acp_protocol")
        ) {
          await this.#sessionCreationFailure(run, resolution.failureCode);
        }
        return;
      }
      const session = resolution.session;
      if (this.#stopping || this.#fatal !== undefined) {
        return;
      }

      const releasePermit = await this.#semaphore.acquire();
      if (releasePermit === undefined || this.#stopping || this.#fatal !== undefined) {
        releasePermit?.();
        return;
      }

      const controller = createCancellationController();
      // The coordinator supplies validated conversation routing. Preserve it
      // through eager text, activity originals, revisions and archive edits.
      const routing = routingForEvent(run.entry.event);
      const turn: TurnCollector = {
        ...routing,
        sessionId: session.sessionId,
        groups: [],
        activity: new AcpActivityModel(),
        activityBatches: new AcpActivityBatches({
          maxEvents: this.#config.limits.maxActivityEventsPerMessage,
          maxMessageBytes: this.#config.limits.maxMatrixMessageBytes,
          measure: (rendered) => matrixHtmlEditContentBytes({ ...rendered, ...routing }),
        }),
        batchDeliveries: new WeakMap(),
        outboundTail: Promise.resolve(),
        liveFailed: false,
        lastTextGroup: undefined,
        room: run.room,
        inboundEventId: run.entry.event.eventId,
        messageIds: new Set(),
        messageOrder: [],
        hasText: false,
        lastTextChangeAt: this.#clock.now(),
        promptResolved: false,
        drainComplete: false,
        closed: false,
        quietTimer: undefined,
        deadlineTimer: undefined,
        resolveDrain: undefined,
      };
      run.sessionId = session.sessionId;
      run.controller = controller;
      run.turn = turn;
      run.promptStarted = true;
      this.#turnsBySession.set(session.sessionId, turn);
      this.#unresolvedPrompts += 1;

      this.#startTyping(run);
      const prompt = await this.#awaitPrompt(run, controller, releasePermit);
      if (!run.promptResolved) {
        run.promptResolved = true;
        this.#unresolvedPrompts = Math.max(0, this.#unresolvedPrompts - 1);
      }
      if (prompt.graceExpired || this.#fatal !== undefined) {
        return;
      }
      const rawOutcome = prompt.outcome;
      if (rawOutcome === undefined) {
        this.#triggerFatal({
          code: "acp_transport",
          message: "ACP prompt failed",
        });
        return;
      }
      const outcome = normalizeStopReason(rawOutcome);
      if (isFatalAcpOutcome(outcome)) {
        this.#triggerFatal({
          code: outcome.kind === "protocol_error" ? "acp_protocol" : "acp_transport",
          message: "ACP prompt failed",
        });
        return;
      }

      let text = "";
      if (
        isRecord(outcome) &&
        typeof outcome.text === "string" &&
        joinedGroups(turn.groups).length === 0 &&
        outcome.text.length > 0
      ) {
        turn.groups.push({
          messageId: undefined,
          text: outcome.text,
          closed: false,
          sentLength: 0,
        });
        turn.lastTextGroup = turn.groups.at(-1);
        turn.hasText = true;
        turn.lastTextChangeAt = this.#clock.now();
      }

      const skipDrain = prompt.timedOut || outcome.kind === "method_error";
      if (!skipDrain && outcome.kind === "turn") {
        turn.promptResolved = true;
        const drained = await this.#drainTurn(turn);
        if (drained.fatal || this.#fatal !== undefined) {
          return;
        }
        text = drained.text;
      } else {
        turn.promptResolved = true;
        text = joinedGroups(turn.groups);
      }

      if (this.#stopping || this.#fatal !== undefined) {
        return;
      }

      this.#closeTextGroup(turn);
      await turn.outboundTail;
      if (this.#stopping || this.#fatal !== undefined) return;

      const unsent =
        this.#matrix.sendHtmlMessage === undefined
          ? text
          : joinedGroups(
              turn.groups.map((group) => ({
                ...group,
                text: group.text.slice(group.sentLength),
              })),
            );
      const streamed = this.#matrix.sendHtmlMessage !== undefined && text.length > 0 && unsent.length === 0;

      const response: RenderableResponse = prompt.timedOut
        ? { kind: "timeout", ...(unsent.length > 0 ? { text: unsent } : {}) }
        : outcome.kind === "method_error"
          ? { kind: "error", ...(unsent.length > 0 ? { text: unsent } : {}) }
          : {
              ...outcome,
              ...(unsent.length > 0 ? { text: unsent } : {}),
              ...(streamed ? { text: "" } : {}),
            };
      if (streamed && outcome.kind === "turn" && outcome.stopReason === "end_turn") {
        this.#stopTyping(run);
        await this.#completeTerminal(run.entry.terminalCompletion);
        return;
      }
      const parts = renderMatrixResponse({
        roomId: run.room.roomId,
        inboundEventId: run.entry.event.eventId,
        ...routingForEvent(run.entry.event),
        outcome: response,
        maxOutputBytes: this.#config.limits.maxOutputBytes,
        maxMatrixMessageBytes: this.#config.limits.maxMatrixMessageBytes,
      });
      this.#stopTyping(run);
      if (!(await this.#completeTerminal(run.entry.terminalCompletion))) {
        return;
      }
      await this.#deliverParts(run.room, parts, { retry: true });
    } finally {
      void this.#stopTyping(run);
      if (run.turn !== undefined && !run.turn.closed) {
        this.#closeTurn(run.turn);
      }
      this.#finishRun(run);
    }
  }

  async #sessionForConversation(conversation: ConversationState): Promise<SessionResolution> {
    if (!(await this.#prepareSessionState())) {
      return { failureCode: "state" };
    }
    if (conversation.sessionId !== undefined) {
      return { session: { sessionId: conversation.sessionId } };
    }
    const inMemory = this.#sessionStore.getConversationRecord(conversation.identity);
    if (inMemory !== undefined && typeof inMemory.sessionId === "string" && inMemory.sessionId.length > 0) {
      conversation.sessionId = inMemory.sessionId;
      return { session: { sessionId: inMemory.sessionId } };
    }

    if (this.#loadSession) {
      const sessionId = this.#stateStore?.getConversationRecord(conversation.identity)?.sessionId;
      if (sessionId !== undefined && sessionId.length > 0) {
        if (this.#acp.loadSession === undefined) {
          this.#triggerFatal({
            code: "acp_protocol",
            message: "ACP session loading is unavailable",
          });
          return { failureCode: "acp_protocol" };
        }

        this.#loadingSessions.add(sessionId);
        try {
          const session = await this.#acp.loadSession({
            ...sessionOptions(this.#config),
            sessionId,
          });
          // Test doubles and alternate adapters may surface normalized ACP
          // outcomes as resolved values despite the promise's session type.
          // Keep the same stale-vs-fatal classification in either form.
          if (isSessionLoadMethodError(session) || isFatalAcpOutcome(session)) {
            // ACP outcomes are structured protocol values, not Error instances.
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw session;
          }
          if (
            !isRecord(session) ||
            typeof session.sessionId !== "string" ||
            session.sessionId.length === 0 ||
            session.sessionId !== sessionId
          ) {
            this.#loadingSessions.delete(sessionId);
            this.#triggerFatal({
              code: "acp_protocol",
              message: "ACP session loading failed",
            });
            return { failureCode: "acp_protocol" };
          }
          conversation.sessionId = session.sessionId;
          this.#sessionStore.setConversationRecord({
            ...conversation.identity,
            sessionId: session.sessionId,
          });
          this.#loadingSessions.delete(sessionId);
          this.#diagnostic("info", "acp-session-loaded", {
            roomId: conversation.identity.roomId,
          });
          return { session: { sessionId: session.sessionId } };
        } catch (error) {
          this.#loadingSessions.delete(sessionId);
          if (isSessionLoadMethodError(error)) {
            try {
              // Delete the stale mapping before creating a replacement.  Each
              // mutation is an atomic state-document replacement, so a
              // failed replacement can never leave a misleading old mapping
              // looking usable after restart.
              await this.#stateStore?.resetConversation(conversation.identity);
            } catch {
              this.#triggerFatal({
                code: "state",
                message: "Private bridge state failure",
              });
              return { failureCode: "state" };
            }
            this.#sessionStore.resetConversation(conversation.identity);
            this.#diagnostic("warn", "stale-session-mapping-discarded", {
              roomId: conversation.identity.roomId,
            });
            this.#diagnostic("warn", "room-context-reset", {
              roomId: conversation.identity.roomId,
            });
          } else {
            this.#triggerFatal({
              code: isRecord(error) && error.kind === "protocol_error" ? "acp_protocol" : "acp_transport",
              message: "ACP session loading failed",
            });
            return { failureCode: sessionFailureCode(error) };
          }
        }
      }
    }
    try {
      if (
        this.#loadSession &&
        conversation.identity.kind === "thread" &&
        this.#stateStore?.getConversationRecord(conversation.identity) === undefined
      ) {
        try {
          await this.#stateStore?.setConversationRecord(conversation.identity);
        } catch {
          this.#triggerFatal({ code: "state", message: "Private bridge state failure" });
          return { failureCode: "state" };
        }
      }
      const session = await this.#acp.createSession(sessionOptions(this.#config));
      if (isMethodError(session) && conversation.identity.kind === "thread") return { methodFailure: true };
      if (isFatalAcpOutcome(session)) {
        return { failureCode: sessionFailureCode(session), creationFailure: true };
      }
      if (!isRecord(session) || typeof session.sessionId !== "string" || session.sessionId.length === 0) {
        throw new Error("invalid ACP session");
      }
      if (this.#loadSession && this.#stateStore !== undefined) {
        try {
          await this.#stateStore.setConversationRecord({ ...conversation.identity, sessionId: session.sessionId });
        } catch {
          this.#triggerFatal({
            code: "state",
            message: "Private bridge state failure",
          });
          return { failureCode: "state" };
        }
      }
      conversation.sessionId = session.sessionId;
      this.#sessionStore.setConversationRecord({ ...conversation.identity, sessionId: session.sessionId });
      return { session: { sessionId: session.sessionId } };
    } catch (error) {
      if (isMethodError(error) && conversation.identity.kind === "thread") return { methodFailure: true };
      return { failureCode: sessionFailureCode(error), creationFailure: true };
    }
  }

  async #prepareSessionState(): Promise<boolean> {
    if (this.#stateStore === undefined) {
      return true;
    }
    if (this.#sessionStatePreparation === undefined) {
      try {
        this.#sessionStatePreparation = (
          this.#loadSession
            ? this.#stateStore.pruneSessionMappings(this.#config.matrix.allowedRooms)
            : this.#stateStore.discardSessionMappings()
        ).then(() => {});
      } catch {
        this.#triggerFatal({
          code: "state",
          message: "Private bridge state failure",
        });
        return false;
      }
    }
    try {
      await this.#sessionStatePreparation;
      return true;
    } catch {
      this.#triggerFatal({
        code: "state",
        message: "Private bridge state failure",
      });
      return false;
    }
  }

  async #sessionCreationFailure(run: ActiveRun, failureCode: "acp_transport" | "acp_protocol"): Promise<void> {
    if (this.#stopping && this.#fatal === undefined) {
      return;
    }
    // The first affected event gets one best-effort generic response.  It is
    // deliberately attempted before the fatal state suppresses new output.
    const parts = renderMatrixResponse({
      roomId: run.room.roomId,
      inboundEventId: run.entry.event.eventId,
      ...routingForEvent(run.entry.event),
      outcome: { kind: "error" },
      maxOutputBytes: this.#config.limits.maxOutputBytes,
      maxMatrixMessageBytes: this.#config.limits.maxMatrixMessageBytes,
    });
    await this.#deliverParts(run.room, parts, {
      allowDuringStop: true,
      retry: false,
    });
    this.#triggerFatal({
      code: failureCode,
      message: "ACP session creation failed",
    });
  }

  #startTyping(run: ActiveRun): void {
    if (run.entry.event.body === "/reset" || this.#matrix.sendTyping === undefined) {
      return;
    }
    run.typingStarted = true;
    this.#sendTyping(run, true, "start");
    this.#scheduleTypingRefresh(run);
  }

  #scheduleTypingRefresh(run: ActiveRun): void {
    if (!run.typingStarted || this.#stopping || this.#fatal !== undefined) {
      return;
    }
    if (run.typingTimer !== undefined) {
      this.#clock.clearTimeout(run.typingTimer);
    }
    run.typingTimer = this.#clock.setTimeout(() => {
      run.typingTimer = undefined;
      if (!run.typingStarted) {
        return;
      }
      // Keep the cadence independent of an adapter promise. A stalled or
      // rejected ephemeral request must not become a bridge-managed retry or
      // prevent the next server timeout refresh from being attempted.
      this.#sendTyping(run, true, "refresh");
      this.#scheduleTypingRefresh(run);
    }, TYPING_REFRESH_MS);
  }

  #stopTyping(run: ActiveRun): void {
    if (run.typingTimer !== undefined) {
      this.#clock.clearTimeout(run.typingTimer);
      run.typingTimer = undefined;
    }
    if (!run.typingStarted) {
      return;
    }
    run.typingStarted = false;
    if (![...this.#activeRuns].some((other) => other.room === run.room && other.typingStarted)) {
      this.#sendTyping(run, false, "stop");
    }
  }

  #sendTyping(run: ActiveRun, isTyping: boolean, operation: "start" | "refresh" | "stop"): void {
    if (this.#matrix.sendTyping === undefined) {
      return;
    }
    try {
      void Promise.resolve(this.#matrix.sendTyping(run.room.roomId, isTyping, TYPING_TIMEOUT_MS)).catch(() => {
        this.#diagnostic("warn", "typing-operation-failed", {
          roomId: run.room.roomId,
          operation,
        });
      });
    } catch {
      this.#diagnostic("warn", "typing-operation-failed", {
        roomId: run.room.roomId,
        operation,
      });
    }
  }

  #receipt(event: InboundMatrixEvent): void {
    if (this.#matrix.sendReadReceipt === undefined || event.eventId === undefined) {
      return;
    }
    const eventId = event.eventId;
    try {
      void Promise.resolve(this.#matrix.sendReadReceipt(event.roomId, eventId)).catch(() => {
        this.#diagnostic("warn", "receipt-operation-failed", {
          roomId: event.roomId,
          eventId,
        });
      });
    } catch {
      this.#diagnostic("warn", "receipt-operation-failed", {
        roomId: event.roomId,
        eventId,
      });
    }
  }

  async #awaitPrompt(
    run: ActiveRun,
    controller: CancellationController,
    releasePermit: () => void,
  ): Promise<PromptResult> {
    let resolveResult!: (result: PromptResult) => void;
    let settled = false;
    let timedOut = false;
    let graceTimer: TimerHandle;
    const resultPromise = new Promise<PromptResult>((resolve) => {
      resolveResult = resolve;
    });

    const settle = (result: PromptResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (deadlineTimer !== undefined) {
        this.#clock.clearTimeout(deadlineTimer);
      }
      if (graceTimer !== undefined) {
        this.#clock.clearTimeout(graceTimer);
      }
      releasePermit();
      resolveResult(result);
    };

    const rawPrompt = Promise.resolve()
      .then(() => this.#acp.prompt(run.sessionId!, run.entry.event.body, controller.signal))
      .then(
        (outcome) => {
          settle({ outcome, timedOut, graceExpired: false });
        },
        (error: unknown) => {
          settle({ outcome: normalizeThrownPrompt(error), timedOut, graceExpired: false });
        },
      );
    void rawPrompt.catch(() => {});

    const deadlineTimer = this.#clock.setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      this.#stopTyping(run);
      this.#requestCancel(run, "turn deadline");
      graceTimer = this.#clock.setTimeout(() => {
        if (settled) {
          return;
        }
        this.#triggerFatal({
          code: "acp_transport",
          message: "ACP prompt cancellation grace expired",
        });
        settle({ outcome: undefined, timedOut: true, graceExpired: true });
      }, secondsToMilliseconds(this.#config.limits.shutdownGraceSeconds));
    }, secondsToMilliseconds(this.#config.limits.maxTurnSeconds));

    return resultPromise;
  }

  #requestCancel(run: ActiveRun, reason: string): void {
    if (run.cancelSent || run.sessionId === undefined) {
      return;
    }
    run.cancelSent = true;
    try {
      run.controller?.cancel(reason);
    } catch {
      // The explicit ACP cancellation below is still attempted.
    }
    let cancellation: Promise<void>;
    try {
      cancellation = this.#acp.cancel(run.sessionId);
    } catch (error) {
      this.#handleCancelFailure(error);
      return;
    }
    void Promise.resolve(cancellation).catch((error: unknown) => {
      this.#handleCancelFailure(error);
    });
  }

  #handleCancelFailure(error: unknown): void {
    if (isMethodError(error)) {
      return;
    }
    this.#triggerFatal({
      code: isRecord(error) && error.kind === "protocol_error" ? "acp_protocol" : "acp_transport",
      message: "ACP cancellation failed",
    });
  }

  async #drainTurn(turn: TurnCollector): Promise<DrainResult> {
    if (turn.closed || turn.drainComplete) {
      return { text: joinedGroups(turn.groups), fatal: false };
    }
    turn.promptResolved = true;
    if (turn.hasText && this.#clock.now() - turn.lastTextChangeAt >= QUIET_DRAIN_MS) {
      return { text: joinedGroups(turn.groups), fatal: false };
    }

    return new Promise<DrainResult>((resolve) => {
      turn.resolveDrain = resolve;
      this.#scheduleQuietDrain(turn);
      turn.deadlineTimer = this.#clock.setTimeout(() => {
        if (turn.closed || turn.resolveDrain === undefined) {
          return;
        }
        if (turn.hasText && this.#clock.now() - turn.lastTextChangeAt < QUIET_DRAIN_MS) {
          this.#finishDrain(turn, { text: "", fatal: true });
          this.#triggerFatal({
            code: "acp_protocol",
            message: "ACP output remained active after the drain cap",
          });
          return;
        }
        this.#finishDrain(turn, {
          text: joinedGroups(turn.groups),
          fatal: false,
        });
      }, STREAMING_DRAIN_CAP_MS);
    });
  }

  #scheduleQuietDrain(turn: TurnCollector): void {
    if (turn.closed || !turn.promptResolved || !turn.hasText) {
      return;
    }
    if (turn.quietTimer !== undefined) {
      this.#clock.clearTimeout(turn.quietTimer);
    }
    const elapsed = this.#clock.now() - turn.lastTextChangeAt;
    const delay = Math.max(0, QUIET_DRAIN_MS - elapsed);
    turn.quietTimer = this.#clock.setTimeout(() => {
      turn.quietTimer = undefined;
      if (turn.closed || turn.resolveDrain === undefined) {
        return;
      }
      if (this.#clock.now() - turn.lastTextChangeAt >= QUIET_DRAIN_MS) {
        this.#finishDrain(turn, {
          text: joinedGroups(turn.groups),
          fatal: false,
        });
      } else {
        this.#scheduleQuietDrain(turn);
      }
    }, delay);
  }

  #finishDrain(turn: TurnCollector, result: DrainResult): void {
    if (turn.closed || turn.drainComplete) {
      return;
    }
    turn.drainComplete = true;
    if (turn.quietTimer !== undefined) {
      this.#clock.clearTimeout(turn.quietTimer);
      turn.quietTimer = undefined;
    }
    if (turn.deadlineTimer !== undefined) {
      this.#clock.clearTimeout(turn.deadlineTimer);
      turn.deadlineTimer = undefined;
    }
    const resolve = turn.resolveDrain;
    turn.resolveDrain = undefined;
    resolve?.(result);
  }

  #closeTurn(turn: TurnCollector): void {
    if (turn.closed) {
      return;
    }
    turn.closed = true;
    turn.activity.close();
    if (turn.quietTimer !== undefined) {
      this.#clock.clearTimeout(turn.quietTimer);
    }
    if (turn.deadlineTimer !== undefined) {
      this.#clock.clearTimeout(turn.deadlineTimer);
    }
    if (this.#turnsBySession.get(turn.sessionId) === turn) {
      this.#turnsBySession.delete(turn.sessionId);
    }
    const closed = this.#closedMessageIds.get(turn.sessionId) ?? {
      set: new Set<string>(),
      order: [],
    };
    for (const messageId of turn.messageOrder) {
      if (closed.set.has(messageId)) {
        continue;
      }
      closed.set.add(messageId);
      closed.order.push(messageId);
      if (closed.order.length > CLOSED_MESSAGE_ID_LIMIT) {
        const oldest = closed.order.shift();
        if (oldest !== undefined) {
          closed.set.delete(oldest);
        }
      }
    }
    this.#closedMessageIds.set(turn.sessionId, closed);
  }

  #handleAcpUpdate(update: AcpUpdate): void {
    if (!isRecord(update) || typeof update.sessionId !== "string") {
      return;
    }
    if (this.#loadingSessions.has(update.sessionId)) {
      return;
    }
    const turn = this.#turnsBySession.get(update.sessionId);
    if (turn === undefined || turn.closed || turn.drainComplete) {
      return;
    }
    if (update.kind !== "agent_message_chunk") {
      if (update.kind === "agent_thought_chunk" || update.kind === "tool_call" || update.kind === "tool_call_update") {
        if (this.#matrix.sendHtmlMessage === undefined) return;
        const activity = turn.activity.accept(update);
        if (activity !== undefined) {
          if (update.kind === "tool_call" || (update.kind === "agent_thought_chunk" && update.text?.trim())) {
            this.#closeTextGroup(turn);
          }
          this.#acceptActivity(turn, activity);
        }
      }
      return;
    }
    if (typeof update.text !== "string" || update.text.length === 0) return;
    const messageId = update.messageId;
    if (messageId !== undefined && this.#closedMessageIds.get(update.sessionId)?.set.has(messageId)) {
      return;
    }
    if (messageId !== undefined && !turn.messageIds.has(messageId)) {
      turn.messageIds.add(messageId);
      turn.messageOrder.push(messageId);
    } else if (
      messageId !== undefined &&
      turn.lastTextGroup?.messageId !== messageId &&
      turn.groups.some((group) => group.messageId === messageId && group.closed)
    ) {
      return;
    }
    if (update.text.trim()) {
      for (const batch of turn.activityBatches.collapse()) this.#scheduleBatch(turn, batch);
    }
    turn.activity.accept(update);
    this.#appendText(turn, messageId, update.text);
    if (update.text.length > 0) {
      turn.hasText = true;
      turn.lastTextChangeAt = this.#clock.now();
      if (turn.promptResolved) {
        this.#scheduleQuietDrain(turn);
      }
    }
  }

  #appendText(turn: TurnCollector, messageId: string | undefined, value: string): void {
    if (turn.lastTextGroup !== undefined && turn.lastTextGroup.messageId !== messageId) {
      this.#closeTextGroup(turn);
    }
    let group = turn.lastTextGroup;
    if (group === undefined) {
      group = { messageId, text: "", closed: false, sentLength: 0 };
      turn.groups.push(group);
      turn.lastTextGroup = group;
    }
    group.text += value;
  }

  #closeTextGroup(turn: TurnCollector): void {
    const group = turn.lastTextGroup;
    if (group === undefined || group.closed) return;
    group.closed = true;
    turn.lastTextGroup = undefined;
    if (this.#matrix.sendHtmlMessage === undefined || turn.liveFailed || !group.text.trim()) return;
    this.#enqueueLive(turn, async () => {
      let chunks: readonly MatrixHtmlBody[];
      try {
        const routing = routingForTurn(turn);
        chunks = renderMatrixTextChunks(group.text, this.#config.limits.maxMatrixMessageBytes, (rendered) =>
          matrixHtmlContentBytes({ ...rendered, ...routing }),
        );
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        turn.liveFailed = true;
        this.#diagnostic("warn", "matrix-live-abandoned", { kind: "size" });
        return;
      }
      let offset = 0;
      for (const chunk of chunks) {
        if (turn.liveFailed) break;
        const id = await this.#deliverLive(turn, `text-${turn.groups.indexOf(group)}`, offset, chunk);
        if (id === undefined) {
          turn.liveFailed = true;
          break;
        }
        offset += [...chunk.body].length;
        group.sentLength += chunk.body.length;
      }
    });
  }

  #acceptActivity(turn: TurnCollector, activity: AcpActivity): void {
    if (this.#matrix.sendHtmlMessage === undefined) return;
    for (const batch of turn.activityBatches.accept(activity)) this.#scheduleBatch(turn, batch);
  }

  #enqueueLive(turn: TurnCollector, operation: () => Promise<void>): void {
    turn.outboundTail = turn.outboundTail.then(operation).catch(() => {
      turn.liveFailed = true;
      this.#diagnostic("warn", "matrix-live-abandoned", { kind: "unexpected" });
    });
  }

  #scheduleBatch(turn: TurnCollector, batch: ActivityBatch): void {
    if (this.#matrix.sendHtmlMessage === undefined || turn.liveFailed) return;
    let delivery = turn.batchDeliveries.get(batch);
    if (delivery === undefined) {
      delivery = { revision: 0, pending: false, dirty: false };
      turn.batchDeliveries.set(batch, delivery);
    }
    const state = delivery;
    state.dirty = true;
    if (state.pending) return;
    state.pending = true;
    // Capture the first expanded view before queued sends or a later agent
    // message can collapse this batch. Otherwise its original event may arrive
    // already collapsed, with no live version for the user to see.
    const initial = state.eventId === undefined ? turn.activityBatches.render(batch) : undefined;
    this.#enqueueLive(turn, async () => {
      try {
        let first = initial;
        while (state.dirty && !turn.liveFailed) {
          state.dirty = false;
          const rendered = first ?? turn.activityBatches.render(batch);
          first = undefined;
          if (
            matrixHtmlEditContentBytes({ ...rendered, ...routingForTurn(turn) }) >
            this.#config.limits.maxMatrixMessageBytes
          ) {
            turn.liveFailed = true;
            this.#diagnostic("warn", "matrix-live-abandoned", { kind: "size" });
            break;
          }
          const id = await this.#deliverLive(
            turn,
            `activity-${batch.index}`,
            state.revision++,
            rendered,
            state.eventId,
          );
          if (id === undefined) {
            turn.liveFailed = true;
            break;
          }
          state.eventId = id;
          if (rendered === initial) {
            const current = turn.activityBatches.render(batch);
            if (current.body !== rendered.body || current.formattedBody !== rendered.formattedBody) state.dirty = true;
          }
        }
      } finally {
        state.pending = false;
      }
    });
  }

  async #deliverLive(
    turn: TurnCollector,
    kind: string,
    revision: number,
    rendered: MatrixHtmlBody,
    targetEventId?: MatrixEventId,
  ): Promise<MatrixEventId | undefined> {
    if (this.#matrix.sendHtmlMessage === undefined || this.#stopping || this.#fatal !== undefined) return;
    if (
      matrixHtmlContentBytes({ ...rendered, ...routingForTurn(turn) }, targetEventId) >
      this.#config.limits.maxMatrixMessageBytes
    ) {
      this.#diagnostic("warn", "matrix-live-abandoned", { kind: "size" });
      return;
    }
    const message: MatrixHtmlMessage = {
      ...routingForTurn(turn),
      roomId: turn.room.roomId,
      transactionId: liveTransactionId(turn, kind, 0, revision),
      body: rendered.body,
      formattedBody: rendered.formattedBody as MatrixSafeHtml,
      ...(targetEventId === undefined ? {} : { targetEventId }),
    };
    this.#outboundOperations += 1;
    try {
      return await turn.room.outbound.run(async () => {
        let attempt = 0;
        for (;;) {
          if (this.#stopping || this.#fatal !== undefined) return;
          try {
            return await this.#matrix.sendHtmlMessage!(message);
          } catch (error) {
            const failure = matrixFailureFor(error);
            if (!failure.retryable) {
              this.#diagnostic("warn", "matrix-live-abandoned", {
                kind: "delivery",
              });
              return;
            }
            const delay = retryDelay(failure, attempt++, this.#random);
            if (!(await this.#waitForRetry(delay))) return;
          }
        }
      });
    } finally {
      this.#outboundOperations = Math.max(0, this.#outboundOperations - 1);
      this.#resolveIdleWaiters();
      this.#maybeFinalizeStop();
    }
  }

  async #deliverDescriptor(
    roomId: MatrixRoomId,
    inboundEventId: MatrixEventId,
    descriptor: MatrixResponseDescriptor,
    routing: MatrixOutputRouting = {},
  ): Promise<void> {
    if (this.#stopping || this.#fatal !== undefined) {
      return;
    }
    const parts = renderMatrixResponse({
      roomId,
      inboundEventId,
      outcome: descriptor,
      ...routing,
      maxOutputBytes: this.#config.limits.maxOutputBytes,
      maxMatrixMessageBytes: this.#config.limits.maxMatrixMessageBytes,
    });
    await this.#deliverParts(this.#room(roomId), parts, { retry: true });
  }

  async #deliverParts(
    room: RoomState,
    parts: readonly RenderedMatrixPart[],
    options: DeliveryOptions = {},
  ): Promise<boolean> {
    if (
      (this.#stopping && options.allowDuringStop !== true) ||
      (this.#fatal !== undefined && options.allowDuringStop !== true)
    ) {
      return false;
    }
    this.#outboundOperations += 1;
    try {
      return await room.outbound.run(async () => {
        let attempt = 0;
        for (const part of parts) {
          while (true) {
            let sent = false;
            try {
              await this.#matrix.sendMessage(part);
              sent = true;
            } catch (error) {
              const failure = matrixFailureFor(error);
              if (options.retry === false || !failure.retryable || this.#stopping || this.#fatal !== undefined) {
                this.#diagnostic("warn", "matrix-response-abandoned", {
                  roomId: room.roomId,
                  eventId: part.inboundEventId,
                  responseKind: part.responseKind,
                  partNumber: part.partNumber,
                });
                return false;
              }
              const delay = retryDelay(failure, attempt, this.#random);
              attempt += 1;
              if (!(await this.#waitForRetry(delay))) {
                return false;
              }
            }
            if (sent) {
              attempt = 0;
              break;
            }
          }
        }
        return true;
      });
    } finally {
      this.#outboundOperations = Math.max(0, this.#outboundOperations - 1);
      this.#resolveIdleWaiters();
      this.#maybeFinalizeStop();
    }
  }

  #waitForRetry(delayMs: number): Promise<boolean> {
    if (this.#stopping || this.#fatal !== undefined) {
      return Promise.resolve(false);
    }
    // The cancellation callback closes over the timer before it is created.
    // eslint-disable-next-line prefer-const -- timer initialization follows wait construction
    let timer: TimerHandle;
    let settled = false;
    let resolveWait!: (completed: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolveWait = resolve;
    });
    const wait: RetryWait = {
      cancel: () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          this.#clock.clearTimeout(timer);
        }
        this.#retryWaits.delete(wait);
        resolveWait(false);
      },
    };
    this.#retryWaits.add(wait);
    timer = this.#clock.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      this.#retryWaits.delete(wait);
      resolveWait(true);
    }, clampTimer(delayMs));
    return promise;
  }

  #finishRun(run: ActiveRun): void {
    this.#activeRuns.delete(run);
    if (run.promptStarted && !run.promptResolved) {
      run.promptResolved = true;
      this.#unresolvedPrompts = Math.max(0, this.#unresolvedPrompts - 1);
    }
    if (run.conversation.active === run.entry) {
      run.conversation.active = undefined;
    }
    if (!run.entry.completed) {
      run.entry.completed = true;
      run.entry.resolve();
    }
    if (!this.#stopping && this.#fatal === undefined && this.#dispatchOpen) {
      this.#pumpConversation(run.conversation);
    }
    this.#maybeFinalizeStop();
    this.#resolveIdleWaiters();
  }

  #dropWaitingTurns(): void {
    for (const room of this.#rooms.values()) {
      for (const conversation of room.conversations.values()) {
        if (conversation.active !== undefined && !this.#activeRunsForEntry(conversation.active)) {
          const entry = conversation.active;
          conversation.active = undefined;
          if (!entry.completed) {
            entry.completed = true;
            entry.resolve();
          }
        }
        for (const entry of conversation.waiting.splice(0)) {
          if (!entry.completed) {
            entry.completed = true;
            entry.resolve();
          }
        }
      }
    }
    this.#resolveIdleWaiters();
  }

  #isIdle(): boolean {
    if (this.#activeRuns.size > 0 || this.#outboundOperations > 0) {
      return false;
    }
    for (const room of this.#rooms.values()) {
      for (const conversation of room.conversations.values()) {
        if (conversation.active !== undefined || conversation.waiting.length > 0) {
          return false;
        }
      }
    }
    return true;
  }

  #resolveIdleWaiters(): void {
    if (!this.#isIdle()) {
      return;
    }
    for (const resolve of this.#idleWaiters) {
      this.#idleWaiters.delete(resolve);
      resolve();
    }
  }

  #triggerFatal(error: FatalError): void {
    if (this.#fatal !== undefined) {
      return;
    }
    this.#fatal = error;
    this.#intakeOpen = false;
    this.#dispatchOpen = false;
    try {
      this.#matrix.stopIntake();
    } catch {
      // The adapter's own fatal state remains authoritative.
    }
    this.#dropWaitingTurns();
    this.#semaphore.cancelWaiters();
    for (const listener of this.#fatalListeners) {
      try {
        listener(error);
      } catch {
        // Preserve notification to the remaining listeners.
      }
    }
    // A fatal ACP/Matrix transport is a shutdown condition.  Starting the
    // idempotent graceful path here lets main observe the fatal notification
    // while still ensuring adapter resources are released.
    void this.stop();
  }

  #maybeFinalizeStop(): void {
    if (!this.#stopping || this.#stopFinalizeStarted) {
      return;
    }
    if (this.#activeRuns.size > 0 || this.#outboundOperations > 0) {
      return;
    }
    this.#finalizeStop(false);
  }

  #finalizeStop(_forced: boolean): void {
    if (this.#stopFinalizeStarted) {
      return;
    }
    this.#stopFinalizeStarted = true;
    if (this.#stopDeadlineTimer !== undefined) {
      this.#clock.clearTimeout(this.#stopDeadlineTimer);
      this.#stopDeadlineTimer = undefined;
    }
    for (const wait of this.#retryWaits) {
      wait.cancel();
    }
    for (const subscription of this.#subscriptions.splice(0)) {
      try {
        subscription();
      } catch {
        // Listener cleanup is best effort.
      }
    }
    const closeAdapters = async (): Promise<void> => {
      if (_forced) {
        await Promise.allSettled([
          Promise.resolve().then(() => this.#matrix.stop()),
          Promise.resolve().then(() => this.#acp.close()),
        ]);
        return;
      }
      // Resources are acquired in ACP -> Matrix order. Release them in the
      // reverse order on the normal path so a partial startup cannot leave a
      // lower-level transport alive after its coordinator is gone.
      await Promise.resolve()
        .then(() => this.#matrix.stop())
        .catch(() => {});
      await Promise.resolve()
        .then(() => this.#acp.close())
        .catch(() => {});
    };
    void closeAdapters().then(() => {
      this.#stopped = true;
      this.#resolveStop?.();
      this.#resolveStop = undefined;
    });
  }

  #diagnostic(level: "debug" | "info" | "warn" | "error", event: string, fields: DiagnosticFields): void {
    try {
      this.#diagnostics?.emit(level, event, fields);
    } catch {
      // Diagnostics are never allowed to poison the bridge.
    }
  }
}
