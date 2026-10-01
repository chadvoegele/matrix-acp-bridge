import assert from "node:assert/strict";
import { writePrivateFile } from "./common.mjs";

export function assertThreadResponse(content, rootEventId, promptEventId) {
  const relation = content?.["m.relates_to"];
  assert.equal(relation?.rel_type, "m.thread", "response lost its thread relation");
  assert.equal(relation.event_id, rootEventId, "response changed its thread root");
  assert.equal(relation["m.in_reply_to"]?.event_id, promptEventId, "response changed its fallback reply target");
  assert.equal(relation.is_falling_back, true, "response lost its fallback flag");
}

/** Observe the actual ACP wire frames without retaining transcript text in files. */
export class ThreadSessionMonitor {
  sessionIds = new Set();

  promptSessions = new Map();

  promptCount = 0;

  loadedSessions = [];

  loadSupported = false;

  #pendingInitialize = new Set();

  #pendingNewSessions = new Set();

  #sessionIdsPath;

  #persistSessionIds = Promise.resolve();

  constructor(sessionIdsPath) {
    this.#sessionIdsPath = sessionIdsPath;
  }

  async flushSessionIds() {
    await this.#persistSessionIds;
  }

  inspect(message, direction) {
    if (direction === "outbound") {
      if (message?.method === "initialize") this.#pendingInitialize.add(message.id);
      if (message?.method === "session/new") this.#pendingNewSessions.add(message.id);
      if (message?.method === "session/load") this.loadedSessions.push(message.params?.sessionId);
      if (message?.method === "session/prompt") {
        this.promptCount += 1;
        const prompt = message.params?.prompt?.find?.((part) => part?.type === "text")?.text;
        if (typeof prompt === "string" && typeof message.params?.sessionId === "string") {
          this.promptSessions.set(prompt, message.params.sessionId);
        }
      }
      return;
    }
    if (this.#pendingInitialize.delete(message?.id)) {
      this.loadSupported = message.result?.agentCapabilities?.loadSession === true;
    }
    if (this.#pendingNewSessions.delete(message?.id)) {
      const sessionId = message.result?.sessionId;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        this.sessionIds.add(sessionId);
        if (this.#sessionIdsPath !== undefined) {
          const snapshot = `${JSON.stringify([...this.sessionIds], null, 2)}\n`;
          this.#persistSessionIds = this.#persistSessionIds.then(() =>
            writePrivateFile(this.#sessionIdsPath, snapshot),
          );
          // The synchronous wire tap cannot await writes. Surface failures when
          // the runner flushes, without an early unhandled rejection.
          void this.#persistSessionIds.catch(() => {});
        }
      }
    }
  }
}
