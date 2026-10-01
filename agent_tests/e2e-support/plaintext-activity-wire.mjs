import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startBridgePair, stopBridgePair } from "./acp.mjs";
import { assertThreadResponse } from "./thread-sessions.mjs";

export async function runActivityHarness({ readEnvironment, readToken, threadMode = false }) {
  // Inspect raw Matrix wire events, including edits; SDK timelines may aggregate them.

  const environment = await readEnvironment(process.argv[2]);
  const token = await readToken(environment.sender.tokenFile);
  const room = encodeURIComponent(environment.roomId);
  const marker = randomBytes(6).toString("hex").toUpperCase();
  const prompt = `ACTIVITY_WIRE_${marker}`;
  const finalText = `SCRIPTED_ACP_DONE_${marker}`;
  const request = async (path, options = {}) => {
    const response = await fetch(`${environment.homeserver}/_matrix/client/v3${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`Matrix activity request failed: HTTP ${response.status}`);
    return response.json();
  };
  const sync = (since, timeout) =>
    request(
      `/sync?${new URLSearchParams({
        timeout: String(timeout),
        ...(since ? { since } : {}),
      })}`,
      { signal: AbortSignal.timeout(timeout + 20_000) },
    );

  const baseline = await sync(undefined, 0);
  let cursor = baseline.next_batch;
  assert.equal(typeof cursor, "string", "initial sync cursor");
  const pair = await startBridgePair(environment);
  try {
    const sent = await request(`/rooms/${room}/send/m.room.message/activity_${marker}`, {
      method: "PUT",
      body: JSON.stringify({ msgtype: "m.text", body: prompt }),
    });
    const promptEvent = await request(`/rooms/${room}/event/${encodeURIComponent(sent.event_id)}`);
    assert.equal(promptEvent.type, "m.room.message");
    assert.equal(promptEvent.content.body, prompt);

    const seen = new Map();
    let finalSeen = false;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const result = await sync(cursor, Math.min(10_000, deadline - Date.now()));
      cursor = result.next_batch;
      const events = result.rooms?.join?.[environment.roomId]?.timeline?.events ?? [];
      for (const event of events) {
        if (event.sender !== environment.bridge.userId || event.type !== "m.room.message") continue;
        seen.set(event.event_id, event);
        if (event.content?.body === finalText || event.content?.["m.new_content"]?.body === finalText) finalSeen = true;
      }
      if (finalSeen) {
        const tail = await sync(cursor, 2000);
        for (const event of tail.rooms?.join?.[environment.roomId]?.timeline?.events ?? []) {
          if (event.sender === environment.bridge.userId && event.type === "m.room.message")
            seen.set(event.event_id, event);
        }
        break;
      }
    }
    assert(finalSeen, "scripted ACP final message did not arrive");
    const raw = await Promise.all(
      [...seen.keys()].map((id) => request(`/rooms/${room}/event/${encodeURIComponent(id)}`)),
    );
    const originals = raw.filter((event) => event.content?.["m.relates_to"]?.rel_type !== "m.replace");
    const edits = raw.filter((event) => event.content?.["m.relates_to"]?.rel_type === "m.replace");
    const originalIds = new Set(originals.map((event) => event.event_id));
    if (threadMode) {
      for (const event of originals) assertThreadResponse(event.content, sent.event_id, sent.event_id);
      for (const event of edits) assertThreadResponse(event.content["m.new_content"], sent.event_id, sent.event_id);
    }
    assert.equal(originals.length, 5, "expected opening, two activity batches, and two eager agent messages");
    assert(edits.length > 0, "activity produced no m.replace wire edits");
    const textOriginals = originals.filter(
      (event) => event.content?.body === "I will show activity before the tools." || event.content?.body === finalText,
    );
    assert.equal(textOriginals.length, 2, "one send per complete agent message");
    const textIds = new Set(textOriginals.map((event) => event.event_id));
    assert(
      edits.every((event) => !textIds.has(event.content?.["m.relates_to"]?.event_id)),
      "agent text was edited on the wire",
    );
    assert(
      originals.findIndex((event) => event.event_id === textOriginals[0].event_id) <
        originals.findIndex((event) => event.content?.body?.includes("Read(/tmp/activity-example.txt)")),
      "boundary text was not sent before tool activity",
    );

    for (const event of [...originals, ...edits]) {
      assert.equal(event.type, "m.room.message");
      assert.equal(event.content.msgtype, "m.text");
      assert.equal(event.content.format, "org.matrix.custom.html");
      assert.equal(typeof event.content.body, "string");
      assert.equal(typeof event.content.formatted_body, "string");
      assert(
        Buffer.byteLength(JSON.stringify(event.content), "utf8") <= 32_768,
        "activity exceeded the configured Matrix event-size limit",
      );
      assert(!event.content.formatted_body.includes("<script"), "invalid activity HTML");
    }
    for (const event of edits) {
      const content = event.content;
      assert(originalIds.has(content["m.relates_to"].event_id), "edit targets an unknown original");
      assert.equal(content.body, `* ${content["m.new_content"].body}`);
      assert.equal(content.formatted_body, `* ${content["m.new_content"].formatted_body}`);
      assert.equal(content["m.new_content"].format, "org.matrix.custom.html");
      assert.equal(content["m.new_content"].msgtype, "m.text");
    }
    const latest = new Map(originals.map((event) => [event.event_id, event.content]));
    for (const edit of edits) latest.set(edit.content["m.relates_to"].event_id, edit.content["m.new_content"]);
    const effective = [...latest.values()];
    const html = effective.map((content) => content.formatted_body).join("\n");
    const wireHtml = raw
      .map((event) => event.content?.["m.new_content"]?.formatted_body ?? event.content.formatted_body)
      .join("\n");
    const body = effective.map((content) => content.body).join("\n");
    assert(html.includes("Past agent events (1)</summary>"), "agent-message boundary did not archive opening thought");
    assert(html.includes("Past agent events (10)</summary>"), "ten-event rollover did not archive the prior batch");
    assert(html.includes("batch thought 11"), "eleventh event is missing");
    const newestOriginal = originals.find((event) => event.content?.body?.includes("batch thought 11"));
    assert(
      newestOriginal && !newestOriginal.content.formatted_body.includes("Past agent events"),
      "eleventh event was first sent collapsed",
    );
    assert(
      edits.some(
        (event) =>
          event.content?.["m.relates_to"]?.event_id === newestOriginal.event_id &&
          event.content?.["m.new_content"]?.formatted_body?.includes("Past agent events (1)"),
      ),
      "agent message did not collapse the newest activity batch after its expanded send",
    );
    assert(
      html.includes("<details>") && html.includes("<summary>") && html.includes("<pre><code>"),
      "activity disclosure or code blocks are missing",
    );
    for (const value of ["#808080", "#000000", "#008000", "#C00000"]) {
      assert(wireHtml.includes(`data-mx-color="${value}"`), `missing ${value} status/diff color`);
    }
    for (const value of ["#EAEAEA", "#F2F2F2", "#E6F4EA"]) {
      assert(wireHtml.includes(`data-mx-bg-color="${value}"`), `missing ${value} status background`);
    }
    assert(html.includes("Read(/tmp/activity-example.txt)"));
    assert(html.includes("Write(/tmp/activity-example.txt)"));
    assert(html.includes("Edit(/tmp/activity-example.txt)"));
    assert(html.includes("Execute(") && html.includes(" (truncated)"), "long command disclosure missing");
    assert(html.includes("FIRST_OUTPUT") && html.includes("LAST_OUTPUT"), "terminal head/tail missing");
    assert(body.includes("FIRST_OUTPUT") === false || body.includes("LAST_OUTPUT"), "terminal fallback lost tail");
    assert.equal((body.match(/READ_RESULT_ONCE/gu) ?? []).length, 1, "late read output was lost or duplicated");
    assert.equal((body.match(/SCRIPTED_ACP_DONE_/gu) ?? []).length, 1, "final agent message duplicated");
    assert(body.includes("SCRIPTED_ACP_DONE_") && body.includes("[completed] 🔧"), "fallback lacks agent/status text");
    assert(html.includes('<span data-mx-color="#008000">+</span>'), "write diff lacks green sign");
    assert(html.includes('<span data-mx-color="#C00000">-</span>'), "edit diff lacks red sign");
    assert(html.includes("alpha") && html.includes("gamma"), "diff result text missing");
    const archived = [...latest.values()].find((content) => content.formatted_body.includes("Past agent events (10)"));
    assert(archived?.body.includes("READ_RESULT_ONCE"), "late update did not edit archived batch");
    assert(
      edits.some(
        (event) =>
          originals.some(
            (original) =>
              original.event_id === event.content["m.relates_to"].event_id &&
              !original.content.body.includes("READ_RESULT_ONCE"),
          ) &&
          event.content["m.new_content"].body.includes("READ_RESULT_ONCE") &&
          event.content["m.new_content"].formatted_body.includes("Past agent events (10)"),
      ),
      "archived read result was not delivered as an edit to a previously sent batch",
    );
    assert(
      raw.some((event) => event.content?.body === "I will show activity before the tools."),
      "first agent message was not sent eagerly",
    );
    process.stdout.write("Scripted plaintext ACP activity wire test passed.\n");
  } finally {
    await stopBridgePair(pair);
  }
}
