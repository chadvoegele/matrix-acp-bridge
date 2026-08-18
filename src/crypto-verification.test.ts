import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureCryptoDatabaseDirectory, openCryptoStateStore } from "./crypto-state.js";
import type { CryptoStateFaultInjector } from "./crypto-state.js";
import {
  CryptoVerificationError,
  MatrixCryptoVerificationOperation,
} from "./crypto-verification.js";
import { MatrixSdkCryptoAdapter } from "./matrix-client.js";
import type {
  CryptoSasCallbacks,
  CryptoSasVerifier,
  CryptoVerificationRequestHandle,
  CryptoVerificationRequestPhase,
  MatrixCryptoVerificationAdapter,
  MatrixSdkClientLike,
} from "./matrix-client.js";
import { FakeClock } from "./test-support/fake-clock.js";
import type { Unsubscribe } from "./cancellation.js";
import type { CryptoDeviceKeyFingerprints } from "./crypto-contracts.js";
import type { OperatorTty, OperatorTtyFactory } from "./operator-tty.js";

const IDENTITY = {
  homeserver: "https://matrix.example.org",
  userId: "@bridge:example.org",
  deviceId: "BRIDGE01",
} as const;
const TARGET = "TRUSTED01";
const FINGERPRINTS: CryptoDeviceKeyFingerprints = {
  ed25519Fingerprint: "ed25519-public",
  curve25519Fingerprint: "curve25519-public",
};
const TEST_SETUP_WAIT_TIMEOUT_MS = 5000;
const TEST_SETUP_POLL_INTERVAL_MS = 10;

function rustDevice(userId: string, deviceId: string): Record<string, unknown> {
  return {
    userId,
    deviceId,
    keys: new Map([
      [`ed25519:${deviceId}`, "valid-ed25519-key"],
      [`curve25519:${deviceId}`, "valid-curve25519-key"],
    ]),
  };
}

async function waitForTestCondition(condition: () => boolean): Promise<boolean> {
  const deadline = Date.now() + TEST_SETUP_WAIT_TIMEOUT_MS;
  while (!condition()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(TEST_SETUP_POLL_INTERVAL_MS, remaining));
    });
  }
  return true;
}

class TestTty implements OperatorTty {
  readonly writes: string[] = [];
  readonly answer: string | undefined;
  readonly pending: boolean;
  closed = false;

  constructor(answer: string | undefined, pending = false) {
    this.answer = answer;
    this.pending = pending;
  }

  async write(text: string): Promise<void> {
    this.writes.push(text);
  }

  async readLine(): Promise<string | undefined> {
    if (this.pending) {
      return new Promise<string | undefined>(() => {});
    }
    return this.answer;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class TestVerifier implements CryptoSasVerifier {
  readonly showListeners = new Set<(sas: CryptoSasCallbacks) => void>();
  readonly cancelListeners = new Set<() => void>();
  readonly shown: CryptoSasCallbacks = {
    emoji: [["😀", "grinning face"], ["🚀", "rocket"]],
    decimal: [123, 456, 789],
    confirm: async () => {
      this.confirmed = true;
      this.resolve?.();
    },
    mismatch: () => {
      this.rejected = true;
      this.reject?.(new Error("mismatch"));
    },
    cancel: () => {
      this.cancelled = true;
      this.reject?.(new Error("cancelled"));
    },
  };
  confirmed = false;
  rejected = false;
  cancelled = false;
  started = false;
  #done: Promise<void> | undefined;
  resolve: (() => void) | undefined;
  reject: ((error: Error) => void) | undefined;

  onShowSas(listener: (sas: CryptoSasCallbacks) => void): Unsubscribe {
    this.showListeners.add(listener);
    return () => this.showListeners.delete(listener);
  }

  onCancel(listener: () => void): Unsubscribe {
    this.cancelListeners.add(listener);
    return () => this.cancelListeners.delete(listener);
  }

  async verify(): Promise<void> {
    this.started = true;
    this.#done = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    for (const listener of this.showListeners) {
      listener(this.shown);
    }
    await this.#done;
  }

  cancel(): void {
    this.cancelled = true;
    for (const listener of this.cancelListeners) {
      listener();
    }
    this.reject?.(new Error("cancelled"));
  }
}

class TestRequest implements CryptoVerificationRequestHandle {
  userId: string;
  deviceId: string;
  readonly initiatedByMe: boolean;
  phase: CryptoVerificationRequestPhase;
  readonly chosenMethod: string | undefined;
  readonly verifier: CryptoSasVerifier | undefined;
  readonly startVerifier: CryptoSasVerifier | undefined;
  readonly methods: readonly string[];
  readonly capabilitiesAfterReady: boolean;
  readonly #changeListeners = new Set<() => void>();
  startCalls = 0;
  cancelCalls = 0;

  constructor(options: {
    readonly userId?: string;
    readonly deviceId?: string;
    readonly initiatedByMe?: boolean;
    readonly phase?: CryptoVerificationRequestPhase;
    readonly methods?: readonly string[];
    readonly capabilitiesAfterReady?: boolean;
    readonly chosenMethod?: string;
    readonly verifier?: CryptoSasVerifier;
    readonly startVerifier?: CryptoSasVerifier;
  } = {}) {
    this.userId = options.userId ?? IDENTITY.userId;
    this.deviceId = options.deviceId ?? TARGET;
    this.initiatedByMe = options.initiatedByMe ?? true;
    this.phase = options.phase ?? "ready";
    this.methods = options.methods ?? [];
    this.capabilitiesAfterReady = options.capabilitiesAfterReady ?? false;
    this.chosenMethod = options.chosenMethod;
    this.verifier = options.verifier;
    this.startVerifier = options.startVerifier ?? options.verifier;
  }

  supportsMethod(method: string): boolean {
    if (this.capabilitiesAfterReady && this.phase !== "ready" && this.phase !== "started") {
      return false;
    }
    return this.methods.length === 0 || this.methods.includes(method);
  }

  setPhase(phase: CryptoVerificationRequestPhase): void {
    this.phase = phase;
    for (const listener of this.#changeListeners) {
      listener();
    }
  }

  onChange(listener: () => void): Unsubscribe {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  get changeListenerCount(): number {
    return this.#changeListeners.size;
  }

  async startVerification(_method: "m.sas.v1"): Promise<CryptoSasVerifier> {
    this.startCalls += 1;
    this.setPhase("started");
    return this.startVerifier!;
  }

  async accept(): Promise<void> {
    this.setPhase("ready");
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
    this.setPhase("cancelled");
    if (this.verifier instanceof TestVerifier) {
      this.verifier.cancel();
    }
  }
}

class TestCrypto implements MatrixCryptoVerificationAdapter {
  readonly request: TestRequest;
  readonly incoming = new Set<(request: CryptoVerificationRequestHandle) => void>();
  readonly forbiddenCalls: string[] = [];
  requestCalls = 0;
  refreshCalls = 0;
  closeCalls = 0;
  readonly emitOnRequest: readonly TestRequest[];

  constructor(request: TestRequest, emitOnRequest: readonly TestRequest[] = []) {
    this.request = request;
    this.emitOnRequest = emitOnRequest;
  }

  async initialize(): Promise<void> {
    // The lifecycle owns initialization; this exists for the common crypto contract.
  }

  async getDeviceKeyFingerprints(): Promise<CryptoDeviceKeyFingerprints> {
    return FINGERPRINTS;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  async refreshDeviceKeys(): Promise<boolean> {
    this.refreshCalls += 1;
    return true;
  }

  onVerificationRequest(listener: (request: CryptoVerificationRequestHandle) => void): Unsubscribe {
    this.incoming.add(listener);
    return () => this.incoming.delete(listener);
  }

  async requestDeviceVerification(): Promise<CryptoVerificationRequestHandle> {
    this.requestCalls += 1;
    for (const request of this.emitOnRequest) {
      for (const listener of this.incoming) {
        listener(request);
      }
    }
    return this.request;
  }

  bootstrapCrossSigning(): void { this.forbiddenCalls.push("bootstrapCrossSigning"); }
  resetEncryption(): void { this.forbiddenCalls.push("resetEncryption"); }
  setDeviceVerified(): void { this.forbiddenCalls.push("setDeviceVerified"); }
  generateQRCode(): void { this.forbiddenCalls.push("generateQRCode"); }
  requestVerificationDM(): void { this.forbiddenCalls.push("requestVerificationDM"); }
  requestOwnUserVerification(): void { this.forbiddenCalls.push("requestOwnUserVerification"); }
  storeSessionBackupPrivateKey(): void { this.forbiddenCalls.push("storeSessionBackupPrivateKey"); }
}

class RustSdkSasVerifierDouble {
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  confirmed = false;
  #reject: ((error: Error) => void) | undefined;

  on(event: string, listener: (...args: unknown[]) => void): void {
    let listeners = this.listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  async verify(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#reject = reject;
      this.#emit("show_sas", {
        sas: {
          emoji: [["😀", "grinning face"]],
          decimal: [123, 456, 789],
        },
        confirm: async () => {
          this.confirmed = true;
          resolve();
        },
        mismatch: () => reject(new Error("mismatch")),
        cancel: () => reject(new Error("cancelled")),
      });
    });
  }

  cancel(): void {
    this.#emit("cancel", new Error("cancelled"));
    this.#reject?.(new Error("cancelled"));
  }

  #emit(event: string, ...args: unknown[]): void {
    for (const listener of (this.listeners.get(event) ?? [])) {
      listener(...args);
    }
  }
}

class RustSdkVerificationRequestDouble {
  readonly otherUserId = IDENTITY.userId;
  otherDeviceId: string | undefined;
  readonly initiatedByMe = true;
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly sasVerifier = new RustSdkSasVerifierDouble();
  phase = 2;
  startCalls = 0;
  cancelCalls = 0;
  methodsRead = false;

  get methods(): never {
    this.methodsRead = true;
    throw new Error("not implemented");
  }

  get chosenMethod(): undefined {
    return undefined;
  }

  get verifier(): undefined {
    return undefined;
  }

  otherPartySupportsMethod(method: string): boolean {
    return this.phase >= 3 && method === "m.sas.v1";
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    let listeners = this.listeners.get(event);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string): void {
    for (const listener of (this.listeners.get(event) ?? [])) {
      listener();
    }
  }

  async startVerification(): Promise<RustSdkSasVerifierDouble> {
    this.startCalls += 1;
    this.phase = 4;
    return this.sasVerifier;
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
    this.phase = 5;
  }
}

async function makeState(): Promise<{ readonly stateDir: string; readonly cleanup: () => Promise<void> }> {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-verification-"));
  await ensureCryptoDatabaseDirectory(stateDir);
  const store = await openCryptoStateStore({ stateDir, identity: IDENTITY });
  await store.recordBootstrap(FINGERPRINTS);
  return {
    stateDir,
    cleanup: () => rm(stateDir, { recursive: true, force: true }),
  };
}

function ttyFactory(tty: TestTty): OperatorTtyFactory {
  return { open: async () => tty };
}

async function runOperation(
  stateDir: string,
  crypto: MatrixCryptoVerificationAdapter,
  tty: TestTty,
  options: { readonly clock?: FakeClock; readonly stateFaultInjector?: CryptoStateFaultInjector } = {},
): Promise<Awaited<ReturnType<MatrixCryptoVerificationOperation["run"]>>> {
  const operation = new MatrixCryptoVerificationOperation({
    crypto,
    ttyFactory: ttyFactory(tty),
    timeoutMs: 10_000,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.stateFaultInjector === undefined ? {} : { stateFaultInjector: options.stateFaultInjector }),
  });
  return operation.run({
    identity: IDENTITY,
    state: {
      databasePath: join(stateDir, "matrix-crypto"),
      manifestPath: join(stateDir, "crypto-state.json"),
    },
    targetDeviceId: TARGET,
  });
}

void test("completes outgoing SAS with exact yes, displays both SAS forms, and attests only after completion", async () => {
  const state = await makeState();
  try {
    const verifier = new TestVerifier();
    const request = new TestRequest({ startVerifier: verifier });
    const crypto = new TestCrypto(request);
    const tty = new TestTty("yes");
    await runOperation(state.stateDir, crypto, tty);
    assert.equal(verifier.confirmed, true);
    assert.deepEqual(crypto.forbiddenCalls, []);
    assert.equal(request.startCalls, 1);
    assert.match(tty.writes[0]!, /Local device: BRIDGE01/u);
    assert.match(tty.writes[0]!, /Target device: TRUSTED01/u);
    assert.match(tty.writes[0]!, /SAS emoji: 😀 \(grinning face\) 🚀 \(rocket\)/u);
    assert.match(tty.writes[0]!, /SAS decimal: 123 456 789/u);
    assert.match(tty.writes[0]!, /exactly yes/u);
    const manifest = JSON.parse(await readFile(join(state.stateDir, "crypto-state.json"), "utf8")) as {
      readonly sasVerified: boolean;
    };
    assert.equal(manifest.sasVerified, true);
  } finally {
    await state.cleanup();
  }
});

void test("uses only the returned outgoing request despite a generic-event alias", async () => {
  const state = await makeState();
  try {
    const verifier = new TestVerifier();
    const returned = new TestRequest({ startVerifier: verifier });
    const duplicate = new TestRequest({ initiatedByMe: false });
    const crypto = new TestCrypto(returned, [duplicate]);
    await runOperation(state.stateDir, crypto, new TestTty("yes"));
    assert.equal(returned.cancelCalls, 0);
    assert.equal(duplicate.cancelCalls, 0);
    assert.equal(duplicate.startCalls, 0);
    assert.equal(returned.startCalls, 1);
    assert.equal(verifier.confirmed, true);
  } finally {
    await state.cleanup();
  }
});

void test("rejects a returned request that the SDK marks as independently initiated", async () => {
  const state = await makeState();
  try {
    const verifier = new TestVerifier();
    const returned = new TestRequest({
      initiatedByMe: false,
      phase: "requested",
      startVerifier: verifier,
    });
    const crypto = new TestCrypto(returned);
    await assert.rejects(
      runOperation(state.stateDir, crypto, new TestTty("yes")),
      (error: unknown) => error instanceof CryptoVerificationError,
    );
    assert.equal(returned.cancelCalls, 1);
    assert.equal(returned.startCalls, 0);
    assert.equal(returned.phase, "cancelled");
    assert.equal(verifier.confirmed, false);
  } finally {
    await state.cleanup();
  }
});

void test("waits for an outgoing request to become ready before starting SAS", async () => {
  const state = await makeState();
  try {
    const verifier = new TestVerifier();
    const request = new TestRequest({
      phase: "requested",
      capabilitiesAfterReady: true,
      methods: ["m.sas.v1"],
      startVerifier: verifier,
    });
    const crypto = new TestCrypto(request);
    const tty = new TestTty("yes");
    const pending = runOperation(state.stateDir, crypto, tty);
    if (!await waitForTestCondition(() => request.changeListenerCount > 0)) {
      await request.cancel();
      await pending.catch(() => {});
      assert.fail("verification readiness listener was not installed");
    }
    assert.equal(request.startCalls, 0);
    assert.equal(request.cancelCalls, 0);
    assert.equal(verifier.started, false);
    request.setPhase("ready");
    await pending;
    assert.equal(request.startCalls, 1);
    assert.equal(verifier.confirmed, true);
  } finally {
    await state.cleanup();
  }
});

void test("defers outgoing Rust target validation until the device identity is available", async () => {
  const state = await makeState();
  try {
    const rawRequest = new RustSdkVerificationRequestDouble();
    const sdkClient = {
      on: () => {},
      getCrypto: () => ({
        getOwnDeviceKeys: async () => ({
          ed25519: FINGERPRINTS.ed25519Fingerprint,
          curve25519: FINGERPRINTS.curve25519Fingerprint,
        }),
        processDeviceLists: async () => {},
        onSyncCompleted: () => {},
        getUserDeviceInfo: async () => new Map([
          [IDENTITY.userId, new Map([[TARGET, rustDevice(IDENTITY.userId, TARGET)]])],
        ]),
        requestDeviceVerification: async () => rawRequest,
      }),
    } as unknown as MatrixSdkClientLike;
    const crypto = new MatrixSdkCryptoAdapter(sdkClient);
    const pending = runOperation(state.stateDir, crypto, new TestTty("yes"));
    if (!await waitForTestCondition(() => (rawRequest.listeners.get("change")?.size ?? 0) > 0)) {
      await rawRequest.cancel();
      await pending.catch(() => {});
      assert.fail("verification readiness listener was not installed");
    }
    assert.equal(rawRequest.startCalls, 0);
    assert.equal(rawRequest.cancelCalls, 0);
    assert.equal(rawRequest.phase, 2);
    assert.equal(rawRequest.otherDeviceId, undefined);
    rawRequest.otherDeviceId = TARGET;
    rawRequest.phase = 3;
    rawRequest.emit("change");
    await pending;
    assert.equal(rawRequest.methodsRead, false);
    assert.equal(rawRequest.startCalls, 1);
    assert.equal(rawRequest.sasVerifier.confirmed, true);
  } finally {
    await state.cleanup();
  }
});

void test("refreshes an absent Rust target through the SDK device-list path before SAS", async () => {
  const state = await makeState();
  try {
    const rawRequest = new RustSdkVerificationRequestDouble();
    rawRequest.otherDeviceId = TARGET;
    rawRequest.phase = 3;
    const calls: string[] = [];
    let localDevices = new Map<string, unknown>();
    const serverDevices = new Map<string, unknown>([
      [TARGET, {
        userId: IDENTITY.userId,
        deviceId: TARGET,
        keys: new Map([
          [`ed25519:${TARGET}`, "valid-ed25519-key"],
          [`curve25519:${TARGET}`, "valid-curve25519-key"],
        ]),
      }],
    ]);
    const sdkCrypto = {
      getOwnDeviceKeys: async () => ({
        ed25519: FINGERPRINTS.ed25519Fingerprint,
        curve25519: FINGERPRINTS.curve25519Fingerprint,
      }),
      processDeviceLists: async (deviceLists: { readonly changed?: readonly string[] }) => {
        calls.push(`processDeviceLists:${deviceLists.changed?.join(",") ?? ""}`);
        localDevices = new Map(serverDevices);
      },
      onSyncCompleted: () => {
        calls.push("onSyncCompleted");
      },
      getUserDeviceInfo: async (userIds: readonly string[]) => {
        calls.push("getUserDeviceInfo");
        return new Map([[userIds[0]!, localDevices]]);
      },
      requestDeviceVerification: async (_userId: string, deviceId: string) => {
        calls.push(`requestDeviceVerification:${deviceId}`);
        if (!localDevices.has(deviceId)) {
          throw new Error("Not a known device");
        }
        return rawRequest;
      },
    };
    const sdkClient = {
      on: () => {},
      getCrypto: () => sdkCrypto,
    } as unknown as MatrixSdkClientLike;
    const crypto = new MatrixSdkCryptoAdapter(sdkClient);

    await assert.rejects(
      () => crypto.requestDeviceVerification(IDENTITY.userId, TARGET),
      /could not be created/u,
    );
    await runOperation(state.stateDir, crypto, new TestTty("yes"));

    assert.deepEqual(calls, [
      "requestDeviceVerification:TRUSTED01",
      "processDeviceLists:@bridge:example.org",
      "onSyncCompleted",
      "getUserDeviceInfo",
      "requestDeviceVerification:TRUSTED01",
    ]);
    assert.equal(rawRequest.sasVerifier.confirmed, true);
  } finally {
    await state.cleanup();
  }
});

void test("refresh rejects a missing, substituted, or wrong-user target without accepting metadata", async () => {
  const cases: readonly {
    readonly name: string;
    readonly requestedUserId: string;
    readonly returnedUserId: string;
    readonly returnedDeviceId?: string;
  }[] = [
    { name: "missing", requestedUserId: IDENTITY.userId, returnedUserId: IDENTITY.userId },
    {
      name: "substituted",
      requestedUserId: IDENTITY.userId,
      returnedUserId: IDENTITY.userId,
      returnedDeviceId: "OTHER01",
    },
    {
      name: "wrong-user",
      requestedUserId: IDENTITY.userId,
      returnedUserId: "@other:example.org",
      returnedDeviceId: TARGET,
    },
  ];
  for (const item of cases) {
    const localDevices = new Map<string, unknown>(
      item.returnedDeviceId === undefined ? [] : [[item.returnedDeviceId, { deviceId: item.returnedDeviceId }]],
    );
    const sdkCrypto = {
      getOwnDeviceKeys: async () => ({
        ed25519: FINGERPRINTS.ed25519Fingerprint,
        curve25519: FINGERPRINTS.curve25519Fingerprint,
      }),
      processDeviceLists: async () => {},
      onSyncCompleted: () => {},
      getUserDeviceInfo: async () => new Map([[item.returnedUserId, localDevices]]),
      requestDeviceVerification: async () => {
        throw new Error("requestDeviceVerification must not be called");
      },
    };
    const crypto = new MatrixSdkCryptoAdapter({
      on: () => {},
      getCrypto: () => sdkCrypto,
    } as unknown as MatrixSdkClientLike);

    assert.equal(
      await crypto.refreshDeviceKeys(item.requestedUserId, TARGET),
      false,
      item.name,
    );
  }
});

void test("fails closed when an outgoing Rust request later exposes a conflicting target", async () => {
  const state = await makeState();
  try {
    const rawRequest = new RustSdkVerificationRequestDouble();
    const sdkClient = {
      on: () => {},
      getCrypto: () => ({
        getOwnDeviceKeys: async () => ({
          ed25519: FINGERPRINTS.ed25519Fingerprint,
          curve25519: FINGERPRINTS.curve25519Fingerprint,
        }),
        processDeviceLists: async () => {},
        onSyncCompleted: () => {},
        getUserDeviceInfo: async () => new Map([
          [IDENTITY.userId, new Map([[TARGET, rustDevice(IDENTITY.userId, TARGET)]])],
        ]),
        requestDeviceVerification: async () => rawRequest,
      }),
    } as unknown as MatrixSdkClientLike;
    const crypto = new MatrixSdkCryptoAdapter(sdkClient);
    const pending = runOperation(state.stateDir, crypto, new TestTty("yes"));
    if (!await waitForTestCondition(() => (rawRequest.listeners.get("change")?.size ?? 0) > 0)) {
      await rawRequest.cancel();
      await pending.catch(() => {});
      assert.fail("verification readiness listener was not installed");
    }
    rawRequest.otherDeviceId = "OTHER01";
    rawRequest.emit("change");
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof CryptoVerificationError && error.reason === "target_rejected",
    );
    assert.equal(rawRequest.cancelCalls, 1);
  } finally {
    await state.cleanup();
  }
});

void test("cancels an active SAS flow when the outgoing target changes later", async () => {
  const state = await makeState();
  try {
    const rawRequest = new RustSdkVerificationRequestDouble();
    const sdkClient = {
      on: () => {},
      getCrypto: () => ({
        getOwnDeviceKeys: async () => ({
          ed25519: FINGERPRINTS.ed25519Fingerprint,
          curve25519: FINGERPRINTS.curve25519Fingerprint,
        }),
        processDeviceLists: async () => {},
        onSyncCompleted: () => {},
        getUserDeviceInfo: async () => new Map([
          [IDENTITY.userId, new Map([[TARGET, rustDevice(IDENTITY.userId, TARGET)]])],
        ]),
        requestDeviceVerification: async () => rawRequest,
      }),
    } as unknown as MatrixSdkClientLike;
    const crypto = new MatrixSdkCryptoAdapter(sdkClient);
    const verifier = rawRequest.sasVerifier;
    const pending = runOperation(state.stateDir, crypto, new TestTty(undefined, true));
    if (!await waitForTestCondition(() => (rawRequest.listeners.get("change")?.size ?? 0) > 0)) {
      await rawRequest.cancel();
      await pending.catch(() => {});
      assert.fail("verification readiness listener was not installed");
    }
    rawRequest.otherDeviceId = TARGET;
    rawRequest.phase = 3;
    rawRequest.emit("change");
    if (!await waitForTestCondition(() => rawRequest.startCalls === 1)) {
      await rawRequest.cancel();
      await pending.catch(() => {});
      assert.fail("verification did not start");
    }
    rawRequest.otherDeviceId = "OTHER01";
    rawRequest.emit("change");
    await assert.rejects(pending, (error: unknown) => error instanceof CryptoVerificationError);
    assert.equal(verifier.confirmed, false);
  } finally {
    await state.cleanup();
  }
});

void test("rejects other-device traffic and never accepts an exact-target incoming request", async () => {
  const state = await makeState();
  try {
    const verifier = new TestVerifier();
    const incoming = new TestRequest({
      initiatedByMe: false,
      phase: "requested",
      capabilitiesAfterReady: true,
      methods: ["m.sas.v1"],
      startVerifier: verifier,
    });
    const wrongUser = new TestRequest({ initiatedByMe: false, userId: "@intruder:example.org" });
    const wrongDevice = new TestRequest({ initiatedByMe: false, deviceId: "OTHER01" });
    const untargeted = new TestRequest({ initiatedByMe: false, deviceId: "" });
    const outgoing = new TestRequest({ startVerifier: new TestVerifier() });
    const crypto = new TestCrypto(outgoing, [wrongUser, wrongDevice, untargeted, incoming]);
    const tty = new TestTty("yes");
    await runOperation(state.stateDir, crypto, tty);
    assert.equal(wrongUser.cancelCalls, 1);
    assert.equal(wrongDevice.cancelCalls, 1);
    assert.equal(untargeted.cancelCalls, 1);
    assert.equal(incoming.startCalls, 0);
    assert.equal(incoming.cancelCalls, 0);
    assert.equal(incoming.phase, "requested");
    assert.equal(outgoing.cancelCalls, 0);
  } finally {
    await state.cleanup();
  }
});

void test("rejects non-SAS methods and negative or EOF operator confirmation without attestation", async (t) => {
  for (const answer of ["no", undefined]) {
    await t.test(`operator answer ${answer ?? "EOF"}`, async () => {
      const state = await makeState();
      try {
        const verifier = new TestVerifier();
        const request = new TestRequest({ startVerifier: verifier });
        const crypto = new TestCrypto(request);
        await assert.rejects(
          runOperation(state.stateDir, crypto, new TestTty(answer)),
          (error: unknown) => error instanceof CryptoVerificationError,
        );
        assert.equal(verifier.confirmed, false);
        const manifest = JSON.parse(await readFile(join(state.stateDir, "crypto-state.json"), "utf8")) as {
          readonly sasVerified: boolean;
        };
        assert.equal(manifest.sasVerified, false);
      } finally {
        await state.cleanup();
      }
    });
  }

  const state = await makeState();
  try {
    const request = new TestRequest({ methods: ["m.qr_code.show.v1"] });
    await assert.rejects(
      runOperation(state.stateDir, new TestCrypto(request), new TestTty("yes")),
      (error: unknown) => error instanceof CryptoVerificationError && error.reason === "method_rejected",
    );
  } finally {
    await state.cleanup();
  }
});

void test("times out a pending operator interaction, handles remote cancellation, and survives manifest write failure", async (t) => {
  const timeoutState = await makeState();
  try {
    const clock = new FakeClock();
    const verifier = new TestVerifier();
    const operation = new MatrixCryptoVerificationOperation({
      crypto: new TestCrypto(new TestRequest({ startVerifier: verifier })),
      ttyFactory: ttyFactory(new TestTty(undefined, true)),
      timeoutMs: 1000,
      clock,
    });
    const pending = operation.run({
      identity: IDENTITY,
      state: {
        databasePath: join(timeoutState.stateDir, "matrix-crypto"),
        manifestPath: join(timeoutState.stateDir, "crypto-state.json"),
      },
      targetDeviceId: TARGET,
    });
    if (!await waitForTestCondition(() => clock.pendingTimerCount > 0)) {
      await operation.cancel();
      await pending.catch(() => {});
      assert.fail("verification timeout timer was not installed");
    }
    clock.advanceBy(1000);
    await assert.rejects(pending, /timed out/u);
    assert.equal(verifier.cancelled, true);
  } finally {
    await timeoutState.cleanup();
  }

  const remoteState = await makeState();
  try {
    const verifier = new TestVerifier();
    const request = new TestRequest({ verifier });
    const remoteClock = new FakeClock();
    const operation = new MatrixCryptoVerificationOperation({
      crypto: new TestCrypto(request),
      ttyFactory: ttyFactory(new TestTty(undefined, true)),
      timeoutMs: 10_000,
      clock: remoteClock,
    });
    const pending = operation.run({
      identity: IDENTITY,
      state: {
        databasePath: join(remoteState.stateDir, "matrix-crypto"),
        manifestPath: join(remoteState.stateDir, "crypto-state.json"),
      },
      targetDeviceId: TARGET,
    });
    if (!await waitForTestCondition(() => verifier.started)) {
      await operation.cancel();
      await pending.catch(() => {});
      assert.fail("verification verifier was not started");
    }
    assert.equal(verifier.started, true);
    verifier.cancel();
    await assert.rejects(pending, /failed/u);
  } finally {
    await remoteState.cleanup();
  }

  await t.test("manifest replacement failure leaves sasVerified false", async () => {
    const state = await makeState();
    try {
      const verifier = new TestVerifier();
      await assert.rejects(
        runOperation(state.stateDir, new TestCrypto(new TestRequest({ startVerifier: verifier })), new TestTty("yes"), {
          stateFaultInjector: (point) => {
            if (point === "write") {
              throw new Error("injected manifest write failure");
            }
          },
        }),
      );
      const manifest = JSON.parse(await readFile(join(state.stateDir, "crypto-state.json"), "utf8")) as {
        readonly sasVerified: boolean;
      };
      assert.equal(manifest.sasVerified, false);
    } finally {
      await state.cleanup();
    }
  });
});
