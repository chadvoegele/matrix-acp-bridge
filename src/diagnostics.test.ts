import assert from "node:assert/strict";
import test from "node:test";

import { RateLimitedDiagnosticSink, StderrDiagnosticSink } from "./diagnostics.js";
import { FakeClock } from "./test-support/fake-clock.js";

void test("structured diagnostics are deterministic and use the injected stderr writer", () => {
  const lines: string[] = [];
  const clock = new FakeClock(Date.UTC(2026, 0, 2, 3, 4, 5));
  const diagnostics = new StderrDiagnosticSink({
    clock,
    writeLine: (line) => lines.push(line),
  });

  diagnostics.warn("inbound-rejected", {
    eventId: "$event:example",
    reason: "not-allowed",
    roomId: "!room:example",
  });

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), {
    timestamp: "2026-01-02T03:04:05.000Z",
    level: "warn",
    event: "inbound-rejected",
    fields: {
      eventId: "$event:example",
      reason: "not-allowed",
      roomId: "!room:example",
    },
  });
});

void test("diagnostics expose scalar fields only", () => {
  const lines: string[] = [];
  const diagnostics = new StderrDiagnosticSink({ writeLine: (line) => lines.push(line) });

  diagnostics.info("startup", { rooms: 2, encryption: "disabled" });

  const record = JSON.parse(lines[0]!) as { fields: Record<string, unknown> };
  assert.deepEqual(record.fields, { encryption: "disabled", rooms: 2 });
});

void test("rate-limits independently by room and reason and reports suppression", () => {
  const lines: string[] = [];
  const clock = new FakeClock();
  const delegate = new StderrDiagnosticSink({
    clock,
    writeLine: (line) => lines.push(line),
  });
  const diagnostics = new RateLimitedDiagnosticSink(delegate, { clock });
  const firstKey = { roomId: "!one:example.org", reason: "invalid-content" };

  for (let index = 0; index < 6; index += 1) {
    diagnostics.warn("inbound-rejected", firstKey);
  }
  diagnostics.warn("inbound-rejected", {
    roomId: "!two:example.org",
    reason: "invalid-content",
  });
  diagnostics.warn("inbound-rejected", {
    roomId: "!one:example.org",
    reason: "invalid-relation",
  });

  assert.equal(lines.length, 7);
  clock.advanceBy(60_000);
  diagnostics.warn("inbound-rejected", firstKey);
  assert.equal(lines.length, 8);
  const record = JSON.parse(lines[7]!) as { fields: Record<string, unknown> };
  assert.equal(record.fields.suppressedCount, 1);
});
