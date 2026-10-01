import assert from "node:assert/strict";
import test from "node:test";

import { packMarkdownText } from "./markdown-packing.js";
import { matrixHtmlContentBytes } from "./matrix-message-content.js";
import { renderMatrixText } from "./matrix-text-rendering.js";

const textBytes = (body: string): number => Buffer.byteLength(body);

void test("greedy packing keeps fitting blocks intact and measures the prefixed message", () => {
  const text = "one\n\ntwo\n\nthree\n\nfour";
  const parts = packMarkdownText(text, 13, textBytes, (index) => `[${index + 1}]\n`);
  assert.deepEqual(parts, ["[1]\none\n\n", "[2]\ntwo\n\n", "[3]\nthree\n\n", "[4]\nfour"]);
  assert.equal(parts.map((body) => body.replace(/^\[\d+\]\n/u, "")).join(""), text);
  assert.ok(parts.every((body) => Buffer.byteLength(body) <= 13));
});

void test("oversized indivisible units degrade to Unicode-safe source-preserving chunks", () => {
  const text = "`" + "👩‍💻".repeat(20) + "`";
  const parts = packMarkdownText(text, 16, (body) => Buffer.byteLength(body));
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((body) => Buffer.byteLength(body) <= 16));
  assert.doesNotMatch(parts.join(""), /�/u);
  assert.throws(() => packMarkdownText("😀", 3, (body) => Buffer.byteLength(body)), /cannot fit/u);
});

void test("oversized words use batched fallback rather than rendering every growing grapheme prefix", () => {
  const text = "x".repeat(65_536);
  let measurements = 0;
  const parts = packMarkdownText(text, 32_768, (body) => {
    measurements++;
    return 100 + 2 * Buffer.byteLength(body);
  });
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((body) => 100 + 2 * Buffer.byteLength(body) <= 32_768));
  assert.ok(measurements < 100, `expected batched measurements, got ${measurements}`);
});

void test("packing tests completed links rather than assuming rendered prefix sizes are monotonic", () => {
  const link = "[" + "a".repeat(378) + "](https://example.org)";
  const text = link + " " + "z".repeat(3000);
  const routing = { threadRootEventId: "$root", threadInReplyToEventId: "$reply" };
  const measure = (body: string): number => matrixHtmlContentBytes({ ...renderMatrixText(body), ...routing });
  const parts = packMarkdownText(text, 1043, measure, (index) => `[${index + 1}/9]\n`);
  assert.equal(parts[0], `[1/9]\n${link}`);
  assert.ok(parts.every((body) => measure(body) <= 1043));
  assert.equal(parts.map((body) => body.replace(/^\[\d+\/9\]\n/u, "")).join(""), text);
});
