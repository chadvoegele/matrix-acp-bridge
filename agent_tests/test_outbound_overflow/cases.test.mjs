import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { repoRoot } from "../e2e-support/common.mjs";
import { configureLiveCase, listLiveCases, recoveryCommand, selectLiveCases } from "../e2e-support/live-cases.mjs";

const execute = promisify(execFile);

test("overflow is discoverable, explicit-only and dispatched to its own peer/report", () => {
  assert.equal(listLiveCases().filter((scenario) => scenario.selectionOnly).length, 2);
  assert(!selectLiveCases([]).some((scenario) => scenario.name.endsWith("-overflow")));
  assert.throws(() => selectLiveCases(["typo"]), /Unknown live case/u);
  for (const transport of ["plaintext", "encrypted"]) {
    const [scenario] = selectLiveCases([`${transport}-thread-overflow`]);
    const settings = { E2E_AUTH_MODE: "cache", E2E_CACHE_PROFILE: "isolated-scripted" };
    configureLiveCase(scenario, settings, "/private/report");
    const command = [process.execPath, join(repoRoot, "agent_tests/test_outbound_overflow/peer.mjs")];
    assert.deepEqual(JSON.parse(settings.E2E_ACP_COMMAND), command);
    assert.equal(settings.E2E_OVERFLOW_REPORT, "/private/report/overflow.json");
    assert.equal(scenario.prefix, "test_thread_sessions");
    assert.equal(scenario.runner, "../test_outbound_overflow/run.mjs");
    assert.deepEqual(recoveryCommand(scenario, { acpCommand: command }, { E2E_ACP_COMMAND: "not Pi" }), command);
    assert.throws(() => configureLiveCase(scenario, { E2E_AUTH_MODE: "cache" }, "/private"), /SETUP BLOCKED/u);
  }
  const [activity] = selectLiveCases(["plaintext-thread-activity"]);
  const settings = {};
  configureLiveCase(activity, settings, "/private");
  assert.match(JSON.parse(settings.E2E_ACP_COMMAND)[1], /scripted-activity-acp.mjs$/u);
});

for (const transport of ["plaintext", "encrypted"]) {
  for (const recoveryFails of [false, true]) {
    test(`serial ${transport} overflow dispatch and ${recoveryFails ? "failed" : "successful"} recovery cleanup`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "overflow-dispatch-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const report = join(root, "report");
      const calls = join(root, "calls.jsonl");
      const loader = join(root, "loader.mjs");
      // Replace only child/credential boundaries. Execute the real serial controller.
      const childSource = `
        import { EventEmitter } from "node:events";
        import { appendFile, mkdir, writeFile, rm } from "node:fs/promises";
        import { dirname, join } from "node:path";
        export function spawn(command, args, options) {
          const child = new EventEmitter();
          queueMicrotask(async () => {
            const settings = options.env;
            const environmentPath = settings.THREAD_${transport.toUpperCase()}_ENVIRONMENT_FILE;
            await appendFile(${JSON.stringify(calls)}, JSON.stringify({ args, peer: JSON.parse(settings.E2E_ACP_COMMAND), report: settings.E2E_OVERFLOW_REPORT }) + "\\n");
            if (args[0].endsWith("-provision.mjs")) {
              const stateDir = join(dirname(environmentPath), "state");
              await mkdir(stateDir);
              await writeFile(environmentPath, JSON.stringify({ acpCommand: JSON.parse(settings.E2E_ACP_COMMAND), bridge: { stateDir, cacheInitial: false } }));
            }
            if (args[0].endsWith("-cleanup.mjs")) await rm(environmentPath);
            child.emit("close", 0);
          });
          return child;
        }
      `;
      const warmSource = `
        import { appendFile } from "node:fs/promises";
        export async function warmProfile(environment) {
          await appendFile(${JSON.stringify(calls)}, JSON.stringify({ recovery: environment.acpCommand }) + "\\n");
          ${recoveryFails ? 'throw new Error("fixture recovery failed");' : ""}
        }
      `;
      await writeFile(
        loader,
        `
        export async function load(url, context, nextLoad) {
          if (url === "node:child_process") return { format: "module", source: ${JSON.stringify(childSource)}, shortCircuit: true };
          if (url.endsWith("/e2e-support/warm-profile.mjs")) return { format: "module", source: ${JSON.stringify(warmSource)}, shortCircuit: true };
          return nextLoad(url, context);
        }
      `,
      );
      const result = await execute(
        process.execPath,
        ["--loader", loader, join(repoRoot, "agent_tests/e2e-support/live-all.mjs"), `${transport}-thread-overflow`],
        {
          env: {
            ...process.env,
            E2E_LIVE_LOCK_HELD: "1",
            E2E_AUTH_MODE: "cache",
            E2E_CACHE_PROFILE: "isolated-scripted",
            E2E_LIVE_REPORT_DIR: report,
            E2E_ACP_COMMAND: '["never-run-Pi"]',
          },
        },
      ).catch((error) => error);
      assert.equal(result.code ?? 0, recoveryFails ? 1 : 0, result.stderr);
      const contents = await readFile(calls, "utf8");
      const entries = contents
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const peer = [process.execPath, join(repoRoot, "agent_tests/test_outbound_overflow/peer.mjs")];
      assert(entries.every((entry) => JSON.stringify(entry.peer ?? entry.recovery) === JSON.stringify(peer)));
      const scripts = entries.filter((entry) => entry.args).map((entry) => entry.args[0]);
      assert(scripts[0].endsWith(`${transport}-provision.mjs`));
      assert.equal(
        scripts.some((script) => script.endsWith("encrypted-verify-sas.mjs")),
        transport === "encrypted",
      );
      assert.equal(
        scripts.some((script) => script.endsWith("test_outbound_overflow/run.mjs")),
        !recoveryFails,
      );
      assert(scripts.at(-1).endsWith(`${transport}-cleanup.mjs`));
      const [outcome] = JSON.parse(await readFile(join(report, "results.json"), "utf8"));
      assert.equal(outcome.setup, recoveryFails ? "FAILED" : "REUSED");
      assert.equal(outcome.function, recoveryFails ? "SKIPPED" : "PASSED");
      assert.equal(outcome.cleanup, "PASSED");
      assert.equal(entries[0].report, join(report, `${transport}-thread-overflow/overflow.json`));
    });
  }
}

test("behavior shell wrapper delegates to the same serial selection without provisioning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "overflow-wrapper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin/node"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  for (const transport of ["plaintext", "encrypted"]) {
    const { stdout } = await execute("sh", [join(repoRoot, "agent_tests/test_outbound_overflow/test.sh"), transport], {
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
    });
    assert.deepEqual(stdout.trim().split("\n"), [
      join(repoRoot, "agent_tests/e2e-support/live-all.mjs"),
      `${transport}-thread-overflow`,
    ]);
  }
});
