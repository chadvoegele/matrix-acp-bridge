#!/usr/bin/env node
import { join } from "node:path";

import { cleanupEnvironment } from "../e2e-support/cleanup.mjs";
import { defaultEnvironmentPath, readEnvironment } from "./lib.mjs";

const environmentPath = process.argv[2] ?? defaultEnvironmentPath;
const environment = await readEnvironment(environmentPath);
await cleanupEnvironment(environmentPath, environment, {
  roles: ["bridge", "sender"],
  additionalSessionFiles: [join(environment.bridge.stateDir, "e2e-session-ids.json")],
  removeSharedRoot: true,
  clientName: "matrix-acp-unencrypted-e2e-cleanup",
});
