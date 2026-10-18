import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { repoRoot } from "./common.mjs";

for (const transport of ["plaintext", "encrypted"]) {
  for (const mode of ["room", "thread"]) {
    test(
      `outage runner checks ${transport} ${mode} exchanges through its matching sender`,
      { timeout: 5000 },
      async (t) => {
        const root = await mkdtemp(join(tmpdir(), "matrix-acp-outage-runner-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const environmentPath = join(root, "environment.json");
        const observationsPath = join(root, "observations.json");
        const environment = { transport, responseMode: mode };
        await writeFile(environmentPath, JSON.stringify(environment));
        const loader = join(root, "fixture.mjs");
        // Stub the process/credential boundary, not the runner's assertions. No Matrix or ACP process runs.
        const acpSource = `
        import assert from "node:assert/strict";
        import { writeFileSync } from "node:fs";
        const environment = ${JSON.stringify(environment)};
        const calls = [];
        let callbacks;
        const pair = { bridgeDiagnostics: () => "fixture" };
        export async function startBridgePair(_environment, options) { callbacks = options; options.onPair(pair); return pair; }
        export async function runSender({ senderPath, args }) {
          const name = environment.responseMode === "thread"
            ? "test_thread_sessions/" + environment.transport + "-sender.mjs"
            : (environment.transport === "encrypted" ? "test_encrypted_message" : "test_unencrypted_message") + "/sender.mjs";
          assert.ok(senderPath.endsWith(name), "wrong sender selected");
          const prompt = args[1];
          callbacks.onOutbound({ method: "session/prompt", params: { prompt: [{ type: "text", text: prompt }] } });
          callbacks.onInbound({ params: { update: { content: { text: args[3] } } } });
          calls.push({ sender: name, prompt });
          const type = environment.transport === "encrypted" ? "m.room.encrypted" : "m.room.message";
          return { responseCount: 1, promptWireType: type, responseWireType: type };
        }
        export function parseDiagnostics() {
          return [
            { event: "outage-http-send", transaction: "stable", blocked: true, stage: "start", time: 0 },
            { event: "outage-http-send", transaction: "stable", stage: "reject", time: 30000 },
            { event: "outage-http-send", transaction: "stable", blocked: false, stage: "start", time: 60001 },
            { event: "outage-http-send", transaction: "stable", blocked: false, stage: "response", time: 60002 }
          ];
        }
        export async function stopBridgePair() { writeFileSync(${JSON.stringify(observationsPath)}, JSON.stringify(calls)); }
      `;
        const commonSource = `export const repoRoot = ${JSON.stringify(repoRoot)}; export async function readEnvironment() { return ${JSON.stringify(environment)}; }`;
        await writeFile(
          loader,
          `
        const acp = ${JSON.stringify(acpSource)};
        const common = ${JSON.stringify(commonSource)};
        export async function load(url, context, nextLoad) {
          if (url.endsWith("/agent_tests/e2e-support/acp.mjs")) return { format: "module", source: acp, shortCircuit: true };
          if (url.endsWith("/agent_tests/e2e-support/common.mjs")) return { format: "module", source: common, shortCircuit: true };
          const loaded = await nextLoad(url, context);
          if (url.endsWith("/agent_tests/test_matrix_outage/run.mjs")) return { ...loaded, source: "const originalTimer = globalThis.setTimeout; globalThis.setTimeout = (callback, delay, ...args) => originalTimer(callback, delay === 60000 ? 0 : delay, ...args);\\n" + loaded.source };
          return loaded;
        }
      `,
        );
        const { stdout } = await promisify(execFile)(
          process.execPath,
          ["--loader", loader, join(repoRoot, "agent_tests/test_matrix_outage/run.mjs"), environmentPath],
          {
            env: { ...process.env, E2E_LIVE_LOCK_HELD: "1" },
            timeout: 4000,
          },
        );
        assert.match(stdout, /outage-test-passed/u);
        const calls = JSON.parse(await readFile(observationsPath, "utf8"));
        assert.equal(calls.length, 3);
        assert.equal(new Set(calls.map((call) => call.prompt)).size, 3);
      },
    );
  }
}
