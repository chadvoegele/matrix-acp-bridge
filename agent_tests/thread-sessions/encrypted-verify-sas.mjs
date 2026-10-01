#!/usr/bin/env node
import { runCommand } from "../e2e-support/common.mjs";
import { defaultEnvironmentPath, repoRoot } from "./encrypted-lib.mjs";

await runCommand(process.execPath, [
  `${repoRoot}/agent_tests/encrypted-e2e/verify-sas.mjs`,
  process.env.THREAD_ENCRYPTED_ENVIRONMENT_FILE ?? defaultEnvironmentPath,
]);
