import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationPublication,
  type MatrixOutputPublication,
  type PublicationFailure,
} from "./conversation-publication.js";
import { matrixHtmlContentBytes } from "./matrix-message-content.js";
import { matrixHtml } from "./matrix-html.js";

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function createPart(body: string) {
  return { body, formattedBody: matrixHtml`<p>${body}</p>` };
}

function createFixture(maximumPending = 10) {
  const calls: (MatrixOutputPublication & { emitter: string })[] = [];
  const failures: PublicationFailure[] = [];
  let transport: () => Promise<string | undefined> = async () => `$event-${calls.length}`;
  const queue = new ConversationPublication({
    maximumPending,
    maxMatrixMessageBytes: 4096,
    onFailure: (reason) => failures.push(reason),
    publish: (emitter, publication) => {
      calls.push({ emitter, ...publication });
      return transport();
    },
  });
  return {
    queue,
    calls,
    failures,
    setTransport: (value: typeof transport) => {
      transport = value;
    },
  };
}

void test("publication bounds must be positive safe integers", { timeout: 1000 }, () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    for (const field of ["maximumPending", "maxMatrixMessageBytes"]) {
      assert.throws(
        () =>
          new ConversationPublication({
            maximumPending: 1,
            maxMatrixMessageBytes: 4096,
            publish: async () => "$event",
            onFailure: () => {},
            [field]: value,
          }),
        new RegExp(field, "u"),
      );
    }
  }
});

void test("pending content coalesces in place while distinct IDs retain FIFO order", { timeout: 1000 }, async () => {
  const { queue, calls, setTransport } = createFixture(2);
  const gate = createGate();
  setTransport(async () => {
    await gate.promise;
    return "$original";
  });
  queue.messages.flush("blocker", [createPart("blocking")]);
  await Promise.resolve();
  queue.messages.flush("a", [createPart("obsolete")]);
  queue.messages.flush("b", [createPart("last")]);
  queue.messages.flush("a", [createPart("replacement")]);
  assert.equal(queue.pendingCount, 3);
  gate.release();
  await queue.waitForIdle();
  assert.deepEqual(
    calls.map(({ body }) => body),
    ["blocking", "replacement", "last"],
  );
  assert.equal(queue.pendingCount, 0);
  queue.messages.flush("a", [createPart("restarted")]);
  await queue.waitForIdle();
  assert.equal(calls.at(-1)?.targetEventId, "$original");
});

void test(
  "equal IDs on emitters are isolated; finish waits for in-flight original and final edit",
  { timeout: 1000 },
  async () => {
    const { queue, calls, setTransport } = createFixture();
    const blocked = createGate();
    setTransport(async () => {
      if (calls.length === 1) await blocked.promise;
      return `$event-${calls.length}`;
    });
    queue.messages.flush("same", [createPart("one")]);
    await Promise.resolve();
    queue.cards.flush("same", [createPart("separate")]);
    queue.messages.flush("same", [createPart("final")]);
    queue.messages.finish("same");
    assert.equal(queue.liveCount, 2);
    assert.throws(() => queue.messages.flush("same", [createPart("late")]), /finished/u);
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
    assert.equal(queue.liveCount, 1);
    queue.cards.finish("same");
    await queue.waitForIdle();
    assert.equal(queue.liveCount, 0);
  },
);

void test(
  "older cards retain continuation mappings through growth, shrink and regrowth",
  { timeout: 1000 },
  async () => {
    const { queue, calls } = createFixture();
    queue.cards.flush("old", [createPart("one")]);
    await queue.waitForIdle();
    queue.cards.flush("new", [createPart("new")]);
    await queue.waitForIdle();
    queue.cards.flush("old", [createPart("updated"), createPart("two")]);
    await queue.waitForIdle();
    queue.cards.flush("old", [createPart("final")]);
    await queue.waitForIdle();
    queue.cards.flush("old", [createPart("final"), createPart("regrown")]);
    await queue.waitForIdle();
    assert.deepEqual(
      calls.slice(2).map((call) => [call.body, call.targetEventId]),
      [
        ["updated", "$event-1"],
        ["two", undefined],
        ["final", "$event-1"],
        ["", "$event-4"],
        ["regrown", "$event-4"],
      ],
    );
    queue.cards.finish("old");
    await queue.waitForIdle();
    assert.equal(queue.liveCount, 1);
    queue.cards.flush("new", [createPart("new")]);
    await queue.waitForIdle();
    assert.equal(calls.length, 7);
    queue.stop();
    assert.equal(queue.liveCount, 0);
  },
);

void test("first expanded card survives pending collapse, terminal edits and finish", { timeout: 1000 }, async () => {
  const { queue, calls, setTransport } = createFixture();
  const blocked = createGate();
  setTransport(async () => {
    await blocked.promise;
    return `$event-${calls.length}`;
  });
  queue.messages.flush("blocker", [createPart("blocking")]);
  await Promise.resolve();
  queue.cards.flush("card", [createPart("expanded")]);
  queue.cards.flush("card", [createPart("collapsed")]);
  queue.cards.flush("card", [createPart("collapsed terminal")]);
  queue.cards.finish("card");
  queue.cards.finish("empty");
  blocked.release();
  await queue.waitForIdle();
  assert.deepEqual(
    calls.slice(1).map((call) => [call.body, call.targetEventId]),
    [
      ["expanded", undefined],
      ["collapsed terminal", "$event-2"],
    ],
  );
  assert.equal(queue.liveCount, 1);
});

void test(
  "empty originals and unchanged edits are skipped; empty cumulative output clears originals",
  { timeout: 1000 },
  async () => {
    const { queue, calls } = createFixture();
    queue.messages.flush("empty", []);
    queue.messages.flush("empty", [createPart("")]);
    queue.messages.finish("empty");
    await queue.waitForIdle();
    assert.equal(queue.liveCount, 0);
    assert.equal(calls.length, 0);
    queue.messages.flush("a", [createPart("text")]);
    await queue.waitForIdle();
    queue.messages.flush("a", [createPart("text")]);
    await queue.waitForIdle();
    assert.equal(calls.length, 1);
    queue.messages.flush("a", []);
    queue.messages.finish("a");
    await queue.waitForIdle();
    assert.equal(calls[1]?.body, "");
    assert.equal(calls[1]?.targetEventId, "$event-1");
    assert.equal(queue.liveCount, 0);
  },
);

void test(
  "capacity and explicit delivery failure discard mappings and pending content",
  { timeout: 1000 },
  async () => {
    for (const failure of ["delivery", "capacity"]) {
      const { queue, failures, setTransport, calls } = createFixture(1);
      const blocked = createGate();
      setTransport(async (): Promise<undefined> => {
        await blocked.promise;
      });
      queue.messages.flush("a", [createPart("a")]);
      await Promise.resolve();
      queue.messages.flush("b", [createPart("b")]);
      if (failure === "capacity") queue.messages.flush("c", [createPart("c")]);
      blocked.release();
      await queue.waitForIdle();
      queue.messages.flush("late", [createPart("late")]);
      queue.messages.finish("a");
      assert.deepEqual(failures, [failure]);
      assert.equal(queue.liveCount, 0);
      assert.equal(queue.pendingCount, 0);
      assert.equal(calls.length, 1);
    }
  },
);

void test("transport exceptions notify once and idle settles after cleanup", { timeout: 1000 }, async () => {
  const { queue, failures, setTransport, calls } = createFixture();
  setTransport(async () => {
    throw new Error("private transport detail");
  });
  queue.messages.flush("a", [createPart("failed")]);
  queue.messages.flush("b", [createPart("pending")]);
  await queue.waitForIdle();
  assert.deepEqual(failures, ["delivery"]);
  assert.equal(queue.pendingCount, 0);
  assert.equal(queue.liveCount, 0);
  assert.equal(calls.length, 1);
});

void test("finish during an in-flight edit retains mappings until final delivery", { timeout: 1000 }, async () => {
  const { queue, calls, setTransport } = createFixture();
  const blocked = createGate();
  const started = createGate();
  queue.messages.flush("a", [createPart("initial")]);
  await queue.waitForIdle();
  setTransport(async () => {
    if (calls.length === 2) {
      started.release();
      await blocked.promise;
    }
    return `$event-${calls.length}`;
  });
  queue.messages.flush("a", [createPart("edit")]);
  await started.promise;
  queue.messages.flush("a", [createPart("final")]);
  queue.messages.finish("a");
  queue.messages.flush("b", [createPart("next")]);
  assert.equal(queue.liveCount, 2);
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
  assert.equal(queue.liveCount, 1);
  queue.messages.finish("b");
  await queue.waitForIdle();
  assert.equal(queue.liveCount, 0);
});

void test(
  "stop is idempotent, listeners detach and late callbacks cannot repopulate state",
  { timeout: 1000 },
  async () => {
    const { queue, failures, setTransport, calls } = createFixture();
    const blocked = createGate();
    setTransport(async () => {
      await blocked.promise;
      return "$late";
    });
    queue.cards.flush("card", [createPart("first"), createPart("continuation")]);
    await Promise.resolve();
    let notifications = 0;
    queue.onStop(() => assert.fail("detached listener called"))();
    queue.onStop(() => {
      notifications += 1;
    });
    queue.stop();
    queue.stop();
    queue.onStop(() => {
      notifications += 1;
    });
    queue.cards.flush("late", [createPart("late")]);
    blocked.release();
    await queue.waitForIdle();
    assert.equal(notifications, 2);
    assert.equal(calls.length, 1);
    assert.equal(queue.liveCount, 0);
    assert.deepEqual(failures, []);
  },
);

void test("encoded thread/edit budgets include actual target IDs", { timeout: 1000 }, async () => {
  const routing = { threadRootEventId: "$root", threadInReplyToEventId: "$reply" };
  const part = createPart("é<&".repeat(10));
  const target = "$" + "original".repeat(40);
  const failures: PublicationFailure[] = [];
  let sends = 0;
  const queue = new ConversationPublication({
    maximumPending: 2,
    maxMatrixMessageBytes: matrixHtmlContentBytes({ ...part, ...routing }, target) - 1,
    routing,
    onFailure: (reason) => failures.push(reason),
    publish: async () => {
      sends += 1;
      return target;
    },
  });
  queue.messages.flush("a", [part]);
  await queue.waitForIdle();
  queue.messages.flush("a", [createPart(part.body + "!")]);
  queue.messages.finish("a");
  await queue.waitForIdle();
  assert.equal(sends, 1);
  assert.deepEqual(failures, ["delivery"]);
  assert.equal(queue.liveCount, 0);
});

void test("sequential finishes retain no historical mappings", { timeout: 1000 }, async () => {
  const { queue } = createFixture(2);
  for (let index = 0; index < 100; index++) {
    queue.cards.flush(String(index), [createPart("text")]);
    queue.cards.finish(String(index));
    assert.equal(queue.liveCount, 1);
    await queue.waitForIdle();
    assert.equal(queue.liveCount, 0);
    assert.equal(queue.pendingCount, 0);
  }
});
