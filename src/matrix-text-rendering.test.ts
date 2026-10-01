import assert from "node:assert/strict";
import test from "node:test";

import { matrixHtmlContentBytes, type MatrixHtmlBody } from "./matrix-message-content.js";
import { renderMatrixText, renderMatrixTextChunk, renderMatrixTextChunks } from "./matrix-text-rendering.js";

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

void test("live greedy packing preserves complete links, code spans and emphasis", () => {
  const routing = { threadRootEventId: "$root", threadFallbackEventId: "$reply" };
  const measure = (rendered: MatrixHtmlBody): number => matrixHtmlContentBytes({ ...rendered, ...routing });
  for (const unit of [
    "[" + "a".repeat(378) + "](https://example.org)",
    "`" + "code ".repeat(40) + "`",
    "**" + "bold ".repeat(40) + "**",
  ]) {
    const body = unit + " " + "tail ".repeat(600);
    const limit = measure(renderMatrixText(unit));
    const chunks = renderMatrixTextChunks(body, limit, measure);
    assert.equal(chunks[0]?.body, unit);
    assert.equal(chunks.map(({ body }) => body).join(""), body);
    assert.ok(chunks.every((chunk) => measure(chunk) <= limit));
  }
});

void test("live chunks share reference definitions and preserve fitting graphemes in oversized words", () => {
  const text = "[Read more][ref]\n\n" + "Other paragraph.\n\n".repeat(50) + "[ref]: https://example.org\n";
  const chunks = renderMatrixTextChunks(text, 512);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0]?.body.includes("[ref]:"), false);
  assert.match(chunks[0].formattedBody, /<a href="https:\/\/example.org">Read more<\/a>/u);
  assert.equal(chunks.map(({ body }) => body).join(""), text);
  assert.ok(chunks.every((chunk) => matrixHtmlContentBytes(chunk) <= 512));

  const grapheme = "👩‍💻";
  const limit = matrixHtmlContentBytes(renderMatrixText(grapheme));
  const emojiChunks = renderMatrixTextChunks(grapheme.repeat(10), limit);
  assert.deepEqual(
    emojiChunks.map(({ body }) => body),
    Array.from({ length: 10 }, () => grapheme),
  );
});

void test("greedy rendering preserves arbitrary Markdown source within every wire limit", () => {
  const alphabet = ["a", " ", "\n", "\r", "😀", "[", "]", "(", ")", "*", "_", "~", "`", "\\", "!", "<", "&", "\0"];
  let seed = 12_345;
  for (let sample = 0; sample < 100; sample++) {
    let body = "";
    for (let index = 0; index < 80; index++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      body += alphabet[seed % alphabet.length];
    }
    const chunks = renderMatrixTextChunks(body, 256);
    assert.equal(chunks.map(({ body }) => body).join(""), body);
    assert.ok(chunks.every((chunk) => matrixHtmlContentBytes(chunk) <= 256));
  }
});

void test("threaded live chunks budget the root and fallback at exact Unicode boundaries", () => {
  const routing = { threadRootEventId: `$${"r".repeat(254)}`, threadFallbackEventId: "$follow-up" };
  const measure = (rendered: MatrixHtmlBody): number => matrixHtmlContentBytes({ ...rendered, ...routing });
  const body = "<&😀".repeat(100);
  const characters = [...body];
  let offset = 0;
  let result = "";
  while (offset < characters.length) {
    const chunk = renderMatrixTextChunk(characters, offset, 700, measure);
    assert.ok(chunk);
    assert.deepEqual(Object.keys(chunk.rendered).sort(), ["body", "formattedBody"]);
    assert.ok(measure(chunk.rendered) <= 700);
    result += chunk.rendered.body;
    offset = chunk.nextOffset;
  }
  assert.equal(result, body);
  const single = renderMatrixTextChunk(["😀"], 0, 4096, measure)!;
  const exact = measure(single.rendered);
  assert.ok(renderMatrixTextChunk(["😀"], 0, exact, measure));
  assert.equal(renderMatrixTextChunk(["😀"], 0, exact - 1, measure), undefined);
});
