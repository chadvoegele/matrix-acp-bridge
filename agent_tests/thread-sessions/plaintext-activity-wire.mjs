#!/usr/bin/env node
import { runActivityHarness } from "../e2e-support/plaintext-activity-wire.mjs";
import { readEnvironment, readToken } from "./plaintext-lib.mjs";

await runActivityHarness({ readEnvironment, readToken, threadMode: true });
