export type PublicationFailure = "capacity" | "delivery";

interface Publication {
  readonly key: object;
  operation: () => Promise<void>;
}

/** One bounded queue shared by a conversation's text and activity publishers. */
export class ConversationPublication {
  readonly #maximumPending: number;

  readonly #onFailure: (reason: PublicationFailure) => void;

  readonly #pending: Publication[] = [];

  #running: Promise<void> | undefined;

  #stopped = false;

  readonly #stopListeners = new Set<() => void>();

  /** Use the existing conversation queue limit; at most one extra operation is in flight. */
  constructor(maximumPending: number, onFailure: (reason: PublicationFailure) => void) {
    if (!Number.isSafeInteger(maximumPending) || maximumPending < 1) {
      throw new RangeError("maximumPending must be a positive integer");
    }
    this.#maximumPending = maximumPending;
    this.#onFailure = onFailure;
  }

  get pendingCount(): number {
    return this.#pending.length + (this.#running === undefined ? 0 : 1);
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /** Rejection requires the caller to retire intake or apply its existing backpressure policy. */
  enqueue(key: object, operation: () => Promise<void>): boolean {
    if (this.#stopped) return false;
    const existing = this.#pending.find((publication) => publication.key === key);
    if (existing !== undefined) {
      existing.operation = operation;
      return true;
    }
    if (this.#pending.length >= this.#maximumPending) {
      this.fail("capacity");
      return false;
    }
    this.#pending.push({ key, operation });
    this.#start();
    return true;
  }

  onStop(listener: () => void): () => void {
    if (this.#stopped) listener();
    else this.#stopListeners.add(listener);
    return () => {
      this.#stopListeners.delete(listener);
    };
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#pending.length = 0;
    for (const listener of this.#stopListeners) listener();
    this.#stopListeners.clear();
  }

  async waitForIdle(): Promise<void> {
    while (this.#running !== undefined) await this.#running;
  }

  #start(): void {
    if (this.#running !== undefined) return;
    this.#running = Promise.resolve().then(async () => {
      try {
        while (!this.#stopped) {
          const publication = this.#pending.shift();
          if (publication === undefined) break;
          await publication.operation();
        }
      } catch {
        this.fail("delivery");
      } finally {
        this.#running = undefined;
      }
    });
  }

  fail(reason: PublicationFailure): void {
    if (this.#stopped) return;
    this.stop();
    this.#onFailure(reason);
  }
}
