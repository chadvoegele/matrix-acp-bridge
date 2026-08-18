import type { MatrixRoomId } from "./matrix-client.js";
import type { AcpSessionId } from "./acp-client.js";

export interface SessionRecord {
  readonly roomId: MatrixRoomId;
  readonly sessionId: AcpSessionId;
}

/**
 * Milestone 1 deliberately exposes only an in-memory room/session boundary.
 * Durable sync, inbox, and session recovery are separate milestones.
 */
export interface SessionStore {
  get(roomId: MatrixRoomId): SessionRecord | undefined;
  set(record: SessionRecord): void;
  delete(roomId: MatrixRoomId): boolean;
  clear(): void;
  entries(): IterableIterator<SessionRecord>;
}

/**
 * Milestone 1's intentionally small session boundary.
 *
 * The store owns no files and makes no restart or delivery guarantees.  A
 * later durable store can implement the same contract at the bridge edge
 * without making the coordinator depend on persistence details.
 */
export class InMemorySessionStore implements SessionStore {
  #sessions = new Map<MatrixRoomId, SessionRecord>();

  get(roomId: MatrixRoomId): SessionRecord | undefined {
    const record = this.#sessions.get(roomId);
    return record === undefined ? undefined : { ...record };
  }

  set(record: SessionRecord): void {
    this.#sessions.set(record.roomId, { ...record });
  }

  delete(roomId: MatrixRoomId): boolean {
    return this.#sessions.delete(roomId);
  }

  clear(): void {
    this.#sessions.clear();
  }

  entries(): IterableIterator<SessionRecord> {
    const snapshot = [...this.#sessions.values()].map((record) => ({ ...record }));
    return snapshot[Symbol.iterator]();
  }
}
