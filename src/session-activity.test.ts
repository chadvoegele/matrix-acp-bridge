import assert from "node:assert/strict";
import test from "node:test";

import { SessionActivity } from "./session-activity.js";
import { ConversationPublication } from "./conversation-publication.js";
import { matrixHtmlEditContentBytes } from "./matrix-message-content.js";

const immediate = () => Promise.resolve();

function fixture(maxRetainedEvents = 20) {
  const publications: { body: string; formattedBody: string; targetEventId?: string }[] = [];
  const failures: string[] = [];
  const queue = new ConversationPublication(20, (reason) => failures.push(reason));
  let send: () => Promise<void> = immediate;
  const activity = new SessionActivity({
    queue,
    limits: { maxEvents: 2, maxMessageBytes: 4096, measure: matrixHtmlEditContentBytes },
    maxRetainedEvents,
    onAbandoned: (reason) => failures.push(reason),
    publish: async (rendered, targetEventId) => {
      await send();
      publications.push({ ...rendered, ...(targetEventId === undefined ? {} : { targetEventId }) });
      return targetEventId ?? `$event-${publications.length}`;
    },
  });
  const tool = (toolCallId: string) =>
    activity.accept({ sessionId: "session", kind: "tool_call", toolCallId, title: toolCallId, status: "in_progress" });
  const terminal = (toolCallId: string, status = "completed") =>
    activity.accept({ sessionId: "session", kind: "tool_call_update", toolCallId, status });
  const text = () =>
    activity.accept({ sessionId: "session", kind: "agent_message_chunk", messageId: "answer", text: "answer" });
  return {
    activity,
    queue,
    publications,
    failures,
    tool,
    terminal,
    text,
    setSend: (value: typeof send) => (send = value),
  };
}

void test("parallel tools retain independent batches until terminal edits and collapse finish", async () => {
  const f = fixture();
  f.tool("first");
  f.text();
  f.tool("second");
  f.text();
  await f.queue.waitForIdle();
  assert.equal(f.activity.retainedBatches, 2);
  f.terminal("second", "failed");
  await f.queue.waitForIdle();
  assert.equal(f.activity.retainedBatches, 1);
  assert.equal(f.activity.retainedEvents, 1);
  f.terminal("first");
  await f.queue.waitForIdle();
  assert.equal(f.activity.retainedBatches, 0);
  assert.equal(f.activity.retainedEvents, 0);
  assert.ok(
    f.publications.some(
      (entry) => entry.body.includes("first") && entry.body.includes("completed") && entry.targetEventId,
    ),
  );
  assert.ok(
    f.publications.some(
      (entry) => entry.body.includes("second") && entry.body.includes("failed") && entry.targetEventId,
    ),
  );
  const count = f.publications.length;
  f.terminal("first", "failed");
  await f.queue.waitForIdle();
  assert.equal(f.publications.length, count);
});

void test("completed current batch stays bounded until its presentation closes", async () => {
  const f = fixture();
  f.tool("tool");
  f.terminal("tool");
  await f.queue.waitForIdle();
  assert.equal(f.activity.retainedEvents, 1);
  assert.doesNotMatch(f.publications[0]!.formattedBody, /Past agent events/);
  f.text();
  await f.queue.waitForIdle();
  assert.equal(f.activity.retainedEvents, 0);
  assert.match(f.publications.at(-1)!.formattedBody, /Past agent events/);
});

void test("slow terminal publication retains state through the final collapse edit", async () => {
  const f = fixture();
  f.tool("tool");
  await f.queue.waitForIdle();
  let release!: () => void;
  f.setSend(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  f.terminal("tool");
  await Promise.resolve();
  f.text();
  assert.equal(f.activity.retainedEvents, 1);
  f.setSend(() => Promise.resolve());
  release();
  await f.queue.waitForIdle();
  assert.equal(f.activity.retainedEvents, 0);
  assert.match(f.publications.at(-1)!.formattedBody, /Past agent events/);
});

void test("sequential closed batches release source and event mappings without history growth", async () => {
  const f = fixture();
  for (let index = 0; index < 100; index += 1) {
    f.tool(`tool-${index}`);
    f.terminal(`tool-${index}`);
    f.text();
    await f.queue.waitForIdle();
    assert.equal(f.activity.retainedEvents, 0);
    assert.equal(f.activity.retainedBatches, 0);
  }
  assert.equal(f.failures.length, 0);
});

void test("unbounded parallel intake fails explicitly and releases incomplete activity", async () => {
  const f = fixture(2);
  f.tool("first");
  f.tool("second");
  f.tool("third");
  await f.queue.waitForIdle();
  assert.ok(f.failures.includes("capacity"));
  assert.ok(f.failures.includes("lifecycle"));
  assert.equal(f.queue.stopped, true);
  assert.equal(f.activity.retainedEvents, 0);
  assert.equal(f.activity.retainedBatches, 0);
});

void test("transport failure and lifecycle stop release incomplete tools without success edits", async () => {
  for (const failure of [false, true]) {
    const f = fixture();
    f.tool("tool");
    await f.queue.waitForIdle();
    if (failure) {
      f.setSend(() => Promise.reject(new Error("private error")));
      f.text();
      await f.queue.waitForIdle();
      assert.ok(f.failures.includes("delivery"));
    } else f.queue.stop();
    assert.ok(f.failures.includes("lifecycle"));
    assert.equal(f.activity.retainedEvents, 0);
    assert.equal(f.activity.retainedBatches, 0);
    f.terminal("tool");
    await f.queue.waitForIdle();
    assert.equal(f.publications.length, 1);
    assert.doesNotMatch(f.publications[0]!.body, /completed/);
  }
});
