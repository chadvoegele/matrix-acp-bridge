#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { readEnvironment, writePrivateFile } from "../e2e-support/common.mjs";
import {
  assertRawSteeringEncryption,
  collectRawRoomWindow,
  rawRoomPageLoader,
} from "../e2e-support/steering-raw-wire.mjs";

// Read-only retrospective audit. Caller must hold the shared live lock and use
// an active owned token. Retained environment tokens are never read or reused.
const [activePath, retainedPath, wirePath, evidencePath, startText, endText] = process.argv.slice(2);
assert.ok(activePath && retainedPath && wirePath && evidencePath && startText && endText);
const active = await readEnvironment(activePath);
const retained = await readEnvironment(retainedPath);
assert.equal(active.homeserver, retained.homeserver);
assert.equal(active.sender.userId, retained.sender.userId);
const wire = JSON.parse(await readFile(wirePath, "utf8"));
const events = [];
const pages = [];
let failure;
let summary;
try {
  const loadPage = rawRoomPageLoader(active, retained.roomId);
  events.push(
    ...(await collectRawRoomWindow(Number(startText), Number(endText), async (...arguments_) => {
      const page = await loadPage(...arguments_);
      pages.push(page);
      return page;
    })),
  );
  assertRawSteeringEncryption(
    events,
    [retained.bridge.userId, retained.sender.userId],
    wire.wireEvents.map((event) => event.eventId),
  );
  summary = { result: "passed", rawEvents: events.length, checkedEvents: wire.wireEvents.length, plaintextEvents: 0 };
} catch (error) {
  failure = {
    name: error.name,
    message: error.message,
    stack: error.stack,
    actual: error.actual,
    expected: error.expected,
  };
  summary = { result: "failed", errorClass: error.name };
  process.exitCode = 1;
} finally {
  await writePrivateFile(
    evidencePath,
    JSON.stringify({ start: Number(startText), end: Number(endText), events, pages, failure, summary }),
  );
}
console.log(JSON.stringify(summary));
