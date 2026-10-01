#!/usr/bin/env node
import { join } from "node:path";
import { cleanupEnvironment } from "../e2e-support/cleanup.mjs";
import { defaultEnvironmentPath, readEnvironment } from "./plaintext-lib.mjs";

const environmentPath = process.argv[2] ?? process.env.THREAD_PLAINTEXT_ENVIRONMENT_FILE ?? defaultEnvironmentPath;
const environment = await readEnvironment(environmentPath);
await cleanupEnvironment(environmentPath, environment, {
  roles: ["bridge", "sender"],
  additionalSessionFiles: [join(environment.bridge.stateDir, "e2e-session-ids.json")],
  removeSharedRoot: true,
  clientName: "matrix-acp-thread-plaintext-cleanup",
});
