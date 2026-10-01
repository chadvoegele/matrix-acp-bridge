import assert from "node:assert/strict";
import test from "node:test";

import {
  matrixHtmlContent,
  matrixHtmlContentBytes,
  matrixHtmlEditContentBytes,
  matrixTextContent,
  matrixThreadRelation,
} from "./matrix-message-content.js";

const routing = { threadRootEventId: "$root", threadInReplyToEventId: "$follow-up" };
const message = { body: "<&😀", formattedBody: "<p>&lt;&amp;😀</p>", ...routing };

void test("thread content uses one root and a distinct fallback only for presentation", () => {
  const relation = {
    rel_type: "m.thread",
    event_id: "$root",
    "m.in_reply_to": { event_id: "$follow-up" },
    is_falling_back: true,
  };
  assert.deepEqual(matrixThreadRelation(routing), relation);
  assert.deepEqual(matrixTextContent(message.body, routing), {
    msgtype: "m.text",
    body: message.body,
    "m.relates_to": relation,
  });
  assert.deepEqual(matrixHtmlContent(message)["m.relates_to"], relation);
  assert.deepEqual(matrixThreadRelation({ threadRootEventId: "$root" }), {
    ...relation,
    "m.in_reply_to": { event_id: "$root" },
  });
});

void test("thread edits keep outer replacement and thread metadata in replacement content", () => {
  const content = matrixHtmlContent(message, "$original");
  assert.deepEqual(content["m.relates_to"], { rel_type: "m.replace", event_id: "$original" });
  assert.deepEqual(content["m.new_content"], matrixHtmlContent(message));
  assert.equal(content.body, `* ${message.body}`);
  assert.equal(content.formatted_body, `* ${message.formattedBody}`);
  assert.equal(Object.hasOwn(content["m.relates_to"] as object, "m.in_reply_to"), false);
  assert.equal(matrixHtmlContentBytes(message, "$original"), Buffer.byteLength(JSON.stringify(content)));
  assert.equal(matrixHtmlEditContentBytes(message), matrixHtmlContentBytes(message, `$${"x".repeat(254)}`));
});

void test("room originals and edits keep their established content", () => {
  const plain = { body: "text", formattedBody: "<p>text</p>" };
  const original = { msgtype: "m.text", body: "text", format: "org.matrix.custom.html", formatted_body: "<p>text</p>" };
  assert.deepEqual(matrixTextContent("text"), { msgtype: "m.text", body: "text" });
  assert.deepEqual(matrixHtmlContent(plain), original);
  assert.deepEqual(matrixHtmlContent(plain, "$edit"), {
    ...original,
    body: "* text",
    formatted_body: "* <p>text</p>",
    "m.new_content": original,
    "m.relates_to": { rel_type: "m.replace", event_id: "$edit" },
  });
});

void test("thread routing rejects invalid roots and fallbacks before content construction", () => {
  for (const id of ["", "no-dollar", "$white space", `$${"é".repeat(128)}`]) {
    assert.throws(() => matrixThreadRelation({ threadRootEventId: id }), /valid Matrix event IDs/);
    assert.throws(
      () => matrixThreadRelation({ threadRootEventId: "$root", threadInReplyToEventId: id }),
      /valid Matrix event IDs/,
    );
  }
  assert.throws(() => matrixThreadRelation({ threadInReplyToEventId: "$reply" }), /requires a thread root/);
});
