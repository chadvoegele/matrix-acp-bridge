import { spawn } from "node:child_process";
import { join } from "node:path";
import { Transform } from "node:stream";

import { repoRoot } from "./common.mjs";

export function childExit(child, name, allowed = [0]) {
  const finish = (code, signal, resolve, reject) => {
    if (allowed.includes(code) || (signal === "SIGTERM" && allowed.includes(143))) resolve(code);
    else reject(new Error(`${name} exited with ${code ?? signal}`));
  };
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(child.exitCode, child.signalCode, resolve, reject);
      return;
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => finish(code, signal, resolve, reject));
  });
}

export function jsonLineTap(inspect) {
  let pending = "";
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try { inspect(JSON.parse(line)); } catch { /* Preserve malformed ACP frames unchanged. */ }
      }
      callback(null, chunk);
    },
  });
}

export function parseDiagnostics(text) {
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export async function startBridgePair(environment, { onOutbound, onInbound } = {}) {
  const [acpProgram, ...acpArguments] = environment.acpCommand;
  const acp = spawn(acpProgram, acpArguments, { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
  const bridge = spawn(process.execPath, [join(repoRoot, "dist/main.js"), "--config", environment.bridge.configFile], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const outbound = jsonLineTap(onOutbound ?? (() => {}));
  const inbound = jsonLineTap(onInbound ?? (() => {}));
  bridge.stdout.pipe(outbound).pipe(acp.stdin);
  acp.stdout.pipe(inbound).pipe(bridge.stdin);

  let bridgeDiagnostics = "";
  let acpDiagnostics = "";
  bridge.stderr.on("data", (chunk) => { bridgeDiagnostics += chunk.toString("utf8"); });
  acp.stderr.on("data", (chunk) => { acpDiagnostics += chunk.toString("utf8"); });
  const pair = {
    acp,
    bridge,
    bridgeDiagnostics: () => bridgeDiagnostics,
    acpDiagnostics: () => acpDiagnostics,
  };
  await waitFor(
    () => bridgeDiagnostics.includes("startup-ready"),
    "bridge startup-ready",
    120_000,
    pair,
  );
  return pair;
}

export async function stopBridgePair(pair) {
  if (pair.bridge.exitCode === null && pair.bridge.signalCode === null) pair.bridge.kill("SIGTERM");
  await childExit(pair.bridge, "bridge");
  if (pair.acp.exitCode === null && pair.acp.signalCode === null) pair.acp.kill("SIGTERM");
  await childExit(pair.acp, "ACP proxy", [0, 143]);
}

export async function runSender({ environmentPath, senderPath, args, forwardStderr = true }) {
  const child = spawn(process.execPath, [senderPath, "--environment", environmentPath, ...args], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (forwardStderr) process.stderr.write(chunk);
  });
  try {
    await childExit(child, "sender");
  } catch (error) {
    if (!forwardStderr && stderr) process.stderr.write(stderr);
    throw error;
  }
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
}

export async function waitFor(predicate, label, timeoutMs = 30_000, pair) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (pair?.bridge.exitCode !== null || pair?.acp.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (pair !== undefined) process.stderr.write(pair.bridgeDiagnostics());
  throw new Error(`${label} timed out`);
}
