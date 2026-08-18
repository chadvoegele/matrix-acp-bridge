#!/usr/bin/env node
import { cleanupEnvironment } from "../e2e-support/cleanup.mjs";
import { defaultEnvironmentPath, readEnvironment } from "./lib.mjs";

const environmentPath = process.argv[2] ?? defaultEnvironmentPath;
const environment = await readEnvironment(environmentPath);
await cleanupEnvironment(environmentPath, environment, {
  roles: ["bridge", "helper", "sender"],
  clientName: "matrix-acp-e2e-cleanup",
});
