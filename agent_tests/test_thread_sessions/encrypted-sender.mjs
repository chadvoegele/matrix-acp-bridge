#!/usr/bin/env node
import { runSenderHarness } from "../e2e-support/encrypted-sender.mjs";
import { readEnvironment, readToken, createAdapter } from "./encrypted-lib.mjs";

await runSenderHarness({ readEnvironment, readToken, createAdapter, threadMode: true });

// The SDK may retain idle handles. Exit only after assertions and cleanup.
process.exit(0);
