import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationPublication,
  type MatrixOutputPublication,
  type PublicationFailure,
} from "./conversation-publication.js";
import { matrixHtmlContentBytes } from "./matrix-message-content.js";
import { matrixHtml, type MatrixSafeHtml } from "./matrix-html.js";
import { MatrixDelivery } from "./matrix-delivery.js";
import type { MatrixBridgeAdapter, MatrixHtmlMessage } from "./matrix-client.js";
import { FakeClock } from "./test-support/fake-clock.js";

const capacityNotice = "Agent output exceeded capacity. Dropping messages to Matrix until capacity is available.";

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
  const clock = new FakeClock();
  const diagnostics: unknown[] = [];
  let transport: () => Promise<string | undefined> = async () => `$event-${calls.length}`;
  const queue = new ConversationPublication({
    maximumPending,
    maxMatrixMessageBytes: 4096,
    clock,
    onCapacity: (...fields) => {
      diagnostics.push(fields);
    },
    onFailure: (reason) => {
      failures.push(reason);
    },
    publish: (emitter, publication) => {
      calls.push({ emitter, ...publication });
      return transport();
    },
  });
  return {
    queue,
    calls,
    failures,
    clock,
    diagnostics,
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

void test("explicit delivery failure discards mappings and pending content", { timeout: 1000 }, async () => {
  const { queue, failures, setTransport, calls } = createFixture(1);
  const blocked = createGate();
  setTransport(async (): Promise<undefined> => {
    await blocked.promise;
  });
  queue.messages.flush("a", [createPart("a")]);
  await Promise.resolve();
  queue.messages.flush("b", [createPart("b")]);
  blocked.release();
  await queue.waitForIdle();
  queue.messages.flush("late", [createPart("late")]);
  queue.messages.finish("a");
  assert.deepEqual(failures, ["delivery"]);
  assert.equal(queue.liveCount, 0);
  assert.equal(queue.pendingCount, 0);
  assert.equal(calls.length, 1);
});

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

function createSheddingFixture(maximumPending = 26) {
  const fixture = createFixture(maximumPending);
  const blocked = createGate();
  fixture.setTransport(async () => {
    if (fixture.calls.length === 1) await blocked.promise;
    return `$event-${fixture.calls.length}`;
  });
  return { ...fixture, blocked };
}

void test("default 26 pending plus one in flight shed mixed output with bounded state and recover", async () => {
  const f = createSheddingFixture();
  f.queue.messages.flush("active", [createPart("active")]);
  await Promise.resolve();
  f.queue.messages.finish("active");
  for (let index = 0; index < 26; index++) {
    const sink = index % 2 === 0 ? f.queue.messages : f.queue.cards;
    sink.flush(`pending-${index}`, [createPart("accepted")]);
    sink.finish(`pending-${index}`);
  }
  for (let index = 0; index < 10_000; index++) {
    const sink = index % 2 === 0 ? f.queue.messages : f.queue.cards;
    sink.flush(`dropped-${index}`, [createPart("private output")]);
    sink.finish(`dropped-${index}`);
    assert.equal(f.queue.pendingCount, 27);
    assert.equal(f.queue.liveCount, 27);
  }
  assert.equal(f.clock.pendingTimerCount, 0);
  assert.deepEqual(f.diagnostics, [["dropping", 1, 26]]);
  f.blocked.release();
  await f.queue.waitForIdle();
  assert.equal(f.calls.length, 28);
  assert.equal(f.calls.at(-1)?.body, capacityNotice);
  assert.deepEqual(f.diagnostics.at(-1), ["recovered", 10_000, 26]);
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /private|pending-|dropped-/u);
  assert.equal(f.queue.liveCount, 0);
  f.queue.messages.flush("fresh", [createPart("fresh")]);
  f.queue.messages.finish("fresh");
  await f.queue.waitForIdle();
  assert.equal(f.calls.at(-1)?.body, "fresh");
  assert.equal(f.queue.stopped, false);
  assert.equal(f.queue.liveCount, 0);
});

void test("dropped original can resume as a new event, while dropped updates keep existing continuation mappings", async () => {
  const f = createSheddingFixture(1);
  f.queue.messages.flush("active", [createPart("initial")]);
  await Promise.resolve();
  f.queue.cards.flush("pending", [createPart("expanded")]);
  f.queue.cards.flush("pending", [createPart("dropped collapse")]);
  f.queue.cards.finish("pending");
  f.queue.messages.flush("active", [createPart("dropped update"), createPart("dropped continuation")]);
  f.queue.messages.flush("missing", [createPart("dropped original")]);
  f.queue.messages.finish("missing");
  assert.equal(f.queue.liveCount, 2);
  f.blocked.release();
  await f.queue.waitForIdle();
  assert.deepEqual(
    f.calls.map((call) => call.body),
    ["initial", "expanded", capacityNotice],
  );
  f.queue.messages.flush("missing", [createPart("new original"), createPart("new continuation")]);
  f.queue.messages.finish("missing");
  await f.queue.waitForIdle();
  assert.equal(f.calls.at(-2)?.targetEventId, undefined);
  assert.equal(f.calls.at(-1)?.targetEventId, undefined);
  f.queue.messages.flush("active", [createPart("accepted update"), createPart("accepted continuation")]);
  f.queue.messages.finish("active");
  await f.queue.waitForIdle();
  assert.equal(f.calls.at(-2)?.targetEventId, "$event-1");
  assert.equal(f.calls.at(-1)?.targetEventId, undefined);
  assert.equal(f.queue.liveCount, 0);
});

void test("coalescing and finish work at capacity without losing the accepted final snapshot", async () => {
  const f = createSheddingFixture(1);
  f.queue.messages.flush("active", [createPart("active")]);
  await Promise.resolve();
  f.queue.messages.flush("pending", [createPart("obsolete")]);
  for (let index = 0; index < 1000; index++) f.queue.messages.flush("pending", [createPart("final")]);
  f.queue.messages.finish("active");
  f.queue.messages.finish("pending");
  f.blocked.release();
  await f.queue.waitForIdle();
  assert.deepEqual(
    f.calls.map((call) => call.body),
    ["active", "final"],
  );
  assert.equal(f.queue.liveCount, 0);
  assert.deepEqual(f.diagnostics, []);
});

void test("notices and diagnostics coalesce for 30 seconds after drain without timers or historical IDs", async () => {
  const f = createSheddingFixture();
  f.blocked.release();
  f.queue.shed();
  await f.queue.waitForIdle();
  for (let index = 0; index < 1000; index++) {
    f.queue.shed();
    await f.queue.waitForIdle();
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.diagnostics.length, 2);
  assert.equal(f.clock.pendingTimerCount, 0);
  f.clock.advanceBy(30_000);
  f.queue.shed();
  await f.queue.waitForIdle();
  assert.equal(f.calls.length, 2);
  assert.equal(f.diagnostics.length, 4);
  f.queue.stop();
  f.queue.shed();
  await f.queue.waitForIdle();
  assert.equal(f.calls.length, 2);
});

void test("shutdown discards the waiting notice and late send results without retaining live state", async () => {
  const f = createSheddingFixture(1);
  f.queue.messages.flush("active", [createPart("active")]);
  await Promise.resolve();
  f.queue.messages.flush("pending", [createPart("pending")]);
  f.queue.messages.flush("drop", [createPart("drop")]);
  f.queue.stop();
  f.blocked.release();
  await f.queue.waitForIdle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.queue.liveCount, 0);
  assert.equal(f.queue.pendingCount, 0);
  assert.equal(f.clock.pendingTimerCount, 0);
});

function createRoomDeliveryFixture() {
  const blocked = createGate();
  const started = createGate();
  const calls: MatrixHtmlMessage[] = [];
  let activeInSharedRoom = 0;
  const matrix: MatrixBridgeAdapter = {
    sendMessage: async () => {},
    stopIntake: () => {},
    stop: async () => {},
    onFatalError: () => assert.fail("delivery must not own fatal subscriptions"),
    sendHtmlMessage: async (message) => {
      calls.push(message);
      if (message.roomId === "!shared") {
        assert.equal(activeInSharedRoom++, 0);
        if (calls.length === 1) {
          started.release();
          await blocked.promise;
        }
        activeInSharedRoom--;
      }
      return `$event-${calls.length}`;
    },
  };
  const delivery = new MatrixDelivery({ matrix, canSend: () => true });
  const createThreadQueue = (threadRootEventId: string, roomId = "!shared") =>
    new ConversationPublication({
      maximumPending: 1,
      maxMatrixMessageBytes: 4096,
      routing: { threadRootEventId },
      onFailure: () => assert.fail("unexpected delivery failure"),
      publish: (_, publication) =>
        delivery.sendLive({
          ...publication,
          formattedBody: publication.formattedBody as MatrixSafeHtml,
          threadRootEventId,
          roomId,
          transactionId: `${threadRootEventId}-${calls.length}`,
        }),
    });
  return { blocked, started, calls, createThreadQueue };
}

void test("two threads in one room serialize notices normally while another conversation progresses", async () => {
  const { blocked, started, calls, createThreadQueue } = createRoomDeliveryFixture();
  const a = createThreadQueue("$a");
  const b = createThreadQueue("$b");
  const other = createThreadQueue("$other", "!other");
  a.messages.flush("first", [createPart("a-first")]);
  await started.promise;
  b.messages.flush("first", [createPart("b-first")]);
  await Promise.resolve();
  for (const queue of [a, b]) {
    queue.messages.flush("pending", [createPart("pending")]);
    queue.messages.flush("dropped", [createPart("dropped")]);
    queue.messages.finish("first");
    queue.messages.finish("pending");
  }
  other.messages.flush("fresh", [createPart("unrelated")]);
  other.messages.finish("fresh");
  await other.waitForIdle();
  assert.ok(calls.some((call) => call.body === "unrelated"));
  assert.equal(calls.filter((call) => call.body === capacityNotice).length, 0);
  blocked.release();
  await Promise.all([a.waitForIdle(), b.waitForIdle()]);
  assert.deepEqual(
    calls
      .filter((call) => call.body === capacityNotice)
      .map((call) => call.threadRootEventId)
      .sort(),
    ["$a", "$b"],
  );
  for (const queue of [a, b, other]) assert.equal(queue.liveCount, 0);
});

void test("output is admitted while a capacity notice is still in flight", { timeout: 1000 }, async () => {
  const f = createFixture(1);
  const blocked = createGate();
  const started = createGate();
  f.setTransport(async () => {
    if (f.calls.length === 1) {
      started.release();
      await blocked.promise;
    }
    return `$event-${f.calls.length}`;
  });
  f.queue.shed();
  await started.promise;
  f.queue.messages.flush("fresh", [createPart("fresh")]);
  f.queue.messages.finish("fresh");
  assert.equal(f.queue.liveCount, 1);
  blocked.release();
  await f.queue.waitForIdle();
  assert.deepEqual(
    f.calls.map((call) => call.body),
    [capacityNotice, "fresh"],
  );
  assert.equal(f.queue.liveCount, 0);
  assert.deepEqual(f.failures, []);
});

void test("notice delivery failure stops publication and clears the episode", { timeout: 1000 }, async () => {
  const f = createFixture();
  f.setTransport(async (): Promise<undefined> => {});
  f.queue.shed();
  await f.queue.waitForIdle();
  f.queue.shed();
  assert.deepEqual(f.failures, ["delivery"]);
  assert.equal(f.queue.stopped, true);
  assert.equal(f.queue.liveCount, 0);
  assert.equal(f.queue.pendingCount, 0);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.diagnostics, [["dropping", 1, 10]]);
});

void test("drain handoff cannot strand output admitted in a microtask", { timeout: 1000 }, async () => {
  const f = createFixture(30);
  f.queue.messages.flush("first", [createPart("first")]);
  f.queue.messages.finish("first");
  // Interleave admission across both transport completion and the worker handoff.
  for (let index = 0; index < 20; index++) {
    await Promise.resolve();
    f.queue.messages.flush(`next-${index}`, [createPart(`next-${index}`)]);
    f.queue.messages.finish(`next-${index}`);
  }
  await f.queue.waitForIdle();
  assert.equal(f.calls.length, 21);
  assert.equal(f.queue.pendingCount, 0);
  assert.equal(f.queue.liveCount, 0);
  assert.deepEqual(f.diagnostics, []);
});

void test("capacity notice respects the encoded thread event budget", { timeout: 1000 }, async () => {
  const calls: MatrixOutputPublication[] = [];
  const failures: PublicationFailure[] = [];
  const routing = { threadRootEventId: "$root".repeat(20) };
  const maximumBytes = 1024;
  const queue = new ConversationPublication({
    maximumPending: 1,
    maxMatrixMessageBytes: maximumBytes,
    routing,
    onFailure: (reason) => {
      failures.push(reason);
    },
    publish: async (_, publication) => {
      calls.push(publication);
      return `$event-${calls.length}`;
    },
  });
  queue.shed();
  await queue.waitForIdle();
  assert.equal(calls.map((call) => call.body).join(""), capacityNotice);
  for (const call of calls) assert.ok(matrixHtmlContentBytes({ ...call, ...routing }) <= maximumBytes);
  assert.equal(queue.liveCount, 0);
  assert.deepEqual(failures, []);
});
