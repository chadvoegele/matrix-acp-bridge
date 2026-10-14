#!/usr/bin/env node
import { provisionHarness } from "../e2e-support/encrypted-provision.mjs";
import { defaultEnvironmentPath, makeConfig, testDir } from "./encrypted-lib.mjs";

await provisionHarness({
  defaultEnvironmentPath,
  makeConfig,
  responseMode: "thread",
  testDir,
  privateRootSuffix: "private/encrypted",
  environmentVariable: "THREAD_ENCRYPTED_ENVIRONMENT_FILE",
  privateRootVariable: "THREAD_ENCRYPTED_PRIVATE_ROOT",
});
