import assert from "node:assert/strict";
import test from "node:test";

import {
  MATRIX_HTML_FORMAT,
  markdownToMatrixHtml,
} from "./matrix-markdown.js";

void test("renders Markdown as Matrix HTML", () => {
  assert.equal(markdownToMatrixHtml("_hi_"), "<p><em>hi</em></p>");
  assert.equal(
    markdownToMatrixHtml("**bold** and `code`"),
    "<p><strong>bold</strong> and <code>code</code></p>",
  );
  assert.equal(
    markdownToMatrixHtml("[Matrix](https://matrix.org)"),
    '<p><a href="https://matrix.org">Matrix</a></p>',
  );
  assert.equal(MATRIX_HTML_FORMAT, "org.matrix.custom.html");
});

void test("keeps raw HTML out of the Matrix formatted body", () => {
  const html = markdownToMatrixHtml("<script>alert(1)</script>");
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("&lt;script&gt;"), true);
});
