#!/usr/bin/env node
import { runSenderHarness } from "../e2e-support/plaintext-sender.mjs";
import { readEnvironment, readToken } from "./plaintext-lib.mjs";

await runSenderHarness({ readEnvironment, readToken, threadMode: true });
