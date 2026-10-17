import assert from "node:assert/strict";
import test from "node:test";
import { ConversationPublication } from "./conversation-publication.js";
import { MatrixOutputSender, type MatrixOutputPublication } from "./matrix-output-sender.js";

function part(body: string) {
  return { body, formattedBody: `<p>${body}</p>` };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

void test("equal IDs on subscriptions are isolated; finish waits for in-flight original and final edits", async () => {
  const calls: MatrixOutputPublication[] = [];
  const blocked = gate();
  const started = gate();
  const queue = new ConversationPublication(10, () => assert.fail("publication failed"));
  const publish = async (publication: MatrixOutputPublication) => {
    calls.push(publication);
    if (calls.length === 1) {
      started.release();
      await blocked.promise;
    }
    return publication.targetEventId ?? `$event-${calls.length}`;
  };
  const first = new MatrixOutputSender({ queue, maxMatrixMessageBytes: 4096, publish });
  const second = new MatrixOutputSender({ queue, maxMatrixMessageBytes: 4096, publish });
  first.flush("same", [{ body: "one", formattedBody: "<p>one</p>" }]);
  await started.promise;
  second.flush("same", [{ body: "separate", formattedBody: "<p>separate</p>" }]);
  first.flush("same", [{ body: "final", formattedBody: "<p>final</p>" }]);
  first.finish("same");
  assert.equal(first.liveCount, 1);
  assert.throws(() => first.flush("same", [{ body: "late", formattedBody: "<p>late</p>" }]), /finished/u);
  blocked.release();
  await queue.waitForIdle();
  assert.deepEqual(
    calls.map((call) => [call.body, call.targetEventId]),
    [
      ["one", undefined],
      ["separate", undefined],
      ["final", "$event-1"],
    ],
  );
  assert.equal(first.liveCount, 0);
  assert.equal(second.liveCount, 1);
  second.finish("same");
  await queue.waitForIdle();
  assert.equal(second.liveCount, 0);
});

void test("older IDs stay live; continuation growth/shrinkage reuses originals and clears surplus parts", async () => {
  const calls: MatrixOutputPublication[] = [];
  const queue = new ConversationPublication(10, () => assert.fail("publication failed"));
  const sender = new MatrixOutputSender({
    queue,
    maxMatrixMessageBytes: 4096,
    publish: async (publication) => {
      calls.push(publication);
      return `$event-${calls.length}`;
    },
  });
  sender.flush("old", [part("one"), part("two")]);
  await queue.waitForIdle();
  sender.flush("new", [part("new")]);
  await queue.waitForIdle();
  sender.flush("old", [part("final")]);
  sender.finish("old");
  await queue.waitForIdle();
  assert.deepEqual(
    calls.slice(3).map((call) => [call.body, call.targetEventId]),
    [
      ["final", "$event-1"],
      ["", "$event-2"],
    ],
  );
  assert.equal(sender.liveCount, 1);
  sender.flush("new", [part("new")]);
  await queue.waitForIdle();
  assert.equal(calls.length, 5);
  queue.stop();
  assert.equal(sender.liveCount, 0);
});

void test("required first flush survives pending coalescing and finish without an empty original", async () => {
  const queue = new ConversationPublication(10, () => assert.fail("publication failed"));
  const blocked = gate();
  queue.enqueue({}, () => blocked.promise);
  const calls: MatrixOutputPublication[] = [];
  const sender = new MatrixOutputSender({
    queue,
    maxMatrixMessageBytes: 4096,
    preserveFirstFlush: true,
    publish: async (publication) => {
      calls.push(publication);
      return publication.targetEventId ?? "$original";
    },
  });
  sender.flush("card", [{ body: "expanded", formattedBody: "<p>expanded</p>" }]);
  sender.flush("card", [{ body: "collapsed", formattedBody: "<details>collapsed</details>" }]);
  sender.finish("card");
  sender.finish("empty");
  blocked.release();
  await queue.waitForIdle();
  assert.deepEqual(
    calls.map((call) => [call.body, call.targetEventId]),
    [
      ["expanded", undefined],
      ["collapsed", "$original"],
    ],
  );
  assert.equal(sender.liveCount, 0);
});

void test("failure and capacity discard mappings and prevent in-flight callbacks repopulating them", async () => {
  for (const failure of ["delivery", "capacity"]) {
    const failures: string[] = [];
    const queue = new ConversationPublication(1, (reason) => failures.push(reason));
    const blocked = gate();
    const sender = new MatrixOutputSender({
      queue,
      maxMatrixMessageBytes: 4096,
      publish: async (): Promise<undefined> => {
        await blocked.promise;
        return;
      },
    });
    sender.flush("a", [{ body: "a", formattedBody: "<p>a</p>" }]);
    await Promise.resolve();
    if (failure === "capacity") {
      sender.flush("b", [{ body: "b", formattedBody: "<p>b</p>" }]);
      sender.flush("c", [{ body: "c", formattedBody: "<p>c</p>" }]);
    }
    blocked.release();
    await queue.waitForIdle();
    assert.deepEqual(failures, [failure]);
    assert.equal(sender.liveCount, 0);
  }
});

void test("finish during an in-flight edit retains mappings and later identities until delivery completes", async () => {
  const queue = new ConversationPublication(10, () => assert.fail("publication failed"));
  const blocked = gate();
  const started = gate();
  const calls: MatrixOutputPublication[] = [];
  const sender = new MatrixOutputSender({
    queue,
    maxMatrixMessageBytes: 4096,
    publish: async (publication) => {
      calls.push(publication);
      if (calls.length === 2) {
        started.release();
        await blocked.promise;
      }
      return `$event-${calls.length}`;
    },
  });
  sender.flush("a", [part("initial")]);
  await queue.waitForIdle();
  sender.flush("a", [part("edit")]);
  await started.promise;
  sender.flush("a", [part("final")]);
  sender.finish("a");
  sender.flush("b", [part("next")]);
  assert.equal(sender.liveCount, 2);
  blocked.release();
  await queue.waitForIdle();
  assert.deepEqual(
    calls.map((call) => [call.body, call.targetEventId]),
    [
      ["initial", undefined],
      ["edit", "$event-1"],
      ["final", "$event-1"],
      ["next", undefined],
    ],
  );
  assert.equal(sender.liveCount, 1);
  sender.finish("b");
  await queue.waitForIdle();
  assert.equal(sender.liveCount, 0);
});

void test("sequential explicit finishes retain no historical sender mappings", async () => {
  const queue = new ConversationPublication(2, () => assert.fail("publication failed"));
  const sender = new MatrixOutputSender({ queue, maxMatrixMessageBytes: 4096, publish: async () => "$original" });
  for (let index = 0; index < 100; index++) {
    sender.flush(String(index), [part("text")]);
    sender.finish(String(index));
    assert.equal(sender.liveCount, 1);
    await queue.waitForIdle();
    assert.equal(sender.liveCount, 0);
  }
});
