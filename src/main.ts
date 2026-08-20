import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadConfiguration,
  type LoadedConfiguration,
  type StateLockLike,
} from "./config.js";
import type { BridgeConfig } from "./config.js";
import {
  BridgeStateError,
  openBridgeStateStore,
  type BridgeStateStore,
} from "./bridge-state.js";
import { createAcpClient } from "./acp-client.js";
import type { AcpClient } from "./acp-client.js";
import { createRateLimitedDiagnosticSink, createStderrDiagnosticSink } from "./diagnostics.js";
import { BridgeCoordinator } from "./bridge.js";
import type { BridgeTerminalCompletion } from "./bridge.js";
import { assertMatrixIdentity, createMatrixClientAdapter } from "./matrix-client.js";
import { systemClock } from "./clock.js";
import type { Clock } from "./clock.js";
import type { Unsubscribe } from "./cancellation.js";
import type { DiagnosticSink, FatalError } from "./diagnostics.js";
import { MatrixSyncCoordinator } from "./sync-coordinator.js";
import { defaultOperatorTtyFactory } from "./operator-tty.js";
import {
  CryptoVerificationError,
  MatrixCryptoVerificationOperation,
} from "./crypto-verification.js";
import {
  CryptoStateError,
  openCryptoStateStore,
  ensureCryptoDatabaseDirectory,
  withPrivateCryptoCreationMask,
  type PrivateCryptoStateStore,
} from "./crypto-state.js";
import {
  validateCryptoCommand,
  cryptoStatePaths,
} from "./crypto-runtime.js";
import type { CryptoCommand } from "./crypto-contracts.js";
import type {
  CryptoVerificationOperation,
} from "./crypto-verification.js";
import type { CryptoManifest } from "./crypto-state.js";
import type { OperatorTtyFactory } from "./operator-tty.js";
import { isValidMatrixDeviceId } from "./matrix-validation.js";
import type {
  InboundMatrixEvent,
  MatrixClientAdapter,
  MatrixIdentity,
  MatrixSyncStateChange,
} from "./matrix-client.js";

const MAX_TIMER_MS = 2_147_483_647;

export type DaemonSignal = "SIGINT" | "SIGTERM";
export type DaemonExitCode = 0 | 1;

export class CliArgumentError extends Error {
  readonly code = "cli" as const;

  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

export class StartupTimeoutError extends Error {
  readonly code = "startup_timeout" as const;

  constructor() {
    super("Daemon startup timed out");
    this.name = "StartupTimeoutError";
  }
}

class ShutdownRequestedError extends Error {
  readonly exitCode: DaemonExitCode;

  constructor(exitCode: DaemonExitCode) {
    super("Daemon shutdown requested");
    this.name = "ShutdownRequestedError";
    this.exitCode = exitCode;
  }
}

export interface CliOptions {
  readonly configPath: string;
  /** Omitted for the ordinary daemon form. */
  readonly command?: CryptoCommand;
}

const CLI_USAGE = [
  "Usage:",
  "  matrix-acp-bridge --config <config-file>",
  "  matrix-acp-bridge --config <config-file> crypto bootstrap",
  "  matrix-acp-bridge --config <config-file> crypto verify --device <device-id>",
].join("\n");

function validConfigPath(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("--") &&
    !value.includes("\u0000");
}

/** Parse the exact crypto command forms; no argument reordering is allowed. */
export function parseCommandLine(args: readonly string[]): CliOptions {
  if (!Array.isArray(args) || args.length < 2 || args[0] !== "--config") {
    throw new CliArgumentError(CLI_USAGE);
  }
  const configPath = (args as readonly string[])[1];
  if (
    !validConfigPath(configPath)
  ) {
    throw new CliArgumentError("--config requires one configuration file path");
  }
  if (args.length === 2) {
    return { configPath };
  }
  if (args.length === 4 && args[2] === "crypto" && args[3] === "bootstrap") {
    return { configPath, command: { kind: "bootstrap" } };
  }
  if (
    args.length === 6 &&
    args[2] === "crypto" &&
    args[3] === "verify" &&
    args[4] === "--device" &&
    isValidMatrixDeviceId(args[5])
  ) {
    return { configPath, command: { kind: "verify", deviceId: args[5] } };
  }
  throw new CliArgumentError(CLI_USAGE);
}

/** Validate the config-dependent part of a parsed one-shot crypto command. */
export function validateCommandForConfig(
  command: CryptoCommand,
  config: BridgeConfig,
): void {
  try {
    validateCryptoCommand(command, config.matrix);
  } catch (error) {
    if (error instanceof Error) {
      throw new CliArgumentError(error.message);
    }
    throw new CliArgumentError("Invalid crypto command");
  }
}

export interface DaemonSignalSource {
  on(event: DaemonSignal, listener: () => void): unknown;
  off?(event: DaemonSignal, listener: () => void): unknown;
  removeListener?(event: DaemonSignal, listener: () => void): unknown;
}

export interface DaemonProcessLike extends DaemonSignalSource {
  readonly argv?: readonly string[];
  exit?(code?: number): never;
}

export interface DaemonBridge {
  /** Keep both Matrix intake and ACP dispatch closed before startup. */
  beginStartup(): void;
  /** Open post-PREPARED Matrix intake while retaining the dispatch gate. */
  openIntake(): void;
  /** Allow admitted startup-buffered events to reach ACP. */
  enableDispatch(): void;
  handleTimelineEvent(event: InboundMatrixEvent, terminalCompletion?: BridgeTerminalCompletion): Promise<void>;
  onFatalError(listener: (error: FatalError) => void): Unsubscribe;
  stop(): Promise<void>;
}

export interface DaemonFactoryContext {
  readonly config: BridgeConfig;
  readonly accessToken: string;
  readonly diagnostics: DiagnosticSink;
  readonly clock: Clock;
}

export interface DaemonFactories {
  readonly createAcpClient?: (context: DaemonFactoryContext) => AcpClient;
  readonly createMatrixClient?: (context: DaemonFactoryContext) => MatrixClientAdapter;
  readonly createBridge?: (context: {
    readonly config: BridgeConfig;
    readonly acp: AcpClient;
    readonly matrix: MatrixClientAdapter;
    readonly diagnostics: DiagnosticSink;
    readonly clock: Clock;
    readonly stateStore: BridgeStateStore;
    readonly loadSession: boolean;
  }) => DaemonBridge;
}

export interface DaemonDependencies extends DaemonFactories {
  readonly loadConfiguration?: (configPath: string) => Promise<LoadedConfiguration>;
  readonly clock?: Clock;
  readonly diagnostics?: DiagnosticSink;
  readonly process?: DaemonProcessLike;
  /** Test and embedding hook; the default is process.exit. */
  readonly exit?: (code: number) => never | void;
  /** Do not install process signal handlers when embedding the lifecycle. */
  readonly installSignals?: boolean;
  /** Separately opened operator terminal for the one-shot SAS command. */
  readonly operatorTtyFactory?: OperatorTtyFactory;
}

export interface RunDaemonOptions extends DaemonDependencies {
  readonly argv?: readonly string[];
  readonly configPath?: string;
  /** Optional parsed one-shot crypto command for embedders. */
  readonly command?: CryptoCommand;
  /** Use a preloaded configuration in hermetic lifecycle tests. */
  readonly loadedConfiguration?: LoadedConfiguration;
}

export interface DaemonRunResult {
  readonly exitCode: DaemonExitCode;
  readonly forcedShutdown: boolean;
}

function timerMilliseconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  return Math.min(MAX_TIMER_MS, Math.floor(seconds * 1000));
}

function defaultDiagnostics(): DiagnosticSink {
  return createRateLimitedDiagnosticSink(createStderrDiagnosticSink());
}

function emitDiagnostic(
  diagnostics: DiagnosticSink,
  level: "debug" | "info" | "warn" | "error",
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>> = {},
): void {
  try {
    diagnostics.emit(level, event, fields);
  } catch {
    // Diagnostics must never prevent cleanup or alter the exit path.
  }
}

function defaultAcpFactory(context: DaemonFactoryContext): AcpClient {
  const options = {
    cwd: context.config.acp.cwd,
    diagnostics: context.diagnostics,
  } as const;
  return createAcpClient(options);
}

function defaultMatrixFactory(context: DaemonFactoryContext): MatrixClientAdapter {
  return createMatrixClientAdapter(context.config.matrix, context.accessToken, {
    diagnostics: context.diagnostics,
  });
}

function defaultBridgeFactory(context: {
  readonly config: BridgeConfig;
  readonly acp: AcpClient;
  readonly matrix: MatrixClientAdapter;
  readonly diagnostics: DiagnosticSink;
  readonly clock: Clock;
  readonly stateStore: BridgeStateStore;
  readonly loadSession: boolean;
}): DaemonBridge {
  return new BridgeCoordinator({
    config: context.config,
    acp: context.acp,
    matrix: context.matrix,
    diagnostics: context.diagnostics,
    clock: context.clock,
    stateStore: context.stateStore,
    loadSession: context.loadSession,
    intakeOpen: false,
    dispatchOpen: false,
  });
}

function removeSignalListener(
  processLike: DaemonSignalSource,
  signal: DaemonSignal,
  listener: () => void,
): void {
  try {
    if (processLike.off === undefined) {
      processLike.removeListener?.(signal, listener);
    } else {
      processLike.off(signal, listener);
    }
  } catch {
    // Signal cleanup is best effort during shutdown.
  }
}

function signalExitCode(signal: DaemonSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

function safeFailureReason(error: unknown): string {
  if (error instanceof CliArgumentError) {
    return "invalid command line";
  }
  if (error instanceof StartupTimeoutError) {
    return "startup timeout";
  }
  if (error instanceof ShutdownRequestedError) {
    return "shutdown requested";
  }
  if (error instanceof Error && error.name === "ConfigurationError") {
    return "configuration error";
  }
  if (error instanceof Error && error.name === "MatrixIdentityMismatchError") {
    return "Matrix identity mismatch; verify the configured identity before resetting private bridge state";
  }
  if (error instanceof BridgeStateError) {
    return error.category === "identity-mismatch"
      ? "private state identity mismatch; verify the configured Matrix identity before resetting bridge state"
      : "private state failure; inspect bridge state and reset it only after verifying the configured Matrix identity";
  }
  if (error instanceof CryptoStateError) {
    return `private crypto state failure (${error.category}); ${error.recoveryGuidance}`;
  }
  return "startup failure";
}

function emitCryptoFailure(
  diagnostics: DiagnosticSink,
  event: string,
  error: unknown,
  fallback: string,
): void {
  if (error instanceof CryptoStateError) {
    emitDiagnostic(diagnostics, "error", event, {
      reason: error.category,
      recoveryAction: error.recoveryAction,
      recoveryGuidance: error.recoveryGuidance,
    });
    return;
  }
  if (error instanceof CryptoVerificationError) {
    emitDiagnostic(diagnostics, "error", event, { reason: error.reason });
    return;
  }
  emitDiagnostic(diagnostics, "error", event, { reason: fallback });
}

function safeFatalReason(error: FatalError): string {
  switch (error.code) {
    case "acp_transport": {
      return "ACP transport failure";
    }
    case "acp_protocol": {
      return "ACP protocol failure";
    }
    case "matrix_transport": {
      return "Matrix transport failure";
    }
    case "matrix_invariant": {
      return "Matrix room invariant failure";
    }
    case "state": {
      return "private state failure";
    }
    case "shutdown": {
      return "shutdown failure";
    }
    default: {
      return "startup failure";
    }
  }
}

interface TerminationRequest {
  readonly exitCode: DaemonExitCode;
  readonly signal?: DaemonSignal;
}

interface CleanupResult {
  readonly forced: boolean;
}

/**
 * Owns daemon composition and lifecycle policy.  Adapters remain responsible
 * for their protocols; this class only orders them, gates intake/dispatch,
 * and releases resources on every path.
 */
export class DaemonLifecycle {
  readonly #configPath: string | undefined;
  readonly #preloaded: LoadedConfiguration | undefined;
  readonly #dependencies: DaemonDependencies;
  readonly #clock: Clock;
  readonly #diagnostics: DiagnosticSink;
  readonly #processLike: DaemonProcessLike;

  #loaded: LoadedConfiguration | undefined;
  #acp: AcpClient | undefined;
  #matrix: MatrixClientAdapter | undefined;
  #bridge: DaemonBridge | undefined;
  #stateStore: BridgeStateStore | undefined;
  #cryptoStateStore: PrivateCryptoStateStore | undefined;
  #stateLock: StateLockLike | undefined;
  readonly #fatalUnsubscribes: Unsubscribe[] = [];
  #syncUnsubscribe: Unsubscribe | undefined;
  #syncBatchUnsubscribe: Unsubscribe | undefined;
  #syncCoordinator: MatrixSyncCoordinator | undefined;
  #signalListeners: Array<{ readonly signal: DaemonSignal; readonly listener: () => void }> = [];
  #signalReceived = false;
  #fatal: FatalError | undefined;
  #termination: TerminationRequest | undefined;
  #resolveTermination!: (request: TerminationRequest) => void;
  readonly #terminationPromise: Promise<TerminationRequest>;
  #cleanupPromise: Promise<CleanupResult> | undefined;
  #lockReleasePromise: Promise<void> | undefined;
  #matrixStopPromise: Promise<void> | undefined;
  #acpClosePromise: Promise<void> | undefined;
  #cryptoClosePromise: Promise<void> | undefined;
  #forcedShutdown = false;
  #shutdownFailed = false;

  constructor(options: {
    readonly configPath?: string;
    readonly loadedConfiguration?: LoadedConfiguration;
    readonly dependencies?: DaemonDependencies;
  } = {}) {
    if (options.configPath === undefined && options.loadedConfiguration === undefined) {
      throw new TypeError("DaemonLifecycle requires a config path or loaded configuration");
    }
    this.#configPath = options.configPath;
    this.#preloaded = options.loadedConfiguration;
    this.#dependencies = options.dependencies ?? {};
    this.#clock = this.#dependencies.clock ?? systemClock;
    this.#diagnostics = this.#dependencies.diagnostics ?? defaultDiagnostics();
    this.#processLike = this.#dependencies.process ?? process;
    this.#terminationPromise = new Promise<TerminationRequest>((resolveTermination) => {
      this.#resolveTermination = resolveTermination;
    });
  }

  get bridge(): DaemonBridge | undefined {
    return this.#bridge;
  }

  get acp(): AcpClient | undefined {
    return this.#acp;
  }

  get matrix(): MatrixClientAdapter | undefined {
    return this.#matrix;
  }

  get stateLock(): StateLockLike | undefined {
    return this.#stateLock;
  }

  get fatalError(): FatalError | undefined {
    return this.#fatal;
  }

  get forcedShutdown(): boolean {
    return this.#forcedShutdown;
  }

  /** Execute startup, wait for a signal/fatal event, then shut down. */
  async run(): Promise<DaemonExitCode> {
    this.#installSignalHandlers();
    let requestedExitCode: DaemonExitCode = 0;

    try {
      await this.#loadAndStart();
      if (this.#termination === undefined) {
        const termination = await this.#terminationPromise;
        requestedExitCode = termination.exitCode;
      } else {
        requestedExitCode = this.#termination.exitCode;
      }
    } catch (error) {
      if (error instanceof ShutdownRequestedError) {
        requestedExitCode = error.exitCode;
      } else {
        requestedExitCode = 1;
        emitDiagnostic(this.#diagnostics, "error", "startup-failed", {
          reason: safeFailureReason(error),
        });
      }
    }

    if (this.#fatal !== undefined) {
      requestedExitCode = 1;
    }

    const cleanup = await this.#cleanup();
    if (cleanup.forced || this.#fatal !== undefined || this.#shutdownFailed) {
      requestedExitCode = 1;
    }
    this.#removeSignalHandlers();
    return requestedExitCode;
  }

  /** Request a graceful stop, or a fatal stop with exit code 1. */
  requestShutdown(exitCode: DaemonExitCode = 0): void {
    this.#requestTermination({ exitCode });
  }

  /** Test-friendly signal entry point with the same second-signal behavior. */
  receiveSignal(signal: DaemonSignal): void {
    this.#handleSignal(signal);
  }

  async cleanup(): Promise<DaemonRunResult> {
    const cleanup = await this.#cleanup();
    this.#removeSignalHandlers();
    return {
      exitCode: cleanup.forced || this.#fatal !== undefined || this.#shutdownFailed ? 1 : 0,
      forcedShutdown: cleanup.forced,
    };
  }

  async #loadAndStart(): Promise<void> {
    this.#loaded = this.#preloaded ?? await (this.#dependencies.loadConfiguration ?? loadConfiguration)(
      this.#configPath!,
    );
    this.#stateLock = this.#loaded.stateLock;
    this.#checkShutdownRequest();

    const context: DaemonFactoryContext = {
      config: this.#loaded.config,
      accessToken: this.#loaded.accessToken,
      diagnostics: this.#diagnostics,
      clock: this.#clock,
    };
    const createAcp = this.#dependencies.createAcpClient ?? defaultAcpFactory;
    const createMatrix = this.#dependencies.createMatrixClient ?? defaultMatrixFactory;
    const createBridge = this.#dependencies.createBridge ?? defaultBridgeFactory;

    await this.#raceStartup(
      () => this.#startAdapters(context, createAcp, createMatrix, createBridge),
      context.config.limits.startupTimeoutSeconds,
    );
  }

  async #startAdapters(
    context: DaemonFactoryContext,
    createAcp: (context: DaemonFactoryContext) => AcpClient,
    createMatrix: (context: DaemonFactoryContext) => MatrixClientAdapter,
    createBridge: (context: {
      readonly config: BridgeConfig;
      readonly acp: AcpClient;
      readonly matrix: MatrixClientAdapter;
      readonly diagnostics: DiagnosticSink;
      readonly clock: Clock;
      readonly stateStore: BridgeStateStore;
      readonly loadSession: boolean;
    }) => DaemonBridge,
  ): Promise<void> {
    this.#checkShutdownRequest();
    emitDiagnostic(this.#diagnostics, "info", "startup-begin");

    const requiredCrypto = context.config.matrix.encryption === "required";
    const matrix = createMatrix(context);
    this.#matrix = matrix;
    this.#addFatalSubscription(matrix, (error) => {
      this.#handleFatal(error);
    });
    if (requiredCrypto) {
      await this.#prepareRequiredCrypto(context);
    }
    this.#checkShutdownRequest();
    const identity: MatrixIdentity = await matrix.whoAmI();
    assertMatrixIdentity(identity, context.config.matrix);
    if (requiredCrypto) {
      const fingerprints = await matrix.getDeviceKeyFingerprints?.();
      if (fingerprints === undefined || this.#cryptoStateStore === undefined) {
        throw new Error("Required Matrix crypto adapter is incomplete");
      }
      this.#cryptoStateStore.assertReadyForDaemon(fingerprints);
    }
    this.#checkShutdownRequest();

    this.#acp = createAcp(context);
    this.#addFatalSubscription(this.#acp, (error) => {
      this.#handleFatal(error);
    });
    this.#checkShutdownRequest();
    const initializeResult = await this.#acp.initialize({
      protocolVersion: 1,
      capabilities: { filesystem: false, terminal: false },
    });
    if (initializeResult.protocolVersion !== 1) {
      throw new Error("ACP initialization failed");
    }
    this.#checkShutdownRequest();

    const loadSession = initializeResult.agentCapabilities?.loadSession === true;
    this.#stateStore = await openBridgeStateStore({
      stateDir: context.config.stateDir,
      identity: {
        homeserver: context.config.matrix.homeserver,
        userId: identity.userId,
        deviceId: identity.deviceId,
      },
      diagnostics: this.#diagnostics,
    });
    await (loadSession ? this.#stateStore.pruneSessionMappings(context.config.matrix.allowedRooms) : this.#stateStore.discardSessionMappings());
    const initialized = this.#stateStore.getSnapshot().initialized;
    if (initialized) {
      emitDiagnostic(this.#diagnostics, "info", "completed-event-ledger-loaded");
    }

    this.#bridge = createBridge({
      config: context.config,
      acp: this.#acp,
      matrix,
      diagnostics: this.#diagnostics,
      clock: this.#clock,
      stateStore: this.#stateStore,
      loadSession,
    });
    const bridge = this.#bridge;
    bridge.beginStartup();
    this.#addFatalSubscription(bridge, (error) => {
      this.#handleFatal(error);
    });
    this.#checkShutdownRequest();

    this.#syncUnsubscribe = matrix.onSyncState((change: MatrixSyncStateChange) => {
      if (change.state === "RECONNECTING") {
        emitDiagnostic(this.#diagnostics, "warn", "matrix-reconnect");
      } else if (change.state === "SYNCING" && change.previousState === "RECONNECTING") {
        emitDiagnostic(this.#diagnostics, "info", "matrix-return-to-syncing");
      }
    });

    const coordinator = new MatrixSyncCoordinator({
      config: context.config,
      bridge: {
        openIntake: () => bridge.openIntake(),
        enableDispatch: () => bridge.enableDispatch(),
        consumesTerminalCompletion: true,
        handleTimelineEvent: (event, terminalCompletion) => bridge.handleTimelineEvent(event, terminalCompletion),
      },
      stateStore: this.#stateStore,
      diagnostics: this.#diagnostics,
      clock: this.#clock,
      onFatal: (error) => this.#handleFatal(error),
    });
    this.#syncCoordinator = coordinator;
    this.#syncBatchUnsubscribe = matrix.onSyncBatch((batch) => coordinator.handleBatch(batch));
    await matrix.start({});
    this.#checkShutdownRequest();

    emitDiagnostic(this.#diagnostics, "info", "startup-ready");
  }

  /**
   * Required-mode startup is deliberately prepared before ACP is opened:
   * existing crypto state must be proven usable before sync or bridge intake
   * can be created. Normal daemon startup never creates crypto state.
   */
  async #prepareRequiredCrypto(context: DaemonFactoryContext): Promise<void> {
    const matrix = this.#matrix;
    if (matrix === undefined) {
      throw new Error("Required Matrix adapter was not created");
    }
    this.#cryptoStateStore = await openCryptoStateStore({
      stateDir: context.config.stateDir,
      identity: {
        homeserver: context.config.matrix.homeserver,
        userId: context.config.matrix.userId,
        deviceId: context.config.matrix.deviceId,
      },
      diagnostics: this.#diagnostics,
    });
    // Normal daemon startup is a restore operation.  Reject incomplete or
    // missing state before handing the path to Rust crypto; initRustCrypto is
    // allowed to create a database for bootstrap, but must never create a
    // replacement identity during ordinary daemon startup.
    this.#cryptoStateStore.assertReadyForDaemon();
    const paths = cryptoStatePaths(context.config.stateDir);
    if (matrix.initializeCrypto === undefined) {
      throw new Error("Required Matrix adapter cannot initialize Rust crypto");
    }
    await withPrivateCryptoCreationMask(() => matrix.initializeCrypto!(paths));
  }

  async #raceStartup(
    start: () => Promise<void>,
    timeoutSeconds: number,
  ): Promise<void> {
    let settled = false;
    let rejectTimeout!: (error: unknown) => void;
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timeoutMs = timerMilliseconds(timeoutSeconds);
    const timeoutHandle = this.#clock.setTimeout(() => {
      if (settled) {
        return;
      }
      this.#requestTermination({ exitCode: 1 });
      rejectTimeout(new StartupTimeoutError());
    }, timeoutMs);

    const startup = Promise.resolve().then(start);

    // The startup operation may still be unwinding after a deadline or
    // signal. Attach a rejection handler so its eventual failure is never an
    // unhandled promise rejection.
    void startup.catch(() => {});
    const termination = this.#terminationPromise.then((request) => {
      throw new ShutdownRequestedError(request.exitCode);
    });
    void termination.catch(() => {});
    try {
      await Promise.race([startup, timeout, termination]);
    } finally {
      settled = true;
      this.#clock.clearTimeout(timeoutHandle);
    }
  }

  #checkShutdownRequest(): void {
    if (this.#termination !== undefined) {
      throw new ShutdownRequestedError(this.#termination.exitCode);
    }
  }

  #addFatalSubscription(
    source: { onFatalError(listener: (error: FatalError) => void): Unsubscribe },
    listener: (error: FatalError) => void,
  ): void {
    const unsubscribe = source.onFatalError(listener);
    if (this.#cleanupPromise !== undefined) {
      try {
        unsubscribe();
      } catch {
        this.#shutdownFailed = true;
      }
      return;
    }
    this.#fatalUnsubscribes.push(unsubscribe);
  }

  #installSignalHandlers(): void {
    if (this.#dependencies.installSignals === false) {
      return;
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const listener = (): void => {
        this.#handleSignal(signal);
      };
      this.#signalListeners.push({ signal, listener });
      this.#processLike.on(signal, listener);
    }
  }

  #removeSignalHandlers(): void {
    for (const entry of this.#signalListeners.splice(0)) {
      removeSignalListener(this.#processLike, entry.signal, entry.listener);
    }
  }

  #handleSignal(signal: DaemonSignal): void {
    if (this.#signalReceived) {
      const code = signalExitCode(signal);
      try {
        const exit = this.#dependencies.exit ?? this.#processLike.exit?.bind(this.#processLike);
        if (exit !== undefined) {
          exit(code);
        }
      } catch {
        // Test embedders may use an exit hook that throws to model process.exit.
      }
      return;
    }
    this.#signalReceived = true;
    emitDiagnostic(this.#diagnostics, "info", "shutdown-requested", { signal });
    this.#requestTermination({ exitCode: 0, signal });
  }

  #handleFatal(error: FatalError): void {
    if (this.#fatal === undefined) {
      this.#fatal = error;
      emitDiagnostic(this.#diagnostics, "error", "fatal-runtime-failure", {
        reason: safeFatalReason(error),
      });
    }
    this.#requestTermination({ exitCode: 1 });
  }

  #requestTermination(request: TerminationRequest): void {
    if (this.#termination === undefined) {
      this.#termination = request;
      this.#resolveTermination(request);
    } else if (request.exitCode === 1 && this.#termination.exitCode === 0) {
      this.#termination = { ...this.#termination, exitCode: 1 };
    }
    // A signal can arrive while the configuration file is still being read.
    // In that phase there is no resource to clean yet; the main run loop will
    // perform cleanup after loading either completes or fails. Once the lock
    // or an adapter exists, begin stopping immediately.
    if (this.#stateLock !== undefined || this.#acp !== undefined || this.#matrix !== undefined) {
      void this.#cleanup();
    }
  }

  async #cleanup(): Promise<CleanupResult> {
    if (this.#cleanupPromise !== undefined) {
      return this.#cleanupPromise;
    }

    this.#cleanupPromise = this.#performCleanup();
    return this.#cleanupPromise;
  }

  async #performCleanup(): Promise<CleanupResult> {
    for (const unsubscribe of this.#fatalUnsubscribes.splice(0)) {
      try {
        unsubscribe();
      } catch {
        this.#shutdownFailed = true;
      }
    }
    try {
      this.#syncUnsubscribe?.();
    } catch {
      this.#shutdownFailed = true;
    }
    this.#syncUnsubscribe = undefined;
    try {
      this.#syncBatchUnsubscribe?.();
    } catch {
      this.#shutdownFailed = true;
    }
    this.#syncBatchUnsubscribe = undefined;

    const graceSeconds = this.#loaded?.config.limits.shutdownGraceSeconds ?? 1;
    const graceMs = timerMilliseconds(graceSeconds);
    let forced = false;
    let finished = false;
    let finish!: (result: CleanupResult) => void;
    const result = new Promise<CleanupResult>((resolveResult) => {
      finish = resolveResult;
    });

    const deadline = this.#clock.setTimeout(() => {
      if (finished) {
        return;
      }
      forced = true;
      this.#forcedShutdown = true;
      emitDiagnostic(this.#diagnostics, "error", "shutdown-timeout", { reason: "grace deadline" });
      this.#forceCloseAdapters();
      void this.#releaseStateLock();
      finished = true;
      finish({ forced: true });
    }, graceMs);

    const stop = async (): Promise<void> => {
      try {
        await (this.#bridge === undefined ? this.#stopAdaptersDirectly() : this.#bridge.stop());
        await this.#closeCryptoOnce();
      } catch {
        this.#shutdownFailed = true;
        emitDiagnostic(this.#diagnostics, "error", "shutdown-failure", { reason: "adapter cleanup failed" });
        await this.#stopAdaptersDirectly();
      }
      await this.#flushState();
      await this.#releaseStateLock();
    };

    void stop().then(
      () => {
        if (finished) {
          return;
        }
        finished = true;
        this.#clock.clearTimeout(deadline);
        finish({ forced });
      },
      () => {
        this.#shutdownFailed = true;
        if (finished) {
          return;
        }
        finished = true;
        this.#clock.clearTimeout(deadline);
        finish({ forced });
      },
    );
    return result;
  }

  #forceCloseAdapters(): void {
    // The bridge normally owns these calls. The lifecycle keeps its own
    // once-only fallbacks for a bridge that is stuck in an active turn, so a
    // forced close cannot leave crypto or either transport open.
    void this.#stopMatrixOnce();
    void this.#closeCryptoOnce();
    void this.#closeAcpOnce();
  }

  async #stopAdaptersDirectly(): Promise<void> {
    await this.#stopMatrixOnce();
    await this.#closeCryptoOnce();
    await this.#closeAcpOnce();
  }

  async #stopMatrixOnce(): Promise<void> {
    if (this.#matrix === undefined) {
      return;
    }
    if (this.#matrixStopPromise === undefined) {
      this.#matrixStopPromise = Promise.resolve()
        .then(() => this.#matrix!.stop())
        .catch(() => {
          this.#shutdownFailed = true;
        });
    }
    await this.#matrixStopPromise;
  }

  async #closeAcpOnce(): Promise<void> {
    if (this.#acp === undefined) {
      return;
    }
    if (this.#acpClosePromise === undefined) {
      this.#acpClosePromise = Promise.resolve()
        .then(() => this.#acp!.close())
        .catch(() => {
          this.#shutdownFailed = true;
        });
    }
    await this.#acpClosePromise;
  }

  async #closeCryptoOnce(): Promise<void> {
    if (this.#matrix === undefined || this.#matrix.closeCrypto === undefined) {
      return;
    }
    if (this.#cryptoClosePromise === undefined) {
      this.#cryptoClosePromise = Promise.resolve()
        .then(() => this.#matrix!.closeCrypto!())
        .catch(() => {
          this.#shutdownFailed = true;
        });
    }
    await this.#cryptoClosePromise;
  }

  async #flushState(): Promise<void> {
    let failed = false;
    try {
      await (this.#syncCoordinator === undefined ? this.#stateStore?.flush?.() : this.#syncCoordinator.flush());
    } catch {
      failed = true;
    }
    try {
      await this.#cryptoStateStore?.flush();
    } catch {
      failed = true;
    }
    if (failed) {
      this.#shutdownFailed = true;
      emitDiagnostic(this.#diagnostics, "error", "shutdown-failure", {
        reason: "private state flush failed",
      });
    }
  }

  async #releaseStateLock(): Promise<void> {
    if (this.#stateLock === undefined) {
      return;
    }
    if (this.#lockReleasePromise === undefined) {
      this.#lockReleasePromise = Promise.resolve().then(() => this.#stateLock!.release()).catch(() => {
        this.#shutdownFailed = true;
      });
    }
    await this.#lockReleasePromise;
  }
}

export interface CryptoBootstrapRunOptions {
  readonly configPath?: string;
  readonly loadedConfiguration?: LoadedConfiguration;
  readonly dependencies?: DaemonDependencies;
}

/**
 * Lifecycle for the non-interactive first-use crypto command. It deliberately
 * has no ACP dependency: the Matrix identity and Rust store are established
 * before any agent process can be initialized.
 */
export class CryptoBootstrapLifecycle {
  readonly #configPath: string | undefined;
  readonly #preloaded: LoadedConfiguration | undefined;
  readonly #dependencies: DaemonDependencies;
  readonly #clock: Clock;
  readonly #diagnostics: DiagnosticSink;
  readonly #processLike: DaemonProcessLike;

  #loaded: LoadedConfiguration | undefined;
  #matrix: MatrixClientAdapter | undefined;
  #stateLock: StateLockLike | undefined;
  #store: PrivateCryptoStateStore | undefined;
  #termination: TerminationRequest | undefined;
  #resolveTermination!: (request: TerminationRequest) => void;
  readonly #terminationPromise: Promise<TerminationRequest>;
  #cleanupPromise: Promise<void> | undefined;
  #lockReleasePromise: Promise<void> | undefined;
  #signalReceived = false;
  #shutdownFailed = false;
  #signalListeners: Array<{ readonly signal: DaemonSignal; readonly listener: () => void }> = [];

  constructor(options: CryptoBootstrapRunOptions) {
    if (options.configPath === undefined && options.loadedConfiguration === undefined) {
      throw new TypeError("CryptoBootstrapLifecycle requires a config path or loaded configuration");
    }
    this.#configPath = options.configPath;
    this.#preloaded = options.loadedConfiguration;
    this.#dependencies = options.dependencies ?? {};
    this.#clock = this.#dependencies.clock ?? systemClock;
    this.#diagnostics = this.#dependencies.diagnostics ?? defaultDiagnostics();
    this.#processLike = this.#dependencies.process ?? process;
    this.#terminationPromise = new Promise<TerminationRequest>((resolveTermination) => {
      this.#resolveTermination = resolveTermination;
    });
  }

  async run(): Promise<DaemonExitCode> {
    this.#installSignalHandlers();
    let exitCode: DaemonExitCode = 0;
    try {
      await this.#loadAndValidate();
      await this.#raceStartup(
        () => this.#bootstrapLoaded(),
        this.#loaded!.config.limits.startupTimeoutSeconds,
      );
      if (this.#termination !== undefined) {
        exitCode = 1;
      }
    } catch (error) {
      exitCode = 1;
      emitCryptoFailure(this.#diagnostics, "crypto-bootstrap-failed", error, "crypto bootstrap failed");
    }
    await this.#cleanup();
    this.#removeSignalHandlers();
    return this.#shutdownFailed ? 1 : exitCode;
  }

  receiveSignal(signal: DaemonSignal): void {
    if (this.#signalReceived) {
      const exit = this.#dependencies.exit ?? this.#processLike.exit?.bind(this.#processLike);
      try {
        exit?.(signalExitCode(signal));
      } catch {
        // Test embedders may model process.exit by throwing.
      }
      return;
    }
    this.#signalReceived = true;
    this.#requestTermination({ exitCode: 1, signal });
  }

  async #loadAndValidate(): Promise<void> {
    this.#loaded = this.#preloaded ?? await (this.#dependencies.loadConfiguration ?? loadConfiguration)(
      this.#configPath!,
    );
    this.#stateLock = this.#loaded.stateLock;
    validateCommandForConfig({ kind: "bootstrap" }, this.#loaded.config);
    this.#checkShutdownRequest();
  }

  async #bootstrapLoaded(): Promise<void> {
    if (this.#loaded === undefined) {
      throw new Error("Crypto bootstrap configuration was not loaded");
    }

    this.#store = await openCryptoStateStore({
      stateDir: this.#loaded.config.stateDir,
      identity: {
        homeserver: this.#loaded.config.matrix.homeserver,
        userId: this.#loaded.config.matrix.userId,
        deviceId: this.#loaded.config.matrix.deviceId,
      },
      diagnostics: this.#diagnostics,
    });
    if (this.#store.status === "first-use") {
      await ensureCryptoDatabaseDirectory(this.#loaded.config.stateDir, this.#diagnostics);
    }
    this.#checkShutdownRequest();

    const context: DaemonFactoryContext = {
      config: this.#loaded.config,
      accessToken: this.#loaded.accessToken,
      diagnostics: this.#diagnostics,
      clock: this.#clock,
    };
    const createMatrix = this.#dependencies.createMatrixClient ?? defaultMatrixFactory;
    this.#matrix = createMatrix(context);
    const matrix = this.#matrix;
    if (matrix.initializeCrypto === undefined || matrix.getDeviceKeyFingerprints === undefined) {
      throw new Error("Required Matrix adapter cannot bootstrap Rust crypto");
    }
    await withPrivateCryptoCreationMask(() => matrix.initializeCrypto!(cryptoStatePaths(
      this.#loaded!.config.stateDir,
    )));
    this.#checkShutdownRequest();

    const identity = await matrix.whoAmI();
    assertMatrixIdentity(identity, this.#loaded.config.matrix);
    this.#checkShutdownRequest();

    // The adapter performs readiness and room invariant checks, but no event
    // listener is opened and intakeEnabled explicitly remains false.
    await matrix.start({ intakeEnabled: false });
    this.#checkShutdownRequest();
    const fingerprints = await matrix.getDeviceKeyFingerprints();
    const alreadyComplete = this.#store.validateForBootstrap(fingerprints);
    let manifest: CryptoManifest | undefined = this.#store.getManifest();
    if (!alreadyComplete) {
      manifest = await this.#store.recordBootstrap(fingerprints);
    }
    if (manifest === undefined) {
      throw new Error("Crypto bootstrap did not produce a manifest");
    }
    emitDiagnostic(
      this.#diagnostics,
      "info",
      alreadyComplete ? "crypto-bootstrap-already-complete" : "crypto-bootstrap-complete",
    );
  }

  async #raceStartup(start: () => Promise<void>, configuredTimeout?: number): Promise<void> {
    let settled = false;
    let rejectTimeout!: (error: unknown) => void;
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timeoutMs = timerMilliseconds(configuredTimeout ?? 60);
    const timeoutHandle = this.#clock.setTimeout(() => {
      if (settled) {
        return;
      }
      this.#requestTermination({ exitCode: 1 });
      rejectTimeout(new StartupTimeoutError());
    }, timeoutMs);
    const startup = Promise.resolve().then(start);
    void startup.catch(() => {});
    const termination = this.#terminationPromise.then(() => {
      throw new ShutdownRequestedError(1);
    });
    void termination.catch(() => {});
    try {
      await Promise.race([startup, timeout, termination]);
    } finally {
      settled = true;
      this.#clock.clearTimeout(timeoutHandle);
    }
  }

  #checkShutdownRequest(): void {
    if (this.#termination !== undefined) {
      throw new ShutdownRequestedError(1);
    }
  }

  #requestTermination(request: TerminationRequest): void {
    if (this.#termination === undefined) {
      this.#termination = request;
      this.#resolveTermination(request);
    }
    if (this.#stateLock !== undefined || this.#matrix !== undefined) {
      void this.#cleanup();
    }
  }

  async #cleanup(): Promise<void> {
    if (this.#cleanupPromise !== undefined) {
      return this.#cleanupPromise;
    }
    this.#cleanupPromise = (async () => {
      try {
        await this.#matrix?.stop();
        await this.#matrix?.closeCrypto?.();
      } catch {
        this.#shutdownFailed = true;
      }
      if (this.#store !== undefined) {
        try {
          await this.#store.flush();
        } catch {
          this.#shutdownFailed = true;
        }
      }
      await this.#releaseStateLock();
    })();
    return this.#cleanupPromise;
  }

  async #releaseStateLock(): Promise<void> {
    if (this.#stateLock === undefined) {
      return;
    }
    if (this.#lockReleasePromise === undefined) {
      this.#lockReleasePromise = Promise.resolve().then(() => this.#stateLock!.release()).catch(() => {
        this.#shutdownFailed = true;
      });
    }
    await this.#lockReleasePromise;
  }

  #installSignalHandlers(): void {
    if (this.#dependencies.installSignals === false) {
      return;
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const listener = (): void => this.receiveSignal(signal);
      this.#signalListeners.push({ signal, listener });
      this.#processLike.on(signal, listener);
    }
  }

  #removeSignalHandlers(): void {
    for (const { signal, listener } of this.#signalListeners.splice(0)) {
      removeSignalListener(this.#processLike, signal, listener);
    }
  }
}

export async function runCryptoBootstrap(
  options: CryptoBootstrapRunOptions,
): Promise<DaemonExitCode> {
  return new CryptoBootstrapLifecycle(options).run();
}

export interface CryptoVerificationRunOptions {
  readonly configPath?: string;
  readonly loadedConfiguration?: LoadedConfiguration;
  readonly dependencies?: DaemonDependencies;
  readonly targetDeviceId: string;
}

/** One-shot manual SAS lifecycle. It never constructs or initializes ACP. */
export class CryptoVerificationLifecycle {
  readonly #configPath: string | undefined;
  readonly #preloaded: LoadedConfiguration | undefined;
  readonly #dependencies: DaemonDependencies;
  readonly #clock: Clock;
  readonly #diagnostics: DiagnosticSink;
  readonly #processLike: DaemonProcessLike;
  readonly #targetDeviceId: string;

  #loaded: LoadedConfiguration | undefined;
  #matrix: MatrixClientAdapter | undefined;
  #stateLock: StateLockLike | undefined;
  #store: PrivateCryptoStateStore | undefined;
  #operation: CryptoVerificationOperation | undefined;
  #termination: TerminationRequest | undefined;
  #resolveTermination!: (request: TerminationRequest) => void;
  readonly #terminationPromise: Promise<TerminationRequest>;
  #cleanupPromise: Promise<void> | undefined;
  #lockReleasePromise: Promise<void> | undefined;
  #fatalUnsubscribe: Unsubscribe | undefined;
  #signalReceived = false;
  #shutdownFailed = false;
  readonly #signalListeners: Array<{ readonly signal: DaemonSignal; readonly listener: () => void }> = [];

  constructor(options: CryptoVerificationRunOptions) {
    if (options.configPath === undefined && options.loadedConfiguration === undefined) {
      throw new TypeError("CryptoVerificationLifecycle requires a config path or loaded configuration");
    }
    this.#configPath = options.configPath;
    this.#preloaded = options.loadedConfiguration;
    this.#dependencies = options.dependencies ?? {};
    this.#clock = this.#dependencies.clock ?? systemClock;
    this.#diagnostics = this.#dependencies.diagnostics ?? defaultDiagnostics();
    this.#processLike = this.#dependencies.process ?? process;
    this.#targetDeviceId = options.targetDeviceId;
    this.#terminationPromise = new Promise<TerminationRequest>((resolveTermination) => {
      this.#resolveTermination = resolveTermination;
    });
  }

  async run(): Promise<DaemonExitCode> {
    this.#installSignalHandlers();
    let exitCode: DaemonExitCode = 0;
    try {
      await this.#loadAndValidate();
      await this.#raceStartup(
        () => this.#verifyLoaded(),
        this.#loaded!.config.limits.startupTimeoutSeconds,
      );
      if (this.#termination !== undefined) {
        exitCode = 1;
      }
    } catch (error) {
      exitCode = 1;
      emitCryptoFailure(this.#diagnostics, "crypto-verification-failed", error, "crypto verification failed");
    }
    await this.#cleanup();
    this.#removeSignalHandlers();
    return this.#shutdownFailed ? 1 : exitCode;
  }

  receiveSignal(signal: DaemonSignal): void {
    if (this.#signalReceived) {
      const exit = this.#dependencies.exit ?? this.#processLike.exit?.bind(this.#processLike);
      try {
        exit?.(signalExitCode(signal));
      } catch {
        // Test embedders may model process.exit by throwing.
      }
      return;
    }
    this.#signalReceived = true;
    this.#requestTermination({ exitCode: 1, signal });
  }

  async #loadAndValidate(): Promise<void> {
    this.#loaded = this.#preloaded ?? await (this.#dependencies.loadConfiguration ?? loadConfiguration)(
      this.#configPath!,
    );
    this.#stateLock = this.#loaded.stateLock;
    validateCommandForConfig({ kind: "verify", deviceId: this.#targetDeviceId }, this.#loaded.config);
    this.#checkShutdownRequest();
  }

  async #verifyLoaded(): Promise<void> {
    if (this.#loaded === undefined) {
      throw new Error("Crypto verification configuration was not loaded");
    }
    const config = this.#loaded.config;
    this.#store = await openCryptoStateStore({
      stateDir: config.stateDir,
      identity: {
        homeserver: config.matrix.homeserver,
        userId: config.matrix.userId,
        deviceId: config.matrix.deviceId,
      },
      diagnostics: this.#diagnostics,
    });
    // Verification may use an unverified but already bootstrapped device,
    // never a first-use or replacement store.  Perform this check before
    // Rust initialization for the same no-new-identity guarantee as daemon
    // startup.
    this.#store.assertReadyForVerification();
    const context: DaemonFactoryContext = {
      config,
      accessToken: this.#loaded.accessToken,
      diagnostics: this.#diagnostics,
      clock: this.#clock,
    };
    const createMatrix = this.#dependencies.createMatrixClient ?? defaultMatrixFactory;
    this.#matrix = createMatrix(context);
    const matrix = this.#matrix;
    this.#fatalUnsubscribe = matrix.onFatalError(() => {
      this.#requestTermination({ exitCode: 1 });
    });
    if (
      matrix.initializeCrypto === undefined ||
      matrix.getDeviceKeyFingerprints === undefined ||
      matrix.getCryptoVerificationAdapter === undefined
    ) {
      throw new Error("Required Matrix adapter cannot verify SAS");
    }
    await withPrivateCryptoCreationMask(() => matrix.initializeCrypto!(cryptoStatePaths(config.stateDir)));
    this.#checkShutdownRequest();
    const identity = await matrix.whoAmI();
    assertMatrixIdentity(identity, config.matrix);
    this.#checkShutdownRequest();
    // Room events and ACP are both absent from this one-shot operation.
    await matrix.start({ intakeEnabled: false });
    this.#checkShutdownRequest();
    const fingerprints = await matrix.getDeviceKeyFingerprints();
    this.#store.assertReadyForVerification(fingerprints);
    const operation = new MatrixCryptoVerificationOperation({
      crypto: matrix.getCryptoVerificationAdapter(),
      ttyFactory: this.#dependencies.operatorTtyFactory ?? defaultOperatorTtyFactory,
      timeoutMs: timerMilliseconds(config.limits.startupTimeoutSeconds),
      clock: this.#clock,
      diagnostics: this.#diagnostics,
    });
    this.#operation = operation;
    await operation.run({
      identity: {
        homeserver: config.matrix.homeserver,
        userId: identity.userId,
        deviceId: identity.deviceId,
      },
      state: cryptoStatePaths(config.stateDir),
      targetDeviceId: this.#targetDeviceId,
    });
  }

  async #raceStartup(start: () => Promise<void>, timeoutSeconds: number): Promise<void> {
    let settled = false;
    let rejectTimeout!: (error: unknown) => void;
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timeoutHandle = this.#clock.setTimeout(() => {
      if (settled) {
        return;
      }
      this.#requestTermination({ exitCode: 1 });
      rejectTimeout(new StartupTimeoutError());
    }, timerMilliseconds(timeoutSeconds));
    const startup = Promise.resolve().then(start);
    void startup.catch(() => {});
    const termination = this.#terminationPromise.then(() => {
      throw new ShutdownRequestedError(1);
    });
    void termination.catch(() => {});
    try {
      await Promise.race([startup, timeout, termination]);
    } finally {
      settled = true;
      this.#clock.clearTimeout(timeoutHandle);
    }
  }

  #checkShutdownRequest(): void {
    if (this.#termination !== undefined) {
      throw new ShutdownRequestedError(1);
    }
  }

  #requestTermination(request: TerminationRequest): void {
    if (this.#termination === undefined) {
      this.#termination = request;
      this.#resolveTermination(request);
    }
    void this.#operation?.cancel?.();
    if (this.#stateLock !== undefined || this.#matrix !== undefined) {
      void this.#cleanup();
    }
  }

  async #cleanup(): Promise<void> {
    if (this.#cleanupPromise !== undefined) {
      return this.#cleanupPromise;
    }
    this.#cleanupPromise = (async () => {
      try {
        this.#fatalUnsubscribe?.();
      } catch {
        this.#shutdownFailed = true;
      }
      this.#fatalUnsubscribe = undefined;
      try {
        await this.#operation?.cancel?.();
        await this.#matrix?.stop();
        await this.#matrix?.closeCrypto?.();
      } catch {
        this.#shutdownFailed = true;
      }
      try {
        await this.#store?.flush();
      } catch {
        this.#shutdownFailed = true;
      }
      await this.#releaseStateLock();
    })();
    return this.#cleanupPromise;
  }

  async #releaseStateLock(): Promise<void> {
    if (this.#stateLock === undefined) {
      return;
    }
    if (this.#lockReleasePromise === undefined) {
      this.#lockReleasePromise = Promise.resolve().then(() => this.#stateLock!.release()).catch(() => {
        this.#shutdownFailed = true;
      });
    }
    await this.#lockReleasePromise;
  }

  #installSignalHandlers(): void {
    if (this.#dependencies.installSignals === false) {
      return;
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const listener = (): void => this.receiveSignal(signal);
      this.#signalListeners.push({ signal, listener });
      this.#processLike.on(signal, listener);
    }
  }

  #removeSignalHandlers(): void {
    for (const { signal, listener } of this.#signalListeners.splice(0)) {
      removeSignalListener(this.#processLike, signal, listener);
    }
  }
}

export async function runCryptoVerification(
  options: CryptoVerificationRunOptions,
): Promise<DaemonExitCode> {
  return new CryptoVerificationLifecycle(options).run();
}

async function runCryptoCommand(
  command: CryptoCommand,
  options: CryptoBootstrapRunOptions,
): Promise<DaemonExitCode> {
  if (command.kind === "verify") {
    return runCryptoVerification({
      ...options,
      targetDeviceId: command.deviceId,
    });
  }
  return runCryptoBootstrap(options);
}

function dependenciesFrom(options: RunDaemonOptions): DaemonDependencies {
  const {
    argv: _argv,
    configPath: _configPath,
    command: _command,
    loadedConfiguration: _loadedConfiguration,
    ...dependencies
  } = options;
  return dependencies;
}

/** Run the daemon and return its documented process exit code. */
export async function runDaemon(options?: RunDaemonOptions): Promise<DaemonExitCode>;
export async function runDaemon(options: RunDaemonOptions): Promise<DaemonExitCode>;
export async function runDaemon(
  argv: readonly string[],
  dependencies?: DaemonDependencies,
): Promise<DaemonExitCode>;
export async function runDaemon(
  optionsOrArgv: RunDaemonOptions | readonly string[] = {},
  dependencies: DaemonDependencies = {},
): Promise<DaemonExitCode> {
  const options: RunDaemonOptions = Array.isArray(optionsOrArgv)
    ? { ...dependencies, argv: optionsOrArgv as readonly string[] }
    : optionsOrArgv as RunDaemonOptions;
  const diagnostics = options.diagnostics ?? defaultDiagnostics();
  let configPath = options.configPath;
  let command = options.command;
  try {
    if (configPath === undefined && options.loadedConfiguration === undefined) {
      const parsed = parseCommandLine(options.argv ?? process.argv.slice(2));
      configPath = parsed.configPath;
      command = parsed.command;
    } else if (command === undefined && options.argv !== undefined) {
      command = parseCommandLine(options.argv).command;
    }
    if (command !== undefined) {
      return await runCryptoCommand(command, {
        ...(configPath === undefined ? {} : { configPath }),
        ...(options.loadedConfiguration === undefined
          ? {}
          : { loadedConfiguration: options.loadedConfiguration }),
        dependencies: {
          ...dependenciesFrom(options),
          diagnostics,
        },
      });
    }
    const lifecycle = new DaemonLifecycle({
      ...(configPath === undefined ? {} : { configPath }),
      ...(options.loadedConfiguration === undefined
        ? {}
        : { loadedConfiguration: options.loadedConfiguration }),
      dependencies: {
        ...dependenciesFrom(options),
        diagnostics,
      },
    });
    return await lifecycle.run();
  } catch (error) {
    emitDiagnostic(diagnostics, "error", "startup-failed", { reason: safeFailureReason(error) });
    return 1;
  }
}

/** Main entry point used by the package start script. */
export function main(options: RunDaemonOptions): Promise<DaemonExitCode>;
export function main(
  argv?: readonly string[],
  dependencies?: DaemonDependencies,
): Promise<DaemonExitCode>;
export async function main(
  argvOrOptions: readonly string[] | RunDaemonOptions = process.argv.slice(2),
  dependencies: DaemonDependencies = {},
): Promise<DaemonExitCode> {
  if (Array.isArray(argvOrOptions)) {
    return runDaemon(argvOrOptions, dependencies);
  }
  return runDaemon(argvOrOptions as RunDaemonOptions);
}

function isEntrypoint(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isEntrypoint()) {
  const exitCode = await main();
  // The Matrix SDK can retain transport or crypto handles after its
  // asynchronous shutdown completes. The lifecycle has already flushed
  // state before resolving, so finish the CLI explicitly instead of
  // allowing those SDK-owned handles to keep one-shot commands alive.
  // eslint-disable-next-line unicorn/no-process-exit -- this module is the CLI entrypoint
  process.exit(exitCode);
}
