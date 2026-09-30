import assert from "node:assert/strict";
import test from "node:test";

import { escapeHtml } from "./html.js";
import { matrixHtml } from "./matrix-client.js";

void test("HTML escaping covers markup characters and preserves newlines", () => {
  assert.equal(escapeHtml(`&<>"'\n😀`), "&amp;&lt;&gt;&quot;&#39;\n😀");
  assert.equal(escapeHtml("&lt;"), "&amp;lt;");
  assert.equal(escapeHtml(""), "");
});

void test("Matrix HTML templates escape values but preserve static markup", () => {
  assert.equal(matrixHtml`<p>${`&<>"'\n😀`} ${42}</p>`, "<p>&amp;&lt;&gt;&quot;&#39;\n😀 42</p>");
});
