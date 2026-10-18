import { randomBytes } from "node:crypto";
import { getEffectiveContent } from "./unified-observations.mjs";
import { assertThreadResponse } from "./thread-sessions.mjs";
import { installLiveDecryptionFailureHandler } from "../test_encrypted_message/decryption-failure-gate.mjs";

export async function runSenderHarness({ readEnvironment, readToken, createAdapter, threadMode = false }) {
  if (
    !threadMode &&
    (process.argv.includes("--thread-root") ||
      process.argv.includes("--expect-thread") ||
      process.argv.includes("--expect-fallback"))
  ) {
    throw new Error("room sender does not accept thread options");
  }

  function argument(name) {
    const index = process.argv.indexOf(name);
    if (index === -1 || process.argv[index + 1] === undefined) throw new Error(`${name} is required`);
    return process.argv[index + 1];
  }

  const environment = await readEnvironment(argument("--environment"));
  const prompt = argument("--prompt");
  const expected = argument("--expect");
  const threadRootEventId =
    threadMode && process.argv.includes("--thread-root")
      ? process.argv[process.argv.indexOf("--thread-root") + 1]
      : undefined;
  const expectThread = threadMode;
  const expectedFallback =
    threadMode && process.argv.includes("--expect-fallback") ? argument("--expect-fallback") : undefined;
  const adapter = await createAdapter(environment, "sender");
  const token = await readToken(environment.sender.tokenFile);
  const timeoutMs = 180_000;
  let promptEvent;
  const responseEvents = [];
  const observed = new Map();
  let resolveExchange;
  let rejectExchange;
  const exchange = new Promise((resolve, reject) => {
    resolveExchange = resolve;
    rejectExchange = reject;
  });
  const timer = setTimeout(() => rejectExchange(new Error("encrypted exchange timed out")), timeoutMs);

  adapter.onFatalError(() => rejectExchange(new Error("Matrix sender reported a fatal error")));
  const beginLiveExchange = installLiveDecryptionFailureHandler(adapter, rejectExchange);
  adapter.onSyncBatch((batch) => {
    // Initial history is not part of this exchange. Inspect only the normalized
    // timelines from later live batches.
    if (batch.phase === "initial") return;
    for (const room of batch.rooms) {
      for (const event of room.timeline) {
        observed.set(event.eventId, event);
        const body = getEffectiveContent(event)?.body;
        if (event.sender === environment.sender.userId && body === prompt) promptEvent = event;
        if (promptEvent !== undefined && event.sender === environment.bridge.userId && body === expected) {
          responseEvents.push(event);
        }
        if (promptEvent !== undefined && responseEvents.length > 0) resolveExchange();
      }
    }
  });

  async function rawEventType(eventId) {
    const room = encodeURIComponent(environment.roomId);
    const event = encodeURIComponent(eventId);
    const response = await fetch(`${environment.homeserver}/_matrix/client/v3/rooms/${room}/event/${event}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.type !== "string") throw new Error(`event lookup failed: HTTP ${response.status}`);
    return body.type;
  }

  function assertEncrypted(event, label) {
    if (
      event?.eventId === undefined ||
      event.isEncrypted !== true ||
      event.isDecrypted !== true ||
      event.isPlaintext === true
    ) {
      throw new Error(`${label} was not an authenticated decrypted encrypted event`);
    }
  }

  try {
    await adapter.start();
    beginLiveExchange();
    promptEvent = undefined;
    responseEvents.length = 0;
    process.stderr.write("Sender is ready; sending encrypted prompt.\n");
    await adapter.sendMessage({
      roomId: environment.roomId,
      inboundEventId: `$mabe2e_${randomBytes(8).toString("hex")}`,
      responseKind: "agent",
      partNumber: 1,
      partCount: 1,
      transactionId: `mabe2e_${randomBytes(16).toString("hex")}`,
      content: { msgtype: "m.text", body: prompt },
      ...(threadRootEventId === undefined ? {} : { threadRootEventId, threadInReplyToEventId: threadRootEventId }),
    });
    process.stderr.write("Encrypted prompt sent; waiting for response.\n");
    await exchange;
    process.stderr.write("Encrypted response received.\n");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    clearTimeout(timer);
    if (responseEvents.length !== 1) throw new Error(`expected one response, received ${responseEvents.length}`);
    const responseEvent = responseEvents[0];
    assertEncrypted(promptEvent, "prompt");
    assertEncrypted(responseEvent, "response");
    const target = responseEvent.content?.["m.relates_to"];
    const original = target?.rel_type === "m.replace" ? observed.get(target.event_id) : responseEvent;
    assertEncrypted(original, "response original");
    if (original.sender !== environment.bridge.userId) throw new Error("response original was not sent by the bridge");
    if (threadRootEventId !== undefined) {
      const relation = promptEvent.content?.["m.relates_to"];
      if (
        relation?.rel_type !== "m.thread" ||
        relation.event_id !== threadRootEventId ||
        relation["m.in_reply_to"]?.event_id !== threadRootEventId
      ) {
        throw new Error("encrypted prompt did not retain its Matrix thread relation");
      }
    }
    if (expectThread) {
      const expectedRoot = threadRootEventId ?? promptEvent.eventId;
      assertThreadResponse(original.content, expectedRoot, expectedFallback ?? promptEvent.eventId);
      assertThreadResponse(getEffectiveContent(responseEvent), expectedRoot, expectedFallback ?? promptEvent.eventId);
    }
    const [promptWireType, responseWireType, originalWireType] = await Promise.all([
      rawEventType(promptEvent.eventId),
      rawEventType(responseEvent.eventId),
      rawEventType(original.eventId),
    ]);
    if (
      promptWireType !== "m.room.encrypted" ||
      responseWireType !== "m.room.encrypted" ||
      originalWireType !== "m.room.encrypted"
    ) {
      throw new Error("prompt or response was plaintext on the wire");
    }
    process.stdout.write(
      `${JSON.stringify({
        event: "exchange-complete",
        promptEventId: promptEvent.eventId,
        responseEventId: responseEvent.eventId,
        promptWireType,
        responseWireType,
        responseCount: responseEvents.length,
      })}\n`,
    );
  } finally {
    clearTimeout(timer);
    await adapter.stop().catch(() => {});
    await adapter.closeCrypto().catch(() => {});
  }
}
