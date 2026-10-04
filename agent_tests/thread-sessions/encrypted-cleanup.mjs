#!/usr/bin/env node
import { join } from "node:path";
import { cleanupEnvironment } from "../e2e-support/cleanup.mjs";
import { defaultEnvironmentPath, readEnvironment } from "./encrypted-lib.mjs";

const environmentPath = process.argv[2] ?? process.env.THREAD_ENCRYPTED_ENVIRONMENT_FILE ?? defaultEnvironmentPath;
const environment = await readEnvironment(environmentPath);
await cleanupEnvironment(environmentPath, environment, {
  roles: ["bridge", "helper", "sender"],
  additionalSessionFiles: [join(environment.bridge.stateDir, "e2e-session-ids.json")],
  clientName: "matrix-acp-thread-encrypted-cleanup",
});
