import assert from "node:assert/strict";
import test from "node:test";

import { matrixHtml, type MatrixSafeHtml } from "./matrix-html.js";

void test("Matrix HTML templates escape values but preserve static markup", () => {
  const formattedBody: MatrixSafeHtml = matrixHtml`<p>${`&<>"'\n😀`} ${42}</p>`;
  assert.equal(formattedBody, "<p>&amp;&lt;&gt;&quot;&#39;\n😀 42</p>");
});

void test("Matrix HTML templates preserve static entities and escape dynamic entities", () => {
  assert.equal(matrixHtml`<p>&lt;${"&lt;"}</p>`, "<p>&lt;&amp;lt;</p>");
});

void test("Matrix HTML templates support empty values and adjacent numeric values", () => {
  assert.equal(matrixHtml``, "");
  assert.equal(matrixHtml`<br>`, "<br>");
  assert.equal(matrixHtml`${""}${0}${-42}${""}`, "0-42");
});
