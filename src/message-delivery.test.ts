import assert from "node:assert/strict";
import test from "node:test";

import type { MessageDelivery } from "./config.js";
import { selectMessageDelivery, type MessageDeliverySelection } from "./message-delivery.js";

const DEFAULT_DELIVERIES: readonly MessageDelivery[] = ["prompt", "steer"];

void test("unprefixed messages and unrelated slash commands use the default with their text intact", () => {
  const bodies = [
    "ordinary message",
    "  preserve leading and trailing spaces  ",
    "first line\n  indented second line\n",
    "☃ café\n\t世界  ",
    "/steering all",
    "/prompted text",
    "/steer-now text",
    "/prompt/text",
    "/steer: text",
    "/PROMPT text",
    "/STEER text",
    " /prompt text",
    "\t/steer text",
    "//steer text",
    "/unknown /steer text",
    "text\n/steer correction",
    "/reset ",
    " /reset",
    "/reset argument",
    "/reset\n",
    "//reset",
  ];
  for (const defaultDelivery of DEFAULT_DELIVERIES) {
    for (const body of bodies) {
      assert.deepEqual(selectMessageDelivery(body, defaultDelivery), { kind: defaultDelivery, payload: body });
    }
  }
});

void test("delivery commands override either default and strip only the prefix and separating whitespace", () => {
  const cases: ReadonlyArray<readonly [string, MessageDeliverySelection]> = [
    ["/prompt message", { kind: "prompt", payload: "message" }],
    ["/steer correction", { kind: "steer", payload: "correction" }],
    ["/prompt   preserve trailing spaces  ", { kind: "prompt", payload: "preserve trailing spaces  " }],
    ["/steer\t\r\n  first\n  second\n", { kind: "steer", payload: "first\n  second\n" }],
    ["/prompt\n\nfirst\n\nsecond\r\n", { kind: "prompt", payload: "first\n\nsecond\r\n" }],
    ["/steer\u00A0\u2028☃ café  ", { kind: "steer", payload: "☃ café  " }],
    ["/prompt /reset", { kind: "prompt", payload: "/reset" }],
    ["/steer /reset", { kind: "steer", payload: "/reset" }],
    ["/prompt /steer literal", { kind: "prompt", payload: "/steer literal" }],
    ["/steer /prompt literal", { kind: "steer", payload: "/prompt literal" }],
    ["/prompt /prompt", { kind: "prompt", payload: "/prompt" }],
    ["/steer /steer", { kind: "steer", payload: "/steer" }],
  ];
  for (const defaultDelivery of DEFAULT_DELIVERIES) {
    for (const [body, expected] of cases) {
      assert.deepEqual(selectMessageDelivery(body, defaultDelivery), expected);
    }
  }
});

void test("bare delivery commands and whitespace-only payloads select usage without agent input", () => {
  for (const defaultDelivery of DEFAULT_DELIVERIES) {
    for (const delivery of DEFAULT_DELIVERIES) {
      for (const separator of ["", " ", "   ", "\t", "\n", "\r\n", "\t \r\n  ", "\u00A0\u2028"]) {
        assert.deepEqual(selectMessageDelivery(`/${delivery}${separator}`, defaultDelivery), {
          kind: "usage",
          delivery,
          message: `Usage: /${delivery} <message>`,
        });
      }
    }
  }
});

void test("exact reset remains a control command regardless of the configured delivery", () => {
  for (const defaultDelivery of DEFAULT_DELIVERIES) {
    assert.deepEqual(selectMessageDelivery("/reset", defaultDelivery), { kind: "reset" });
  }
});
