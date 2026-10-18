import assert from "node:assert/strict";
import test from "node:test";
import { TextCollector, type TextSnapshot } from "./text-collector.js";
import { FakeClock } from "./test-support/fake-clock.js";

for (const kind of ["message", "thought"]) {
  void test(`${kind} collector shares cumulative byte/quiet/maximum scheduling, scoped flush and finish`, () => {
    const clock = new FakeClock();
    const records: { id: string; content?: TextSnapshot }[] = [];
    const collector = new TextCollector({
      settings: { agentTextFlushBytes: 256, agentTextQuietMs: 100, agentTextMaxIntervalMs: 250 },
      maxOutputBytes: 4096,
      clock,
      sink: { flush: (id, content) => records.push({ id, content }), finish: (id) => records.push({ id }) },
    });
    collector.append("a", "é".repeat(128));
    assert.equal(records.length, 1);
    collector.append("a", "x".repeat(256));
    clock.advanceBy(99);
    assert.equal(records.length, 1);
    clock.advanceBy(1);
    assert.equal(records.length, 2);
    collector.append("a", "\n\n");
    clock.advanceBy(80);
    collector.append("a", "1");
    clock.advanceBy(80);
    collector.append("a", "2");
    clock.advanceBy(80);
    collector.append("a", "3");
    clock.advanceBy(10);
    assert.equal(records.at(-1)?.content?.text, "é".repeat(128) + "x".repeat(256) + "\n\n123");
    collector.append("a", "z");
    collector.flush("other");
    assert.equal(collector.hasPendingText, true);
    collector.finish("other");
    collector.finish("a");
    assert.equal(records.at(-2)?.content?.text.endsWith("z"), true);
    assert.deepEqual(records.at(-1), { id: "a" });
    assert.equal(clock.pendingTimerCount, 0);
    collector.append("b", "repeat");
    collector.append("b", "repeat");
    collector.append("c", "next");
    assert.equal(records.at(-2)?.content?.text, "repeatrepeat");
    assert.deepEqual(records.at(-1), { id: "b" });
    clock.advanceBy(100);
    assert.equal(records.at(-1)?.content?.text, "next");
    collector.append("c", "abandoned");
    collector.stop();
    clock.advanceBy(1000);
    assert.equal(clock.pendingTimerCount, 0);
    assert.equal(collector.append("d", "late"), false);
    assert.equal(records.at(-1)?.content?.text, "next");
  });
}
