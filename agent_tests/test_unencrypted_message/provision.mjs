#!/usr/bin/env node
import { provisionHarness } from "../e2e-support/plaintext-provision.mjs";
import { defaultEnvironmentPath, makeConfig, testDir } from "./lib.mjs";

await provisionHarness({
  defaultEnvironmentPath,
  makeConfig,
  testDir,
  environmentVariable: "UNENCRYPTED_E2E_ENVIRONMENT_FILE",
  privateRootVariable: "UNENCRYPTED_E2E_PRIVATE_ROOT",
});
