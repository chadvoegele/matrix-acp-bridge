import assert from "node:assert/strict";
import test from "node:test";

import type { AcpThoughtActivity } from "./acp-activity.js";
import { AcpActivityBatches } from "./acp-activity-batches.js";
import { matrixHtmlEditContentBytes } from "./matrix-message-content.js";

function thought(text: string): AcpThoughtActivity {
  return { type: "thought", text, cut: false };
}

function batches(maxEvents = 2): AcpActivityBatches {
  return new AcpActivityBatches({
    maxEvents,
    maxMessageBytes: 4096,
    measure: matrixHtmlEditContentBytes,
  });
}

void test("event limits collapse the previous batch and preserve event order", () => {
  const presentation = batches();
  const first = thought("first");
  const second = thought("second");
  const third = thought("third");
  const [initial] = presentation.accept(first);
  assert.ok(initial);
  assert.equal(initial.index, 0);
  assert.equal(initial.collapsed, false);
  assert.deepEqual(presentation.accept(second), [initial]);
  const changed = presentation.accept(third);
  assert.equal(changed.length, 2);
  assert.equal(changed[0], initial);
  assert.equal(initial.collapsed, true);
  assert.deepEqual(initial.events, [first, second]);
  assert.deepEqual(changed[1]?.events, [third]);
  assert.equal(changed[1]?.index, 1);
  assert.equal(changed[1]?.collapsed, false);
});

void test("text boundaries collapse once and later tool updates retain their original batch", () => {
  const presentation = batches();
  const event = thought("initial");
  const [initial] = presentation.accept(event);
  assert.ok(initial);
  const expanded = presentation.render(initial);
  assert.doesNotMatch(expanded.formattedBody, /Past agent events/);
  assert.deepEqual(presentation.collapse(), [initial]);
  assert.deepEqual(presentation.collapse(), []);
  event.text = "updated <text>";
  assert.deepEqual(presentation.accept(event), [initial]);
  assert.equal(initial.events.length, 1);
  const collapsed = presentation.render(initial);
  assert.match(collapsed.formattedBody, /<details><summary>Past agent events \(1\)<\/summary>/);
  assert.match(collapsed.formattedBody, /updated &lt;text&gt;/);
  const [next] = presentation.accept(thought("next"));
  assert.equal(next?.index, 1);
  assert.equal(next?.collapsed, false);
});

void test("byte costs can split batches independently of event count", () => {
  const presentation = new AcpActivityBatches({
    maxEvents: 10,
    maxMessageBytes: 500,
    measure: (rendered) => (rendered.body.match(/💭/gu) ?? []).length * 300,
  });
  const first = thought("first");
  const second = thought("second");
  const [initial] = presentation.accept(first);
  const changed = presentation.accept(second);
  assert.equal(changed.length, 2);
  assert.equal(changed[0], initial);
  assert.deepEqual(changed[0]?.events, [first]);
  assert.deepEqual(changed[1]?.events, [second]);
});

void test("batch rendering budgets escaped HTML and the collapsed wrapper", () => {
  const presentation = new AcpActivityBatches({
    maxEvents: 10,
    maxMessageBytes: 2048,
    measure: matrixHtmlEditContentBytes,
  });
  const [batch] = presentation.accept(thought("<&😀".repeat(2000)));
  assert.ok(batch);
  assert.ok(matrixHtmlEditContentBytes(presentation.render(batch)) <= 2048);
  presentation.collapse();
  const rendered = presentation.render(batch);
  assert.ok(matrixHtmlEditContentBytes(rendered) <= 2048);
  assert.match(rendered.formattedBody, /&lt;&amp;/);
  assert.doesNotMatch(rendered.body, /�/u);
});
