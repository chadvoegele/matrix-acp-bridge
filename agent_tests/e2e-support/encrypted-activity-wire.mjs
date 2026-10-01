import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startBridgePair, stopBridgePair } from "./acp.mjs";
import { assertThreadResponse } from "./thread-sessions.mjs";
import { installLiveDecryptionFailureHandler } from "../encrypted-e2e/decryption-failure-gate.mjs";

export async function runActivityHarness({ readEnvironment, readToken, createAdapter, threadMode = false }) {
  const environment = await readEnvironment(process.argv[2]);
  const adapter = await createAdapter(environment, "sender");
  const token = await readToken(environment.sender.tokenFile);
  const marker = randomBytes(6).toString("hex").toUpperCase();
  const prompt = `ACTIVITY_WIRE_${marker}`;
  const finalText = `SCRIPTED_ACP_DONE_${marker}`;
  let events = [];
  let promptEventId;
  let promptTimestamp;
  let resolveFinal;
  let rejectFinal;
  const final = new Promise((resolvePromise, reject) => {
    resolveFinal = resolvePromise;
    rejectFinal = reject;
  });
  const timer = setTimeout(() => rejectFinal(new Error("encrypted activity timed out")), 180_000);
  adapter.onFatalError(() => rejectFinal(new Error("encrypted activity sender failed")));
  const beginLiveExchange = installLiveDecryptionFailureHandler(adapter, rejectFinal);
  adapter.onSyncBatch((batch) => {
    if (batch.phase === "initial") return;
    for (const room of batch.rooms) {
      for (const event of room.timeline) {
        if (event.sender === environment.sender.userId && event.content?.body === prompt) {
          promptEventId = event.eventId;
          promptTimestamp = event.originServerTs;
        }
        if (event.sender !== environment.bridge.userId) continue;
        events.push(event);
        if (event.content?.body === finalText || event.content?.["m.new_content"]?.body === finalText) resolveFinal();
      }
    }
  });

  async function wireType(eventId) {
    const room = encodeURIComponent(environment.roomId);
    const response = await fetch(
      `${environment.homeserver}/_matrix/client/v3/rooms/${room}/event/${encodeURIComponent(eventId)}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`encrypted activity event lookup failed: HTTP ${response.status}`);
    const event = await response.json();
    return event.type;
  }

  let pair;
  try {
    pair = await startBridgePair(environment);
    await adapter.start();
    beginLiveExchange();
    await adapter.sendMessage({
      roomId: environment.roomId,
      inboundEventId: `$activity_${marker}`,
      responseKind: "agent",
      partNumber: 1,
      partCount: 1,
      transactionId: `activity_${randomBytes(16).toString("hex")}`,
      content: { msgtype: "m.text", body: prompt },
    });
    await final;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
    if (threadMode) {
      assert.equal(typeof promptTimestamp, "number", "encrypted thread root timestamp was not observed");
      // Reused crypto stores can finish decrypting old history in a live batch.
      // Scope by the test prompt's server timestamp, never by the expected root:
      // incorrectly routed new output must still fail the relation assertions.
      events = events.filter(
        (event) => typeof event.originServerTs === "number" && event.originServerTs >= promptTimestamp,
      );
    }
    assert(events.length >= 5, "encrypted activity did not send expected messages");
    for (const event of events) {
      assert(
        event.eventId && event.isEncrypted && event.isDecrypted && !event.isPlaintext,
        "encrypted activity event was not authenticated and decrypted",
      );
    }
    const types = await Promise.all(events.map((event) => wireType(event.eventId)));
    assert(
      types.every((type) => type === "m.room.encrypted"),
      "activity leaked as plaintext wire event",
    );
    const edits = events.filter((event) => event.content?.["m.relates_to"]?.rel_type === "m.replace");
    if (threadMode) {
      assert.equal(typeof promptEventId, "string", "encrypted thread root was not observed");
      for (const event of events) {
        const content =
          event.content?.["m.relates_to"]?.rel_type === "m.replace" ? event.content["m.new_content"] : event.content;
        assertThreadResponse(content, promptEventId, promptEventId);
      }
    }
    assert(edits.length > 0, "encrypted activity had no decrypted edit events");
    const textOriginals = events.filter(
      (event) =>
        event.content?.["m.relates_to"]?.rel_type !== "m.replace" &&
        (event.content?.body === "I will show activity before the tools." || event.content?.body === finalText),
    );
    assert.equal(textOriginals.length, 2, "encrypted agent messages were not sent once each");
    const textIds = new Set(textOriginals.map((event) => event.eventId));
    assert(
      edits.every((event) => !textIds.has(event.content?.["m.relates_to"]?.event_id)),
      "encrypted agent text was edited",
    );
    for (const event of edits) {
      assert.equal(event.content.body, `* ${event.content["m.new_content"].body}`);
      assert.equal(event.content.formatted_body, `* ${event.content["m.new_content"].formatted_body}`);
    }
    const html = events
      .map((event) => event.content?.["m.new_content"]?.formatted_body ?? event.content?.formatted_body ?? "")
      .join("\n");
    assert(html.includes("Past agent events (10)"), "encrypted activity ten-event rollover missing");
    assert(html.includes("READ_RESULT_ONCE"), "encrypted archived tool update missing");
    assert(
      edits.some(
        (event) =>
          events.some(
            (original) =>
              original.eventId === event.content?.["m.relates_to"]?.event_id &&
              !original.content?.body?.includes("READ_RESULT_ONCE"),
          ) &&
          event.content?.["m.new_content"]?.body?.includes("READ_RESULT_ONCE") &&
          event.content?.["m.new_content"]?.formatted_body?.includes("Past agent events (10)"),
      ),
      "encrypted archived read result was not delivered as an edit",
    );
    const newestOriginal = events.find(
      (event) =>
        event.content?.body?.includes("batch thought 11") &&
        event.content?.["m.relates_to"]?.rel_type !== "m.replace" &&
        !event.content?.formatted_body?.includes("Past agent events"),
    );
    assert(newestOriginal, "encrypted eleventh event was first sent collapsed");
    assert(
      edits.some(
        (event) =>
          event.content?.["m.relates_to"]?.event_id === newestOriginal.eventId &&
          event.content?.["m.new_content"]?.formatted_body?.includes("Past agent events (1)"),
      ),
      "encrypted agent message did not collapse the newest activity batch",
    );
  } finally {
    clearTimeout(timer);
    await adapter.stop().catch(() => {});
    await adapter.closeCrypto().catch(() => {});
    if (pair) await stopBridgePair(pair);
  }
  process.stdout.write("Scripted encrypted ACP activity wire test passed.\n");
}
