#!/usr/bin/env node
import { runActivityHarness } from "../e2e-support/encrypted-activity-wire.mjs";
import { readEnvironment, readToken, createAdapter } from "./lib.mjs";

await runActivityHarness({ readEnvironment, readToken, createAdapter });

// The SDK may retain idle handles. Exit only after assertions and cleanup.
process.exit(0);
