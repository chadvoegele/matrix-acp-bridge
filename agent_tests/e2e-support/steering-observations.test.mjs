import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSteeringBaseline,
  assertSteeringHealthy,
  assertSteeringIdleNotices,
  assertSteeringDeviceBaseline,
  selectEventsSinceInput,
  collectAgentMessages,
  effectiveMatrixReplies,
} from "./steering-observations.mjs";

function createAgentChunk(sessionId, sessionUpdate, messageId, text) {
  return {
    direction: "in",
    frame: {
      method: "session/update",
      params: { sessionId, update: { sessionUpdate, messageId, content: { type: "text", text } } },
    },
  };
}

function createSessionFrames(sessionId = "first", startupInfo = "Synthetic startup\n", id = 1) {
  return [
    { direction: "out", frame: { id, method: "session/new", params: { cwd: "/synthetic", mcpServers: [] } } },
    { direction: "in", frame: { id, result: { sessionId, _meta: { piAcp: { startupInfo } } } } },
  ];
}

function createPromptFrames() {
  return [
    { direction: "out", frame: { id: 2, method: "session/prompt", params: { sessionId: "first", prompt: [] } } },
    { direction: "in", frame: { id: 2, result: { stopReason: "end_turn" } } },
  ];
}

test("startup guard rejects session creation even before a prompt starts", () => {
  assert.throws(() => assertSteeringBaseline([{ direction: "out", frame: { method: "session/new" } }]));
  assertSteeringBaseline([{ direction: "out", frame: { method: "initialize" } }]);
});

test("health guard catches RPC errors outside tracked scenario prompts", () => {
  assert.throws(() =>
    assertSteeringHealthy(
      [{ direction: "in", phase: "shutdown", frame: { id: 9, error: { code: -32_603 } } }],
      [],
      "bridge",
    ),
  );
});

test("health guard catches historical msg3 thread failure outside reply snapshot", () => {
  const events = [
    {
      sender: "bridge",
      originServerTs: 1,
      content: { body: "[agent error]", "m.relates_to": { rel_type: "m.thread", event_id: "old-msg3" } },
    },
  ];
  assert.throws(() => assertSteeringHealthy([], events, "bridge"));
  assertSteeringHealthy([], [{ ...events[0], sender: "other" }], "bridge");
});

test("live idle notice counts preserve default-selected silence in both response modes", () => {
  const notice = { content: { body: "No running turn; message queued as a prompt." } };
  const reply = { content: { body: "agent reply" } };
  assertSteeringIdleNotices([reply, notice], "room");
  assertSteeringIdleNotices([reply, notice, notice], "thread");
  assert.throws(() => assertSteeringIdleNotices([notice, notice], "room"));
  assert.throws(() => assertSteeringIdleNotices([notice, notice, notice], "thread"));
});

test("startup guard rejects session activity even without a captured request", () => {
  assert.throws(() =>
    assertSteeringBaseline([
      { direction: "in", frame: { method: "session/update", params: { update: { sessionUpdate: "tool_call" } } } },
    ]),
  );
});

test("live mode isolation rejects a new state or response mode on an already used device", () => {
  const baseline = {
    version: 1,
    homeserver: "https://matrix.example.org",
    userId: "@bridge:example.org",
    deviceId: "test-device",
    stateDir: "/private/room-state",
    responseMode: "room",
  };
  assertSteeringDeviceBaseline(null, baseline);
  assertSteeringDeviceBaseline({ ...baseline }, baseline);
  assert.throws(() => assertSteeringDeviceBaseline(baseline, { ...baseline, stateDir: "/private/fresh-state" }));
  assert.throws(() => assertSteeringDeviceBaseline(baseline, { ...baseline, responseMode: "thread" }));
  assert.throws(() => assertSteeringDeviceBaseline(baseline, { ...baseline, deviceId: "different-device" }));
});

test("reset observation excludes delayed older notices without hiding new idle notices or RPC errors", () => {
  const notice = {
    sender: "bridge",
    originServerTs: 99,
    content: { body: "No running turn; message queued as a prompt." },
  };
  const newNotice = { ...notice, originServerTs: 101 };
  const input = { originServerTs: 100 };
  assert.deepEqual(selectEventsSinceInput([notice, input], input), [input]);
  const current = selectEventsSinceInput([notice, input, newNotice], input);
  assert.deepEqual(current, [input, newNotice]);
  assert.equal(current.filter((event) => event.content?.body === notice.content.body).length, 1);
  assert.throws(() => selectEventsSinceInput([notice], {}), /controlled input/u);
  assert.throws(() => selectEventsSinceInput([{}], input), /observed event/u);
  assert.throws(() => assertSteeringHealthy([{ direction: "in", frame: { error: {} } }], current, "bridge"));
});

test("steering observations accumulate response IDs across tools, thoughts, prompt completion and sessions", () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- Local wire fixture.
  const chunk = (sessionId, sessionUpdate, messageId, text) => ({
    direction: "in",
    frame: {
      method: "session/update",
      params: { sessionId, update: { sessionUpdate, messageId, content: { type: "text", text } } },
    },
  });
  const frames = [
    chunk("first", "agent_message_chunk", "shared", "before "),
    chunk("first", "agent_thought_chunk", "shared", "thought"),
    {
      direction: "in",
      frame: { method: "session/update", params: { sessionId: "first", update: { sessionUpdate: "tool_call" } } },
    },
    { direction: "in", frame: { id: 1, result: { stopReason: "end_turn" } } },
    chunk("second", "agent_message_chunk", "shared", "independent"),
    chunk("first", "agent_message_chunk", "shared", "after\n"),
    chunk("first", "agent_message_chunk", "next", "next response"),
  ];
  assert.deepEqual(collectAgentMessages(frames), [
    { sessionId: "first", messageId: "shared", text: "before after\n" },
    { sessionId: "first", messageId: "next", text: "next response" },
    { sessionId: "second", messageId: "shared", text: "independent" },
  ]);
  for (const kind of ["agent_message_chunk", "agent_thought_chunk"]) {
    for (const id of [undefined, "", "\u0000 ", 4])
      assert.throws(() => collectAgentMessages([chunk("first", kind, id, "private")]), /usable response ID/u);
  }
});

for (const promptFrames of [[], createPromptFrames().slice(0, 1), createPromptFrames()]) {
  test(`steering consumes exact advertised startup once with ${promptFrames.length} prompt frames`, () => {
    const startup = createAgentChunk("first", "agent_message_chunk", undefined, "Synthetic startup\n");
    const frames = [
      ...createSessionFrames(),
      ...promptFrames,
      startup,
      createAgentChunk("first", "agent_message_chunk", "answer", "model output"),
    ];
    assert.deepEqual(collectAgentMessages(frames), [{ sessionId: "first", messageId: "answer", text: "model output" }]);
    assert.throws(() => collectAgentMessages([...frames, startup]), /usable response ID/u);
    assert.throws(() => collectAgentMessages([...frames, createSessionFrames()[1], startup]), /usable response ID/u);
    assert.deepEqual(
      collectAgentMessages([
        ...frames,
        createAgentChunk("first", "agent_message_chunk", "later", "Synthetic startup\n"),
      ]),
      [
        { sessionId: "first", messageId: "answer", text: "model output" },
        { sessionId: "first", messageId: "later", text: "Synthetic startup\n" },
      ],
    );
  });
}

for (const text of [
  "Synthetic startup",
  "Synthetic startup\nextra",
  " Synthetic startup\n",
  "Synthetic ",
  "startup\n",
]) {
  test(`steering rejects a startup mismatch ${JSON.stringify(text)}`, () => {
    assert.throws(
      () =>
        collectAgentMessages([
          ...createSessionFrames(),
          createAgentChunk("first", "agent_message_chunk", undefined, text),
        ]),
      /usable response ID/u,
    );
  });
}

test("steering binds startup markers to sessions and correlates interleaved numeric and string RPC IDs", () => {
  const first = createSessionFrames("first", "shared startup", 1);
  const second = createSessionFrames("second", "shared startup", "1");
  const advertised = [first[0], second[0], second[1], first[1]];
  assert.deepEqual(
    collectAgentMessages([
      ...advertised,
      createAgentChunk("second", "agent_message_chunk", undefined, "shared startup"),
      createAgentChunk("first", "agent_message_chunk", undefined, "shared startup"),
    ]),
    [],
  );
  for (const sessionId of ["second", "unknown"]) {
    assert.throws(
      () =>
        collectAgentMessages([
          ...first,
          createAgentChunk(sessionId, "agent_message_chunk", undefined, "shared startup"),
        ]),
      /usable response ID/u,
    );
  }
  assert.throws(
    () =>
      collectAgentMessages([
        ...advertised,
        createAgentChunk("first", "agent_message_chunk", undefined, "shared startup"),
        createAgentChunk("first", "agent_message_chunk", undefined, "shared startup"),
      ]),
    /usable response ID/u,
  );
});

const [newRequest, newResponse] = createSessionFrames();
const unrelatedStartupFrames = [
  ["unmatched reply", [newResponse]],
  ["reply preceding request", [newResponse, newRequest]],
  ["reply with different ID", [newRequest, { ...newResponse, frame: { ...newResponse.frame, id: 9 } }]],
  [
    "reply with string instead of numeric ID",
    [newRequest, { ...newResponse, frame: { ...newResponse.frame, id: "1" } }],
  ],
  ["outbound reply", [newRequest, { ...newResponse, direction: "out" }]],
  ["inbound request", [{ ...newRequest, direction: "in" }, newResponse]],
  [
    "notification carrying response fields",
    [newRequest, { ...newResponse, frame: { ...newResponse.frame, method: "session/update" } }],
  ],
  ["error reply", [newRequest, { ...newResponse, frame: { ...newResponse.frame, error: { code: -32_603 } } }]],
  [
    "replayed reply after error",
    [newRequest, { direction: "in", frame: { id: 1, error: { code: -32_603 } } }, newResponse],
  ],
  [
    "replayed reply after markerless success",
    [newRequest, { direction: "in", frame: { id: 1, result: { sessionId: "first" } } }, newResponse],
  ],
  ...["session/load", "session/prompt", "initialize"].map((method) => [
    method,
    [{ ...newRequest, frame: { ...newRequest.frame, method } }, newResponse],
  ]),
  ...[undefined, null, {}, []].map((id, index) => [
    `invalid RPC ID ${index}`,
    [
      { ...newRequest, frame: { ...newRequest.frame, id } },
      { ...newResponse, frame: { ...newResponse.frame, id } },
    ],
  ]),
];
for (const [name, frames] of unrelatedStartupFrames) {
  test(`steering rejects startup metadata from ${name}`, () => {
    assert.throws(
      () =>
        collectAgentMessages([
          ...frames,
          createAgentChunk("first", "agent_message_chunk", undefined, "Synthetic startup\n"),
        ]),
      /usable response ID/u,
    );
  });
}

const malformedStartupResults = [
  undefined,
  null,
  [],
  "result",
  {},
  { sessionId: 1, _meta: { piAcp: { startupInfo: "Synthetic startup\n" } } },
  { sessionId: "first", _meta: null },
  { sessionId: "first", _meta: [] },
  { sessionId: "first", _meta: { piAcp: null } },
  { sessionId: "first", _meta: { piAcp: [] } },
];
for (const [index, result] of malformedStartupResults.entries()) {
  test(`steering rejects malformed startup result ${index}`, () => {
    assert.throws(
      () =>
        collectAgentMessages([
          newRequest,
          { direction: "in", frame: { id: 1, result } },
          createAgentChunk("first", "agent_message_chunk", undefined, "Synthetic startup\n"),
        ]),
      /usable response ID/u,
    );
  });
}

for (const [index, marker] of [undefined, null, "", 1, false, {}, []].entries()) {
  test(`steering rejects missing empty or malformed startup marker ${index}`, () => {
    const frames = createSessionFrames();
    frames[1].frame.result._meta.piAcp.startupInfo = marker;
    assert.throws(
      () =>
        collectAgentMessages([
          ...frames,
          createAgentChunk(
            "first",
            "agent_message_chunk",
            undefined,
            typeof marker === "string" ? marker : "Synthetic startup\n",
          ),
        ]),
      /usable response ID/u,
    );
  });
}

test("steering compares nonempty startup markers without trimming or normalizing production text", () => {
  for (const marker of [" \t\n", "\u0000", "  Synthetic startup\r\n"]) {
    assert.deepEqual(
      collectAgentMessages([
        ...createSessionFrames("first", marker),
        createAgentChunk("first", "agent_message_chunk", "optional-startup-id", marker),
      ]),
      [],
    );
    assert.throws(
      () =>
        collectAgentMessages([
          ...createSessionFrames("first", marker),
          createAgentChunk("first", "agent_message_chunk", undefined, marker.slice(0, -1)),
        ]),
      /usable response ID/u,
    );
  }
});

test("steering never consumes a startup marker for thought text or tagged notices and tools", () => {
  const thought = createAgentChunk("first", "agent_thought_chunk", undefined, "Synthetic startup\n");
  assert.throws(() => collectAgentMessages([...createSessionFrames(), thought]), /usable response ID/u);
  thought.frame.params.update.messageId = "thought";
  const notice = createAgentChunk("first", "agent_message_chunk", undefined, "Synthetic startup\n");
  notice.frame.params.update._meta = { piAcp: { notify: { level: "info" } } };
  assert.deepEqual(
    collectAgentMessages([
      ...createSessionFrames(),
      thought,
      notice,
      {
        direction: "in",
        frame: { method: "session/update", params: { sessionId: "first", update: { sessionUpdate: "tool_call" } } },
      },
      createAgentChunk("first", "agent_message_chunk", undefined, "Synthetic startup\n"),
      createAgentChunk("first", "agent_message_chunk", "answer", "model output"),
    ]),
    [{ sessionId: "first", messageId: "answer", text: "model output" }],
  );
});

for (const kind of ["agent_message_chunk", "agent_thought_chunk"]) {
  for (const promptFrames of [[], createPromptFrames().slice(0, 1), createPromptFrames()]) {
    for (const [index, messageId] of [undefined, "", " \t\n", "\u0000\u001B", null, 42, {}, []].entries()) {
      test(`steering rejects invalid ${kind} ID ${index} with ${promptFrames.length} prompt frames`, () => {
        for (const sessionId of ["first", "unknown"]) {
          assert.throws(
            () =>
              collectAgentMessages([
                ...createSessionFrames(),
                ...promptFrames,
                createAgentChunk(sessionId, kind, messageId, "synthetic model output"),
              ]),
            /usable response ID/u,
          );
        }
      });
    }
  }
}

test("steering preserves unsolicited IDs and same-message continuations before and after prompt completion", () => {
  const [prompt, completed] = createPromptFrames();
  assert.deepEqual(
    collectAgentMessages([
      ...createSessionFrames(),
      createAgentChunk("first", "agent_message_chunk", " original ", "unsolicited "),
      prompt,
      createAgentChunk("first", "agent_thought_chunk", " original ", "thinking"),
      createAgentChunk("first", "agent_message_chunk", " original ", "during "),
      {
        direction: "in",
        frame: { method: "session/update", params: { sessionId: "first", update: { sessionUpdate: "tool_call" } } },
      },
      createAgentChunk("first", "agent_message_chunk", "next", "new assistant message "),
      completed,
      createAgentChunk("first", "agent_message_chunk", " original ", "after"),
      createAgentChunk("first", "agent_message_chunk", "next", "after"),
      createAgentChunk("unknown", "agent_message_chunk", "background", "unsolicited session"),
    ]),
    [
      { sessionId: "first", messageId: " original ", text: "unsolicited during after" },
      { sessionId: "first", messageId: "next", text: "new assistant message after" },
      { sessionId: "unknown", messageId: "background", text: "unsolicited session" },
    ],
  );
});

test("steering observations assess final replacements while retaining original routing and raw wire events", () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- Local Matrix fixture.
  const content = (body) => ({ msgtype: "m.text", body, "m.relates_to": { rel_type: "m.thread", event_id: "$root" } });
  const original = { eventId: "$original", content: content("before"), isEncrypted: true };
  const replacement = (id, target, body) => ({
    eventId: id,
    content: {
      body: `* ${body}`,
      "m.new_content": content(body),
      "m.relates_to": { rel_type: "m.replace", event_id: target },
    },
    isEncrypted: true,
  });
  const events = [
    original,
    replacement("$edit1", "$original", "before after"),
    replacement("$edit2", "$original", "final"),
    original,
  ];
  assert.deepEqual(effectiveMatrixReplies(events), [{ ...original, content: content("final") }]);
  assert.equal(events.length, 4);
  assert.equal(original.content.body, "before");
  assert.throws(
    () => effectiveMatrixReplies([original, replacement("$wrong", "$edit1", "bad")]),
    /unobserved original/u,
  );
  assert.throws(
    () =>
      effectiveMatrixReplies([
        original,
        { eventId: "$bad", content: { "m.relates_to": { rel_type: "m.replace", event_id: "$original" } } },
      ]),
    /effective content/u,
  );
});
