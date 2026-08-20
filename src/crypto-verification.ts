import { dirname } from "node:path";

import { CRYPTO_TTY_PATH, SAS_VERIFICATION_METHOD } from "./crypto-runtime.js";
import { openCryptoStateStore } from "./crypto-state.js";
import type { CryptoStateFaultInjector } from "./crypto-state.js";
import { systemClock } from "./clock.js";
import type { Clock } from "./clock.js";
import type { DiagnosticSink } from "./diagnostics.js";
import type { Unsubscribe } from "./cancellation.js";
import type {
  CryptoSasCallbacks,
  CryptoSasVerifier,
  CryptoVerificationRequestHandle,
  MatrixCryptoVerificationAdapter,
  MatrixDeviceId,
} from "./matrix-client.js";
import type { OperatorTty, OperatorTtyFactory } from "./operator-tty.js";
import type { CryptoManifest } from "./crypto-state.js";
import type { MatrixBridgeIdentity } from "./bridge-state.js";
import type { CryptoStatePaths } from "./crypto-contracts.js";

export interface CryptoVerificationRequest {
  readonly identity: MatrixBridgeIdentity;
  readonly state: CryptoStatePaths;
  readonly targetDeviceId: MatrixDeviceId;
}

export interface CryptoVerificationResult {
  readonly manifest: CryptoManifest;
}

export interface CryptoVerificationOperation {
  run(request: CryptoVerificationRequest): Promise<CryptoVerificationResult>;
  cancel?(): Promise<void>;
}

export class CryptoVerificationError extends Error {
  readonly code = "crypto_verification" as const;
  readonly reason:
    | "target_rejected"
    | "method_rejected"
    | "operator_rejected"
    | "cancelled"
    | "timeout"
    | "protocol"
    | "tty"
    | "manifest";

  constructor(
    reason: CryptoVerificationError["reason"],
    message = "Matrix SAS verification failed",
  ) {
    super(message);
    this.name = "CryptoVerificationError";
    this.reason = reason;
  }
}

export interface CryptoVerificationOperationOptions {
  readonly crypto: MatrixCryptoVerificationAdapter;
  readonly ttyFactory: OperatorTtyFactory;
  readonly timeoutMs: number;
  readonly clock?: Clock;
  readonly diagnostics?: DiagnosticSink;
  readonly stateFaultInjector?: CryptoStateFaultInjector;
}

/**
 * Conduct exactly one manual, to-device SAS flow and attest the local key
 * pair only after the SDK reports protocol completion.  The operation is
 * deliberately expressed against narrow SDK-independent interfaces so every
 * failure path is hermetically testable.
 */
export class MatrixCryptoVerificationOperation implements CryptoVerificationOperation {
  readonly #crypto: MatrixCryptoVerificationAdapter;
  readonly #ttyFactory: OperatorTtyFactory;
  readonly #timeoutMs: number;
  readonly #clock: Clock;
  readonly #diagnostics: DiagnosticSink | undefined;
  readonly #stateFaultInjector: CryptoStateFaultInjector | undefined;

  #tty: OperatorTty | undefined;
  #request: CryptoVerificationRequestHandle | undefined;
  #verifier: CryptoSasVerifier | undefined;
  #localDeviceId: string | undefined;
  #targetDeviceId: string | undefined;
  #showPromise: Promise<void> | undefined;
  #cancelled = false;
  #cancelRequested = false;
  #completed = false;
  #unsubscribeIncoming: Unsubscribe | undefined;
  #targetChangeUnsubscribe: Unsubscribe | undefined;
  readonly #requestChangeUnsubscribes = new Set<Unsubscribe>();
  readonly #knownRequests = new Set<CryptoVerificationRequestHandle>();
  readonly #cancelledRequests = new WeakSet<CryptoVerificationRequestHandle>();
  #startedVerification = false;
  #cancelPromise: Promise<void> | undefined;

  constructor(options: CryptoVerificationOperationOptions) {
    this.#crypto = options.crypto;
    this.#ttyFactory = options.ttyFactory;
    this.#timeoutMs = options.timeoutMs;
    this.#clock = options.clock ?? systemClock;
    this.#diagnostics = options.diagnostics;
    this.#stateFaultInjector = options.stateFaultInjector;
  }

  async run(request: CryptoVerificationRequest): Promise<CryptoVerificationResult> {
    if (request.targetDeviceId === request.identity.deviceId) {
      throw new CryptoVerificationError("target_rejected");
    }
    const store = await openCryptoStateStore({
      stateDir: dirname(request.state.manifestPath),
      identity: request.identity,
      ...(this.#diagnostics === undefined ? {} : { diagnostics: this.#diagnostics }),
      ...(this.#stateFaultInjector === undefined ? {} : { faultInjector: this.#stateFaultInjector }),
    });

    // Restore and re-check the exact local identity before any verification
    // request is sent. The final check is repeated immediately before writing.
    const fingerprints = await this.#crypto.getDeviceKeyFingerprints();
    store.assertReadyForVerification(fingerprints);

    let settled = false;
    let rejectTimeout!: (error: unknown) => void;
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timeoutHandle = this.#clock.setTimeout(() => {
      if (settled) {
        return;
      }
      void this.cancel();
      rejectTimeout(new CryptoVerificationError("timeout", "Matrix SAS verification timed out"));
    }, this.#timeoutMs);

    const operation = this.#runFlow(request);
    void operation.catch(() => {});
    try {
      await Promise.race([operation, timeout]);
      this.#assertTarget(this.#request, request);
      const finalFingerprints = await this.#crypto.getDeviceKeyFingerprints();
      const manifest = await store.recordSasVerification(finalFingerprints);
      await store.flush();
      this.#completed = true;
      return { manifest };
    } catch (error) {
      await this.cancel();
      throw error;
    } finally {
      settled = true;
      this.#clock.clearTimeout(timeoutHandle);
      await this.#unsubscribe();
      await this.#closeTty();
      if (this.#cancelled) {
        await this.cancel();
      }
    }
  }

  async cancel(): Promise<void> {
    if (this.#completed) {
      return;
    }
    if (this.#cancelRequested) {
      await this.#cancelPromise;
      return;
    }
    this.#cancelRequested = true;
    if (this.#cancelPromise !== undefined) {
      await this.#cancelPromise;
      return;
    }
    this.#cancelled = true;
    this.#cancelPromise = (async () => {
      if (this.#verifier?.cancel === undefined) {
        for (const request of this.#knownRequests) {
          await this.#cancelRequest(request);
        }
      } else {
        try {
          this.#verifier.cancel();
        } catch {
          // Cancellation is best effort; the command still fails closed.
        }
      }
    })();
    return this.#cancelPromise;
  }

  async #runFlow(request: CryptoVerificationRequest): Promise<void> {
    this.#localDeviceId = request.identity.deviceId;
    this.#targetDeviceId = request.targetDeviceId;
    this.#tty = await this.#ttyFactory.open(CRYPTO_TTY_PATH);
    let targetAvailable: boolean;
    try {
      targetAvailable = await this.#crypto.refreshDeviceKeys(
        request.identity.userId,
        request.targetDeviceId,
      );
    } catch {
      throw new CryptoVerificationError("protocol");
    }
    if (!targetAvailable) {
      throw new CryptoVerificationError("target_rejected");
    }
    if (this.#cancelled) {
      throw new CryptoVerificationError("cancelled");
    }
    this.#unsubscribeIncoming = this.#crypto.onVerificationRequest((incoming) => {
      const sameUser = incoming.userId === request.identity.userId;
      const sameTarget = sameUser && incoming.deviceId === request.targetDeviceId;
      // Rust crypto emits the same outgoing request through the generic event
      // as well as returning it from requestDeviceVerification(). The
      // explicitly returned handle is authoritative because the adapter binds
      // it to the requested target while Rust may expose an empty device ID
      // during the Requested phase. Rust can also report initiatedByMe=false
      // for this generic alias, so an exact-target event is never accepted or
      // canceled: an independently initiated request is ignored, too, and
      // therefore cannot become the active transaction.
      if (sameTarget) {
        return;
      }
      if (
        incoming.initiatedByMe &&
        sameUser &&
        incoming.deviceId === ""
      ) {
        return;
      }
      if (
        !sameUser ||
        incoming.deviceId !== request.targetDeviceId
      ) {
        this.#rememberRequest(incoming);
        void this.#cancelRequest(incoming);
      }
    });

    let selected: CryptoVerificationRequestHandle;
    try {
      selected = await this.#crypto.requestDeviceVerification(
        request.identity.userId,
        request.targetDeviceId,
      );
    } catch (error: unknown) {
      if (error instanceof CryptoVerificationError) {
        throw error;
      }
      throw new CryptoVerificationError("protocol");
    }
    this.#rememberRequest(selected);
    try {
      // requestDeviceVerification is the only path that can supply the
      // active request. Its result must still identify this client as the
      // initiator: the SDK may return an already-active incoming request.
      if (!selected.initiatedByMe) {
        throw new CryptoVerificationError(
          "protocol",
          "Matrix verification request was not initiated by the bridge",
        );
      }
      this.#assertTarget(selected, request);
    } catch (error) {
      void this.#cancelRequest(selected);
      if (error instanceof CryptoVerificationError) {
        throw error;
      }
      throw new CryptoVerificationError("protocol");
    }

    this.#request = selected;
    if (this.#cancelled) {
      throw new CryptoVerificationError("cancelled");
    }
    this.#assertTarget(selected, request);

    const ready = this.#waitForReady(selected, request);
    await ready;
    if (this.#cancelled) {
      throw new CryptoVerificationError("cancelled");
    }
    this.#assertTarget(selected, request);
    this.#watchTarget(selected, request);
    if (!this.#supportsSas(selected)) {
      await this.#cancelRequest(selected);
      throw new CryptoVerificationError("method_rejected");
    }

    let verifier = selected.verifier;
    if (verifier === undefined) {
      if (this.#startedVerification || this.#requestPhase(selected) === "started") {
        throw new CryptoVerificationError("protocol");
      }
      this.#startedVerification = true;
      verifier = await selected.startVerification(SAS_VERIFICATION_METHOD);
    }
    this.#verifier = verifier;
    if (this.#cancelled) {
      try {
        verifier.cancel?.();
      } catch {
        // Cancellation is best effort; the command still fails closed.
      }
      throw new CryptoVerificationError("cancelled");
    }
    const showSas = verifier.onShowSas((sas) => {
      if (this.#showPromise !== undefined) {
        return;
      }
      this.#showPromise = this.#showAndConfirm(sas);
      void this.#showPromise.catch(() => {
        void this.cancel();
      });
    });
    const cancelled = verifier.onCancel(() => {
      // A remote cancellation must never reach the manifest write.
      void this.cancel();
    });
    try {
      await verifier.verify();
      if (this.#showPromise === undefined) {
        throw new CryptoVerificationError("protocol");
      }
      await this.#showPromise;
      this.#assertTarget(selected, request);
    } catch (error) {
      if (error instanceof CryptoVerificationError) {
        throw error;
      }
      throw new CryptoVerificationError("cancelled");
    } finally {
      showSas();
      cancelled();
    }
  }

  #supportsSas(request: CryptoVerificationRequestHandle): boolean {
    try {
      return (
        (request.chosenMethod === undefined || request.chosenMethod === SAS_VERIFICATION_METHOD) &&
        request.supportsMethod(SAS_VERIFICATION_METHOD)
      );
    } catch {
      return false;
    }
  }

  async #waitForReady(
    request: CryptoVerificationRequestHandle,
    expected: CryptoVerificationRequest,
  ): Promise<void> {
    const initialPhase = this.#requestPhase(request);
    if (initialPhase === "ready" || initialPhase === "started") {
      return;
    }
    if (initialPhase === "cancelled" || initialPhase === "done") {
      throw new CryptoVerificationError("cancelled");
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribe: Unsubscribe | undefined;
      const cleanup = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe?.();
        this.#requestChangeUnsubscribes.delete(cleanup);
      };
      const finish = (error?: CryptoVerificationError): void => {
        if (settled) {
          return;
        }
        cleanup();
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };
      const check = (): void => {
        try {
          this.#assertTarget(request, expected);
          const phase = this.#requestPhase(request);
          if (phase === "ready" || phase === "started") {
            finish();
          } else if (phase === "cancelled" || phase === "done") {
            finish(new CryptoVerificationError("cancelled"));
          }
        } catch (error) {
          finish(
            error instanceof CryptoVerificationError
              ? error
              : new CryptoVerificationError("protocol"),
          );
        }
      };
      this.#requestChangeUnsubscribes.add(cleanup);
      try {
        unsubscribe = request.onChange(check);
      } catch {
        cleanup();
        reject(new CryptoVerificationError("protocol"));
        return;
      }
      if (settled) {
        unsubscribe();
      } else {
        check();
      }
    });
  }

  #requestPhase(request: CryptoVerificationRequestHandle): CryptoVerificationRequestHandle["phase"] {
    try {
      return request.phase;
    } catch {
      throw new CryptoVerificationError("protocol");
    }
  }

  #assertTarget(
    candidate: CryptoVerificationRequestHandle | undefined,
    expected: CryptoVerificationRequest,
  ): void {
    if (candidate === undefined) {
      throw new CryptoVerificationError("target_rejected");
    }
    try {
      if (
        candidate.userId !== expected.identity.userId ||
        candidate.deviceId !== expected.targetDeviceId
      ) {
        throw new CryptoVerificationError("target_rejected");
      }
    } catch (error) {
      if (error instanceof CryptoVerificationError) {
        throw error;
      }
      throw new CryptoVerificationError("target_rejected");
    }
  }

  #watchTarget(
    request: CryptoVerificationRequestHandle,
    expected: CryptoVerificationRequest,
  ): void {
    try {
      this.#targetChangeUnsubscribe = request.onChange(() => {
        try {
          this.#assertTarget(request, expected);
        } catch {
          // A later identity conflict cancels the flow before it can attest.
          void this.cancel();
        }
      });
    } catch {
      throw new CryptoVerificationError("protocol");
    }
  }

  #stopTargetWatch(): void {
    try {
      this.#targetChangeUnsubscribe?.();
    } catch {
      // Request listener cleanup is best effort.
    }
    this.#targetChangeUnsubscribe = undefined;
  }

  #rememberRequest(request: CryptoVerificationRequestHandle): void {
    this.#knownRequests.add(request);
    if (this.#cancelRequested) {
      void this.#cancelRequest(request);
    }
  }

  async #showAndConfirm(sas: CryptoSasCallbacks): Promise<void> {
    if (this.#tty === undefined) {
      throw new CryptoVerificationError("tty");
    }
    const emoji = sas.emoji?.map(([symbol, name]) => `${symbol} (${name})`).join(" ");
    const decimal = sas.decimal?.join(" ");
    if (emoji === undefined && decimal === undefined) {
      sas.cancel();
      throw new CryptoVerificationError("protocol");
    }
    const lines = [
      `Local device: ${this.#localDeviceId ?? "unknown"}\n`,
      `Target device: ${this.#targetDeviceId ?? "unknown"}\n`,
      ...(emoji === undefined ? [] : [`SAS emoji: ${emoji}\n`]),
      ...(decimal === undefined ? [] : [`SAS decimal: ${decimal}\n`]),
      `Type exactly yes if the SAS matches the trusted client: `,
    ];
    await this.#tty.write(lines.join(""));
    const answer = await this.#tty.readLine();
    if (answer === "yes") {
      await sas.confirm();
      return;
    }
    if (answer === undefined) {
      sas.cancel();
    } else {
      sas.mismatch();
    }
    throw new CryptoVerificationError("operator_rejected");
  }

  async #cancelRequest(request: CryptoVerificationRequestHandle): Promise<void> {
    if (this.#cancelledRequests.has(request)) {
      return;
    }
    try {
      if (request.phase === "cancelled" || request.phase === "done") {
        return;
      }
    } catch {
      // A malformed phase must not prevent best-effort cancellation.
    }
    this.#cancelledRequests.add(request);
    try {
      await request.cancel();
    } catch {
      // Rejecting traffic is best effort and never exposes SDK errors.
    }
  }

  #unsubscribe(): Promise<void> {
    try {
      this.#unsubscribeIncoming?.();
    } catch {
      // Listener cleanup is best effort.
    }
    this.#unsubscribeIncoming = undefined;
    this.#stopTargetWatch();
    for (const unsubscribe of this.#requestChangeUnsubscribes) {
      try {
        unsubscribe();
      } catch {
        // Request listener cleanup is best effort.
      }
    }
    this.#requestChangeUnsubscribes.clear();
    return Promise.resolve();
  }

  async #closeTty(): Promise<void> {
    const tty = this.#tty;
    this.#tty = undefined;
    try {
      await tty?.close();
    } catch {
      // TTY cleanup must not expose local device details.
    }
  }
}
