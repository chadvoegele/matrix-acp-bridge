import type { MatrixRoomId } from "./matrix-client.js";
import type { AcpSessionId } from "./acp-client.js";
import { conversationKey, type ConversationIdentity } from "./conversation-identity.js";

/** Legacy room-only API retained for room-mode callers. */
export interface SessionRecord {
  readonly roomId: MatrixRoomId;
  readonly sessionId: AcpSessionId;
}

export type ThreadConversationRecord = Extract<ConversationIdentity, { kind: "thread" }> & {
  readonly sessionId?: AcpSessionId;
};

export type ConversationRecord =
  (Extract<ConversationIdentity, { kind: "room" }> & { readonly sessionId: AcpSessionId }) | ThreadConversationRecord;

export interface SessionStore {
  get(roomId: MatrixRoomId): SessionRecord | undefined;
  set(record: SessionRecord): void;
  delete(roomId: MatrixRoomId): boolean;
  clear(): void;
  /** Room records only, for compatibility. */
  entries(): IterableIterator<SessionRecord>;
  getConversationRecord(identity: ConversationIdentity): ConversationRecord | undefined;
  setConversationRecord(record: ConversationRecord): void;
  /** Reset a known thread to sessionless; delete a room session. Unknown stays unknown. */
  resetConversation(identity: ConversationIdentity): boolean;
  deleteConversation(identity: ConversationIdentity): boolean;
  conversationEntries(): IterableIterator<ConversationRecord>;
}

/** In-process identities survive reset even when the ACP agent cannot load sessions. */
export class InMemorySessionStore implements SessionStore {
  #conversations = new Map<string, ConversationRecord>();

  get(roomId: MatrixRoomId): SessionRecord | undefined {
    const record = this.getConversationRecord({ kind: "room", roomId });
    return record?.kind === "room" ? { roomId, sessionId: record.sessionId } : undefined;
  }

  set(record: SessionRecord): void {
    this.setConversationRecord({ kind: "room", ...record });
  }

  delete(roomId: MatrixRoomId): boolean {
    return this.deleteConversation({ kind: "room", roomId });
  }

  clear(): void {
    this.#conversations.clear();
  }

  entries(): IterableIterator<SessionRecord> {
    const snapshot = [...this.#conversations.values()]
      .filter((record) => record.kind === "room")
      .map(({ roomId, sessionId }) => ({ roomId, sessionId }));
    return snapshot[Symbol.iterator]();
  }

  getConversationRecord(identity: ConversationIdentity): ConversationRecord | undefined {
    const record = this.#conversations.get(conversationKey(identity));
    return record === undefined ? undefined : { ...record };
  }

  setConversationRecord(record: ConversationRecord): void {
    this.#conversations.set(conversationKey(record), { ...record });
  }

  resetConversation(identity: ConversationIdentity): boolean {
    const key = conversationKey(identity);
    const current = this.#conversations.get(key);
    if (current === undefined) {
      return false;
    }
    if (identity.kind === "room") {
      return this.#conversations.delete(key);
    }
    if (current.sessionId === undefined) {
      return false;
    }
    this.#conversations.set(key, {
      kind: "thread",
      roomId: identity.roomId,
      threadRootEventId: identity.threadRootEventId,
    });
    return true;
  }

  deleteConversation(identity: ConversationIdentity): boolean {
    return this.#conversations.delete(conversationKey(identity));
  }

  conversationEntries(): IterableIterator<ConversationRecord> {
    return [...this.#conversations.values()].map((record) => ({ ...record }))[Symbol.iterator]();
  }
}
