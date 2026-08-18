#!/usr/bin/env node
import { createAdapter, readEnvironment } from "./lib.mjs";

const environment = await readEnvironment(process.argv[2]);
const adapter = await createAdapter(environment, "helper");
const crypto = adapter.getCryptoVerificationAdapter();
const expectedUserId = environment.bridge.userId;
const expectedDeviceId = environment.bridge.deviceId;
let activeRequest;
let stopped = false;
let phase = "starting";

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function waitFor(request, predicate, timeoutMs = 120_000) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("verification phase timed out")), timeoutMs);
    const unsubscribe = request.onChange(() => {
      try {
        if (predicate()) finish();
      } catch (error) {
        finish(error);
      }
    });
    function finish(error) {
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    }
  });
}

let resolveDecision;
const decision = new Promise((resolve) => { resolveDecision = resolve; });
process.once("SIGUSR1", () => resolveDecision("confirm"));
process.once("SIGHUP", () => resolveDecision("mismatch"));

async function handle(request) {
  if (["cancelled", "done"].includes(request.phase)) return;
  phase = "request-received";
  if (activeRequest !== undefined) {
    const sameTarget = request.userId === expectedUserId &&
      (request.deviceId === "" || request.deviceId === expectedDeviceId);
    if (sameTarget) return;
    await request.cancel().catch(() => {});
    return;
  }
  if (request.initiatedByMe) {
    await request.cancel().catch(() => {});
    return;
  }
  activeRequest = request;
  if (request.userId === "" || request.deviceId === "") {
    phase = "request-identification";
    await waitFor(request, () =>
      (request.userId !== "" && request.deviceId !== "") || ["cancelled", "done"].includes(request.phase));
  }
  if (request.userId !== expectedUserId || request.deviceId !== expectedDeviceId) {
    await request.cancel().catch(() => {});
    throw new Error("verification request target did not match the configured bridge device");
  }
  if (request.phase === "requested" && !request.accepting) {
    phase = "request-accepted";
    await request.accept();
  }
  phase = "request-ready";
  await waitFor(request, () => ["ready", "started", "cancelled", "done"].includes(request.phase));
  if (["cancelled", "done"].includes(request.phase)) throw new Error("verification ended before SAS");
  if (!request.supportsMethod("m.sas.v1")) throw new Error("peer does not support SAS");
  await waitFor(request, () => request.verifier !== undefined || ["cancelled", "done"].includes(request.phase));
  const verifier = request.verifier;
  if (verifier === undefined) throw new Error("SAS verifier was not created");

  let sasShown = false;
  let decisionPromise;
  const unsubscribeShow = verifier.onShowSas((sas) => {
    if (sasShown) return;
    sasShown = true;
    const emoji = sas.emoji?.map(([symbol, name]) => `${symbol} (${name})`).join(" ");
    const decimal = sas.decimal?.join(" ");
    emit({ event: "sas", emoji, decimal });
    phase = "sas-shown";
    decisionPromise = decision.then(async (operatorDecision) => {
      phase = "operator-decision";
      if (operatorDecision === "confirm") await sas.confirm();
      else if (operatorDecision === "mismatch") sas.mismatch();
      else sas.cancel();
    });
  });
  const unsubscribeCancel = verifier.onCancel(() => emit({ event: "cancelled" }));
  try {
    phase = "verification";
    await verifier.verify();
    if (!sasShown || decisionPromise === undefined) throw new Error("SAS was not shown");
    await decisionPromise;
    phase = "verified";
    emit({ event: "verified" });
  } finally {
    unsubscribeShow();
    unsubscribeCancel();
  }
}

const done = new Promise((resolve, reject) => {
  crypto.onVerificationRequest((request) => void handle(request).then(resolve, () => {
    activeRequest = undefined;
    emit({ event: "verification-attempt-failed", phase, reason: "attempt-failed" });
    reject(new Error("verification attempt failed"));
  }));
});

async function close() {
  if (stopped) return;
  stopped = true;
  await adapter.stop().catch(() => {});
  await adapter.closeCrypto().catch(() => {});
}

process.once("SIGTERM", () => void close().then(() => process.exit(143)));
process.once("SIGINT", () => void close().then(() => process.exit(130)));

try {
  await adapter.start();
  emit({ event: "ready" });
  await done;
  await close();
} catch {
  emit({ event: "error", reason: "verification-failed" });
  await close();
  process.exitCode = 1;
}
