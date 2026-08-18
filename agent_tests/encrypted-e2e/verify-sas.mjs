#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as osSignals } from "node:os";
import { join } from "node:path";

import { readEnvironment, repoRoot, testDir } from "./lib.mjs";

const environmentPath = process.argv[2] ?? join(testDir, "environment.json");
const environment = await readEnvironment(environmentPath);
const timeoutMs = 180_000;
let helper;
let bridge;
let helperLines = "";
let bridgeOutput = "";
let bridgeDiagnosticLines = "";
let helperSas;
let bridgeDecimal;
let bridgeEmoji;
let helperReady = false;
let helperVerified = false;
let helperPhase = "starting";
let bridgePhase = "starting";
let bridgeFailureReason;
let confirmed = false;
let bridgeExit;
let settled = false;

const safeReasons = new Set([
  "target_rejected",
  "method_rejected",
  "operator_rejected",
  "cancelled",
  "timeout",
  "protocol",
  "tty",
  "manifest",
  "attempt-failed",
  "verification-failed",
  "unknown",
]);

const safePhases = new Set([
  "starting",
  "request-received",
  "request-identification",
  "request-accepted",
  "request-ready",
  "sas-shown",
  "operator-decision",
  "verification",
  "verified",
  "bridge-started",
  "sas-confirmation",
  "bridge-verification",
  "helper-verification",
]);

function safeValue(value, allowed, fallback = "unknown") {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function safeFailure(side, phase, reason) {
  const safeSide = side === "bridge" || side === "helper" ? side : "unknown";
  const safePhase = safeValue(phase, safePhases);
  const safeReason = safeValue(reason, safeReasons);
  return new Error(`SAS verification failed on ${safeSide} during ${safePhase} (${safeReason})`);
}

function parseBridgeDiagnostic(line) {
  // eslint-disable-next-line no-control-regex -- strip terminal escape sequences
  const cleanLine = line.replaceAll("\r", "").replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "").trim();
  if (cleanLine.length === 0) return;
  let record;
  try {
    record = JSON.parse(cleanLine);
  } catch {
    return;
  }
  if (record?.event !== "crypto-verification-failed") return;
  bridgeFailureReason = safeValue(record.fields?.reason, safeReasons);
}

function captureBridgeDiagnostics(chunk) {
  bridgeDiagnosticLines += chunk.toString("utf8");
  while (bridgeDiagnosticLines.includes("\n")) {
    const newline = bridgeDiagnosticLines.indexOf("\n");
    const line = bridgeDiagnosticLines.slice(0, newline);
    bridgeDiagnosticLines = bridgeDiagnosticLines.slice(newline + 1);
    parseBridgeDiagnostic(line);
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function bridgeCommand() {
  return [
    process.execPath,
    join(repoRoot, "dist/main.js"),
    "--config",
    environment.bridge.configFile,
    "crypto",
    "verify",
    "--device",
    environment.helper.deviceId,
  ].map((argument) => shellQuote(argument)).join(" ");
}

function stop(child) {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
}

const result = new Promise((resolve, reject) => {
  const timer = setTimeout(() => finish(new Error("SAS verification timed out")), timeoutMs);

  function finish(error) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error === undefined) resolve();
    else reject(error);
  }

  function check() {
    if (settled) return;
    if (helperReady && bridge === undefined) startBridge();
    if (helperSas !== undefined && bridgeDecimal !== undefined && bridgeEmoji !== undefined && !confirmed) {
      if (helperSas.decimal !== bridgeDecimal || helperSas.emoji !== bridgeEmoji) {
        finish(safeFailure("bridge", "sas-confirmation", "protocol"));
        return;
      }
      confirmed = true;
      bridgePhase = "bridge-verification";
      helperPhase = "operator-decision";
      helper.kill(osSignals.signals.SIGUSR1);
      bridge.stdin.write("yes\n");
    }
    if (helperVerified && bridgeExit === 0) finish();
  }

  function startBridge() {
    bridgePhase = "bridge-started";
    bridge = spawn("script", ["-q", "-e", "-f", "-c", bridgeCommand(), "/dev/null"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    bridge.stdout.on("data", (chunk) => {
      bridgeOutput = `${bridgeOutput}${chunk.toString("utf8")}`.slice(-65_536);
      captureBridgeDiagnostics(chunk);
      const decimal = bridgeOutput.match(/SAS decimal: ([0-9]+ [0-9]+ [0-9]+)/u);
      const emoji = bridgeOutput.match(/SAS emoji: (.+?)\r?\n/u);
      if (decimal !== null) bridgeDecimal = decimal[1];
      if (emoji !== null) bridgeEmoji = emoji[1]?.replace(/\r/gu, "");
      check();
    });
    bridge.stderr.resume();
    bridge.once("error", () => finish(safeFailure("bridge", bridgePhase, bridgeFailureReason)));
    bridge.once("exit", (code, _signal) => {
      bridgeExit = code;
      if (code === 0) {check();}
      else {finish(safeFailure("bridge", bridgePhase, bridgeFailureReason));}
    });
  }

  helper = spawn(process.execPath, [join(testDir, "sas-helper.mjs"), environmentPath], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  helper.stdout.on("data", (chunk) => {
    helperLines += chunk.toString("utf8");
    while (helperLines.includes("\n")) {
      const newline = helperLines.indexOf("\n");
      const line = helperLines.slice(0, newline);
      helperLines = helperLines.slice(newline + 1);
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        finish(safeFailure("helper", helperPhase, "protocol"));
        return;
      }
      switch (event.event) {
      case "ready": {
        helperReady = true;
        helperPhase = "request-received";

      break;
      }
      case "sas": {
        helperSas = event;
        helperPhase = "sas-shown";

      break;
      }
      case "verified": {
        helperVerified = true;
        helperPhase = "verified";

      break;
      }
      case "verification-attempt-failed": {
        helperPhase = safeValue(event.phase, safePhases, "helper-verification");
        finish(safeFailure("helper", helperPhase, event.reason));
        return;
      }
      case "error":
      case "cancelled": {
        finish(safeFailure("helper", helperPhase, event.reason));
        return;
      }
      // No default
      }
      check();
    }
  });
  helper.stderr.resume();
  helper.once("error", () => finish(safeFailure("helper", helperPhase, "protocol")));
  helper.once("exit", (_code, _signal) => {
    if (helperVerified) {check();}
    else {finish(safeFailure("helper", helperPhase, "verification-failed"));}
  });
});

try {
  await result;
  process.stdout.write("SAS verification completed; emoji and decimal values matched.\n");
} finally {
  stop(bridge);
  stop(helper);
}
