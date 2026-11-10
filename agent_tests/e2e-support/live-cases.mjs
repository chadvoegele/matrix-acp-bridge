import { join } from "node:path";
import { repoRoot } from "./common.mjs";
import { overflowCases } from "../test_outbound_overflow/cases.mjs";

export function listLiveCases() {
  const cases = [{ name: "fresh-crypto-setup", transport: "encrypted", mode: "room", fresh: true }];
  for (const transport of ["plaintext", "encrypted"]) {
    for (const mode of ["room", "thread"]) {
      const prefix =
        mode === "thread"
          ? "test_thread_sessions"
          : transport === "plaintext"
            ? "test_unencrypted_message"
            : "test_encrypted_message";
      const normal = mode === "thread" ? `${transport}-run.mjs` : "run.mjs";
      const activity = mode === "thread" ? `${transport}-activity-wire.mjs` : "activity-wire.mjs";
      cases.push(
        { name: `${transport}-${mode}-normal`, transport, mode, prefix, runner: normal },
        {
          name: `${transport}-${mode}-activity`,
          transport,
          mode,
          prefix,
          runner: activity,
          scriptedPeer: "agent_tests/e2e-support/scripted-activity-acp.mjs",
        },
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
      prefix: "test_unencrypted_message",
      runner,
    });
  cases.push(
    {
      name: "plaintext-room-startup",
      transport: "plaintext",
      mode: "room",
      prefix: "test_unencrypted_message",
      startup: true,
    },
    ...overflowCases,
  );
  cases.sort((first, second) => rank(first) - rank(second));
  return cases;
}

export function selectLiveCases(names) {
  const cases = listLiveCases();
  for (const name of names)
    if (!cases.some((scenario) => scenario.name === name)) throw new Error(`Unknown live case: ${name}; use --list`);
  return cases.filter((scenario) => (names.length === 0 ? !scenario.selectionOnly : names.includes(scenario.name)));
}

export function configureLiveCase(scenario, settings, directory) {
  if (scenario.scriptedPeer)
    settings.E2E_ACP_COMMAND = JSON.stringify([process.execPath, join(repoRoot, scenario.scriptedPeer)]);
  if (!scenario.selectionOnly) return;
  if (settings.E2E_AUTH_MODE === "cache" && (!settings.E2E_CACHE_PROFILE || settings.E2E_CACHE_PROFILE === "default"))
    throw new Error("SETUP BLOCKED: overflow requires an explicit isolated scripted cache profile");
  settings.E2E_OVERFLOW_REPORT = join(directory, "overflow.json");
}

export function recoveryCommand(scenario, environment, settings) {
  return scenario.selectionOnly ? environment.acpCommand : JSON.parse(settings.E2E_ACP_COMMAND);
}

function rank(scenario) {
  if (scenario.fresh) return -1;
  if (scenario.name === "plaintext-room-real-activity") return 4;
  if (scenario.transport === "plaintext") return scenario.mode === "room" ? 0 : 1;
  return scenario.mode === "room" ? 2 : 3;
}
