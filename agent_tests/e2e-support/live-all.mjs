#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { selectAuthMode } from "./auth.mjs";
import { repoRoot, writePrivateFile } from "./common.mjs";
import { warmProfile } from "./warm-profile.mjs";
import { liveExitCode, runIndependentCases } from "./live-results.mjs";

if (process.env.E2E_LIVE_LOCK_HELD === "1") {
  await runLiveSuites();
} else {
  const child = spawn(
    "flock",
    [
      "-n",
      "/tmp/matrix-acp-bridge-steering-live.lock",
      "env",
      "E2E_LIVE_LOCK_HELD=1",
      process.execPath,
      ...process.argv.slice(1),
    ],
    { stdio: "inherit" },
  );
  child.once("exit", (code) => process.exit(code ?? 1));
}

async function runLiveSuites() {
  const evidenceRoot =
    process.env.E2E_LIVE_REPORT_DIR ?? join(homedir(), `.local/state/matrix-acp-validation/live-${Date.now()}`);
  await mkdir(evidenceRoot, { mode: 0o700, recursive: true });
  const cases = [{ name: "fresh-crypto-setup", transport: "encrypted", mode: "room", fresh: true }];
  for (const transport of ["plaintext", "encrypted"]) {
    for (const mode of ["room", "thread"]) {
      const prefix =
        mode === "thread" ? "thread-sessions" : transport === "plaintext" ? "unencrypted-e2e" : "encrypted-e2e";
      const normal = mode === "thread" ? `${transport}-run.mjs` : "run.mjs";
      const activity = mode === "thread" ? `${transport}-activity-wire.mjs` : "activity-wire.mjs";
      cases.push(
        { name: `${transport}-${mode}-normal`, transport, mode, prefix, runner: normal },
        { name: `${transport}-${mode}-activity`, transport, mode, prefix, runner: activity, scripted: true },
        { name: `${transport}-${mode}-steering`, transport, mode, prefix, steering: true },
      );
    }
  }
  for (const [name, runner] of [
    ["reset", "run-reset.mjs"],
    ["persistence", "restart-persistence-run.mjs"],
    ["completed-id-recovery", "completed-id-recovery-run.mjs"],
    ["real-activity", "real-activity.mjs"],
  ])
    cases.push({
      name: `plaintext-room-${name}`,
      transport: "plaintext",
      mode: "room",
      prefix: "unencrypted-e2e",
      runner,
    });
  cases.push({
    name: "plaintext-room-startup",
    transport: "plaintext",
    mode: "room",
    prefix: "unencrypted-e2e",
    startup: true,
  });
  cases.sort((first, second) => rank(first) - rank(second));
  const warmed = new Set();
  const selected = process.argv.slice(2);
  const results = await runIndependentCases(
    cases.filter((scenario) => selected.length === 0 || selected.includes(scenario.name)),
    execute,
  );
  await writePrivateFile(join(evidenceRoot, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  for (const result of results) console.log(JSON.stringify(result));
  process.exitCode = liveExitCode(results);

  async function execute(scenario) {
    const directory = join(evidenceRoot, scenario.name);
    await mkdir(directory, { mode: 0o700 });
    const environmentPath = join(directory, "environment.json");
    const prefix = scenario.prefix ?? "encrypted-e2e";
    const thread = scenario.mode === "thread";
    const encrypted = scenario.transport === "encrypted";
    const provision = thread ? `${scenario.transport}-provision.mjs` : "provision.mjs";
    const cleanup = thread ? `${scenario.transport}-cleanup.mjs` : "cleanup.mjs";
    const verify = thread ? "encrypted-verify-sas.mjs" : "verify-sas.mjs";
    const environmentVariable = thread
      ? `THREAD_${scenario.transport.toUpperCase()}_ENVIRONMENT_FILE`
      : encrypted
        ? "E2E_ENVIRONMENT_FILE"
        : "UNENCRYPTED_E2E_ENVIRONMENT_FILE";
    const rootVariable = thread
      ? `THREAD_${scenario.transport.toUpperCase()}_PRIVATE_ROOT`
      : encrypted
        ? "E2E_PRIVATE_ROOT"
        : "UNENCRYPTED_E2E_PRIVATE_ROOT";
    const settings = {
      ...process.env,
      E2E_AUTH_MODE: scenario.fresh ? "password" : selectAuthMode(),
      [environmentVariable]: environmentPath,
      [rootVariable]: join(directory, "run"),
      STEERING_EVIDENCE_FILE: join(directory, "wire.json"),
      E2E_REQUEST_AUDIT: join(directory, "request-audit.jsonl"),
    };
    if (scenario.fresh)
      for (const name of Object.keys(settings))
        if (/^E2E_(?:BRIDGE|SENDER|HELPER)_(?:ACCESS_TOKEN_FILE|DEVICE_ID|STATE_DIR)$/u.test(name))
          delete settings[name];
    if (scenario.scripted)
      settings.E2E_ACP_COMMAND = JSON.stringify([
        process.execPath,
        join(repoRoot, "agent_tests/e2e-support/scripted-activity-acp.mjs"),
      ]);
    const result = { name: scenario.name, setup: "FAILED", function: "SKIPPED", cleanup: "PASSED" };
    const log = await open(join(directory, "suite.log"), "wx", 0o600);
    const run = (script, arguments_ = []) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [join(repoRoot, script), ...arguments_], {
          cwd: repoRoot,
          env: settings,
          stdio: ["ignore", log.fd, log.fd],
        });
        child.once("error", () => resolve(1));
        child.once("close", (code) => resolve(code ?? 1));
      });
    try {
      let code = await run(`agent_tests/${prefix}/${provision}`);
      if (code === 0 && encrypted) code = await run(`agent_tests/${prefix}/${verify}`, [environmentPath]);
      result.setup = code === 0 ? "PASSED" : "FAILED";
      if (code === 0 && !scenario.fresh) {
        const environment = JSON.parse(await readFile(environmentPath, "utf8"));
        if (!environment.bridge.cacheInitial) result.setup = "REUSED";
      }
      if (code !== 0) {
        const contents = await readFile(join(directory, "suite.log"), "utf8");
        if (/SETUP BLOCKED|HTTP 429/u.test(contents)) {
          result.setup = "BLOCKED";
          result.reason = /HTTP 429/u.test(contents)
            ? "HTTP 429 during designated test-device login"
            : "designated test password unavailable";
          const retry = contents.match(/Error: SETUP BLOCKED: HTTP 429; retry after ([0-9TZ:.-]+)/u);
          if (retry) result.retryAfter = retry[1];
        }
      } else if (scenario.fresh) {
        result.function = "NOT_APPLICABLE";
      } else {
        const profile = `${scenario.transport}-${scenario.mode}`;
        if (!warmed.has(profile)) {
          const environment = JSON.parse(await readFile(environmentPath, "utf8"));
          // Dormant profiles legitimately recover inputs generated by other mode tests.
          // Execute recovery normally, preserving every terminal ID before strict cases.
          const recoveryEnvironment = { ...environment, acpCommand: JSON.parse(process.env.E2E_ACP_COMMAND) };
          await writePrivateFile(environmentPath, `${JSON.stringify(recoveryEnvironment)}\n`);
          await warmProfile(recoveryEnvironment, join(directory, "profile-recovery.json"));
          await writePrivateFile(environmentPath, `${JSON.stringify(environment)}\n`);
          warmed.add(profile);
        }
        console.log(`${scenario.name}: setup ready; functional validation running`);
        if (scenario.steering)
          code = await run("agent_tests/steering/live-matrix.mjs", [
            environmentPath,
            scenario.transport,
            scenario.mode,
          ]);
        else if (scenario.startup) {
          const environment = JSON.parse(await readFile(environmentPath, "utf8"));
          const config = await readFile(environment.bridge.configFile, "utf8");
          await writePrivateFile(
            environment.bridge.configFile,
            config.replace("[matrix]", '[matrix]\ndefault_message_delivery = "steer"'),
          );
          for (const operation of ["send", "catchup", "quiet", "reset"]) {
            code = await run("agent_tests/steering/startup-matrix.mjs", [
              environmentPath,
              operation,
              join(directory, `${operation}-wire.json`),
              join(directory, "input.json"),
            ]);
            if (code !== 0) break;
          }
        } else code = await run(`agent_tests/${prefix}/${scenario.runner}`, [environmentPath]);
        result.function = code === 0 ? "PASSED" : "FAILED";
        if (code !== 0) warmed.delete(profile);
      }
    } catch {
      result.setup = "FAILED";
      result.function = "SKIPPED";
      result.reason = "profile recovery/controller failed; inspect private evidence";
    } finally {
      await cleanupRun();
      await log.close();
    }

    async function cleanupRun() {
      try {
        await stat(environmentPath);
        // Steering/reset can detach mappings; retain every observed session for cleanup.
        const environment = JSON.parse(await readFile(environmentPath, "utf8"));
        const sessions = new Set();
        const sessionPath = join(environment.bridge.stateDir, "e2e-session-ids.json");
        try {
          for (const id of JSON.parse(await readFile(sessionPath, "utf8"))) sessions.add(id);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        for (const file of ["wire.json", "send-wire.json", "catchup-wire.json", "quiet-wire.json", "reset-wire.json"]) {
          try {
            const evidence = JSON.parse(await readFile(join(directory, file), "utf8"));
            for (const item of evidence.frames ?? [])
              if (typeof item.frame?.result?.sessionId === "string") sessions.add(item.frame.result.sessionId);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        await writeFile(sessionPath, JSON.stringify([...sessions]), { mode: 0o600 });
        if ((await run(`agent_tests/${prefix}/${cleanup}`, [environmentPath])) !== 0) result.cleanup = "RETAINED";
      } catch (error) {
        if (error.code !== "ENOENT") result.cleanup = "RETAINED";
      }
    }

    await writePrivateFile(join(directory, "result.json"), `${JSON.stringify(result)}\n`);
    return result;
  }
}

function rank(scenario) {
  if (scenario.fresh) return -1;
  if (scenario.name === "plaintext-room-real-activity") return 4;
  if (scenario.transport === "plaintext") return scenario.mode === "room" ? 0 : 1;
  return scenario.mode === "room" ? 2 : 3;
}
