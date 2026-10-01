#!/usr/bin/env node
import { provisionHarness } from "../e2e-support/encrypted-provision.mjs";
import { defaultEnvironmentPath, makeConfig, testDir } from "./lib.mjs";

await provisionHarness({
  defaultEnvironmentPath,
  makeConfig,
  testDir,
  environmentVariable: "E2E_ENVIRONMENT_FILE",
  privateRootVariable: "E2E_PRIVATE_ROOT",
});
