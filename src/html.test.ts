import assert from "node:assert/strict";
import test from "node:test";

import { escapeHtml } from "./html.js";

void test("HTML escaping covers markup characters and preserves newlines", () => {
  assert.equal(escapeHtml(`&<>"'\n😀`), "&amp;&lt;&gt;&quot;&#39;\n😀");
  assert.equal(escapeHtml("&lt;"), "&amp;lt;");
  assert.equal(escapeHtml(""), "");
});
