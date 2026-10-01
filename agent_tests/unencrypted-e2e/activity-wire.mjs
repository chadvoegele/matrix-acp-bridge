#!/usr/bin/env node
import { runActivityHarness } from "../e2e-support/plaintext-activity-wire.mjs";
import { readEnvironment, readToken } from "./lib.mjs";

await runActivityHarness({ readEnvironment, readToken });
