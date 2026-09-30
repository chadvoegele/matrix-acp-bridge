import assert from "node:assert/strict";
import test from "node:test";

import { matrixHtmlContentBytes } from "./matrix-message-content.js";
import { renderMatrixTextChunk } from "./matrix-text-rendering.js";

void test("live text rendering preserves Markdown and Unicode within the wire budget", () => {
  const body = "**Hello** <world> 😀";
  const chunk = renderMatrixTextChunk([...body], 0, 4096);
  assert.ok(chunk);
  assert.equal(chunk.rendered.body, body);
  assert.match(chunk.rendered.formattedBody, /<strong>Hello<\/strong>/);
  assert.match(chunk.rendered.formattedBody, /&lt;world&gt;/);
  assert.equal(chunk.nextOffset, [...body].length);
});

void test("successive live text chunks reconstruct the original without splitting code points", () => {
  const body = "<&😀".repeat(300);
  const characters = [...body];
  let offset = 0;
  let result = "";
  let count = 0;
  while (offset < characters.length) {
    const chunk = renderMatrixTextChunk(characters, offset, 512);
    assert.ok(chunk);
    assert.ok(chunk.nextOffset > offset);
    assert.ok(matrixHtmlContentBytes(chunk.rendered) <= 512);
    assert.doesNotMatch(chunk.rendered.body, /�/u);
    result += chunk.rendered.body;
    offset = chunk.nextOffset;
    count += 1;
  }
  assert.equal(result, body);
  assert.ok(count > 1);
});

void test("live text rendering reports when no character fits", () => {
  assert.equal(renderMatrixTextChunk(["😀"], 0, 1), undefined);
  assert.equal(renderMatrixTextChunk([], 0, 4096), undefined);
});

void test("threaded live chunks budget the root and fallback at exact Unicode boundaries", () => {
  const routing = { threadRootEventId: `$${"r".repeat(254)}`, threadFallbackEventId: "$follow-up" };
  const body = "<&😀".repeat(100);
  const characters = [...body];
  let offset = 0;
  let result = "";
  while (offset < characters.length) {
    const chunk = renderMatrixTextChunk(characters, offset, 700, routing);
    assert.ok(chunk);
    assert.equal(chunk.rendered.threadRootEventId, routing.threadRootEventId);
    assert.equal(chunk.rendered.threadFallbackEventId, routing.threadFallbackEventId);
    assert.ok(matrixHtmlContentBytes(chunk.rendered) <= 700);
    result += chunk.rendered.body;
    offset = chunk.nextOffset;
  }
  assert.equal(result, body);
  const single = renderMatrixTextChunk(["😀"], 0, 4096, routing)!;
  const exact = matrixHtmlContentBytes(single.rendered);
  assert.ok(renderMatrixTextChunk(["😀"], 0, exact, routing));
  assert.equal(renderMatrixTextChunk(["😀"], 0, exact - 1, routing), undefined);
});
