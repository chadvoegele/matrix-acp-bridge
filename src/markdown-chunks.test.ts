import assert from "node:assert/strict";
import test from "node:test";

import { markdownChunks, refineMarkdownChunk as splitMarkdownChunk } from "./markdown-chunks.js";

void test("extracts complete top-level blocks with original spacing", () => {
  const blocks = [
    "\n# Heading\n\n",
    "Paragraph with **bold**.\nContinuation.\n\n",
    "```ts\nconst x = `hello`;\n\nconsole.log(x);\n```\n\n",
    "- first\n  - nested\n\n- second\n\n",
    "> quote\n> continued\n\n",
    "last\n",
  ];
  assert.deepEqual(markdownChunks(blocks.join("")), blocks);
});

void test("block maps use original CRLF, lone CR and NUL source offsets", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const blocks = [`  ${newline}one\0${newline}${newline}`, `two😀${newline}`];
    assert.deepEqual(markdownChunks(blocks.join("")), blocks);
  }
});

void test("lists, tables, indented code and reference definitions are blocks", () => {
  const blocks = [
    "1. first\n2. second\n\n",
    "a | b\n--- | ---\nc | d\n\n",
    "    code\n    more\n\n",
    '[ref]: https://example.org "Title"\n\n',
    "[reference][ref] and [ref].\n",
  ];
  assert.deepEqual(markdownChunks(blocks.join("")), blocks);
});

void test("refines a long paragraph without swallowing words after a link", () => {
  const prefix = "word ".repeat(100);
  const link = "[a [nested] label](https://example.org/path_(part))";
  const text = `${prefix}${link} trailing words\n`;
  const units = splitMarkdownChunk(text);
  assert.equal(units.join(""), text);
  assert.deepEqual(units.slice(200), [link, " ", "trailing", " ", "words", "\n"]);
  assert.equal(units.length, 206);
});

void test("keeps links, images and reference forms intact when refining", () => {
  const constructs = [
    "[label with spaces](https://example.org/a_(b))",
    '![alt [nested] text](<https://example.org/a)b> "a ) title")',
    String.raw`[escaped \] bracket](https://example.org/a\(b\))`,
    "[reference label][reference id]",
    "[collapsed label][]",
    "[shortcut label]",
    "[label](url 'title with ) parentheses')",
  ];
  for (const construct of constructs) {
    assert.deepEqual(splitMarkdownChunk(`before ${construct} after`), ["before", " ", construct, " ", "after"]);
  }
});

void test("keeps code spans, simple emphasis and strike intact when feasible", () => {
  const constructs = [
    "`code with spaces`",
    "`` code ` with spaces ``",
    "*emphasis with spaces*",
    "_emphasis with spaces_",
    "**bold with _nested emphasis_**",
    "***bold and emphasis***",
    "~~strike with spaces~~",
    "**bold `code ** inside` text**",
  ];
  for (const construct of constructs) {
    assert.deepEqual(splitMarkdownChunk(`before ${construct} after`), ["before", " ", construct, " ", "after"]);
  }
});

void test("constructs remain separate from adjacent text without whitespace", () => {
  assert.deepEqual(splitMarkdownChunk("before[link](https://example.org)after`code`end"), [
    "before",
    "[link](https://example.org)",
    "after",
    "`code`",
    "end",
  ]);
});

void test("retains whitespace and escaped spaces exactly", () => {
  const text = "  first\t\r\nsecond\\ word  third\n";
  assert.deepEqual(splitMarkdownChunk(text), ["  ", "first", "\t\r\n", String.raw`second\ word`, "  ", "third", "\n"]);
});

void test("indivisible constructs stay whole for the packer's Unicode-safe fallback", () => {
  for (const text of ["😀漢字🚀", "[😀 label](url)", "`😀 code`", "**😀 bold**", "```\n😀 code\n```", " "]) {
    const units = splitMarkdownChunk(text);
    assert.deepEqual(units, [text]);
    assert.equal(units.join(""), text);
  }
  assert.deepEqual(splitMarkdownChunk("[a b](url)  "), ["[a b](url)", "  "]);
  assert.deepEqual(splitMarkdownChunk("😀"), ["😀"]);
});

void test("empty, whitespace-only and malformed Markdown always reconstruct exactly", () => {
  assert.deepEqual(markdownChunks(""), []);
  assert.deepEqual(splitMarkdownChunk(""), []);
  const samples = [
    " \r\n\t",
    "[unclosed label words",
    "`unclosed code words",
    "**unclosed words",
    "a\\",
    "[x](unclosed words",
    "😀\0\r\ntext",
  ];
  for (const text of samples) {
    assert.equal(markdownChunks(text).join(""), text);
    assert.equal(splitMarkdownChunk(text).join(""), text);
  }
});

void test("large unmatched and partially matched brackets reconstruct without repeated suffix scans", () => {
  for (const text of ["[".repeat(65_536), "[".repeat(32_768) + "]".repeat(16_384)]) {
    assert.equal(splitMarkdownChunk(text).join(""), text);
  }
});

void test("block and inline refinement preserve arbitrary source", () => {
  const alphabet = ["a", " ", "\n", "\r", "😀", "[", "]", "(", ")", "*", "_", "~", "`", "\\", "!", "\0"];
  let seed = 12_345;
  for (let sample = 0; sample < 100; sample++) {
    let text = "";
    for (let index = 0; index < 80; index++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      text += alphabet[seed % alphabet.length];
    }
    const blocks = markdownChunks(text);
    assert.equal(blocks.join(""), text);
    assert.equal(blocks.flatMap((block) => splitMarkdownChunk(block)).join(""), text);
  }
});
