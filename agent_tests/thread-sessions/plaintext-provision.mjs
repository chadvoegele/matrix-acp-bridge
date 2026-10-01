#!/usr/bin/env node
import { provisionHarness } from "../e2e-support/plaintext-provision.mjs";
import { defaultEnvironmentPath, makeConfig, testDir } from "./plaintext-lib.mjs";

await provisionHarness({
  defaultEnvironmentPath,
  makeConfig,
  testDir,
  privateRootSuffix: "private/plaintext",
  environmentVariable: "THREAD_PLAINTEXT_ENVIRONMENT_FILE",
  privateRootVariable: "THREAD_PLAINTEXT_PRIVATE_ROOT",
});
