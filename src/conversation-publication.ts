import type { MatrixEventId } from "./matrix-client.js";
import { matrixHtml } from "./matrix-html.js";
import { matrixHtmlContentBytes, type MatrixHtmlBody, type MatrixOutputRouting } from "./matrix-message-content.js";
import type { OutputSink } from "./output-sink.js";

export type PublicationFailure = "capacity" | "delivery";

type Emitter = "text" | "activity";

interface PublishedPart {
  readonly eventId: MatrixEventId;
  readonly rendered: MatrixHtmlBody;
}

interface LiveOutput {
  readonly parts: PublishedPart[];
  finishing: boolean;
}

interface Publication {
  readonly emitter: Emitter;
  readonly id: string;
  readonly state: LiveOutput;
  readonly initial: boolean;
  parts: readonly MatrixHtmlBody[] | undefined;
  finish: boolean;
}

export interface MatrixOutputPublication extends MatrixHtmlBody {
  readonly id: string;
  readonly partIndex: number;
  readonly targetEventId?: MatrixEventId;
}

interface ConversationPublicationOptions {
  readonly maximumPending: number;
  readonly maxMatrixMessageBytes: number;
  readonly routing?: MatrixOutputRouting;
  readonly publish: (emitter: Emitter, publication: MatrixOutputPublication) => Promise<MatrixEventId | undefined>;
  readonly onFailure: (reason: PublicationFailure) => void;
}

/** Publishes one conversation's content; MatrixDelivery owns transport retries. */
export class ConversationPublication {
  readonly #options: ConversationPublicationOptions;

  readonly #pending: Publication[] = [];

  readonly #live = { text: new Map<string, LiveOutput>(), activity: new Map<string, LiveOutput>() };

  #running: Promise<void> | undefined;

  #stopped = false;

  readonly #stopListeners = new Set<() => void>();

  readonly messages: OutputSink<readonly MatrixHtmlBody[]>;

  readonly cards: OutputSink<readonly MatrixHtmlBody[]>;

  /** The existing conversation limit bounds pending records, plus one in flight. */
  constructor(options: ConversationPublicationOptions) {
    if (!Number.isSafeInteger(options.maximumPending) || options.maximumPending < 1)
      throw new RangeError("maximumPending must be a positive integer");
    if (!Number.isSafeInteger(options.maxMatrixMessageBytes) || options.maxMatrixMessageBytes < 1)
      throw new RangeError("maxMatrixMessageBytes must be a positive integer");
    this.#options = options;
    this.messages = this.#bind("text");
    this.cards = this.#bind("activity");
  }

  get pendingCount(): number {
    return this.#pending.length + (this.#running === undefined ? 0 : 1);
  }

  get liveCount(): number {
    return this.#live.text.size + this.#live.activity.size;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  #bind(emitter: Emitter): OutputSink<readonly MatrixHtmlBody[]> {
    return {
      flush: (id, parts) => this.#flush(emitter, id, parts),
      finish: (id) => this.#finish(emitter, id),
    };
  }

  #flush(emitter: Emitter, id: string, parts: readonly MatrixHtmlBody[]): void {
    if (this.#stopped) return;
    let state = this.#live[emitter].get(id);
    if (state === undefined) {
      if (!parts.some((part) => part.body.length > 0)) return;
      state = { parts: [], finishing: false };
      this.#live[emitter].set(id, state);
      if (emitter === "activity") {
        this.#enqueue({ emitter, id, state, parts, initial: true, finish: false });
        return;
      }
    }
    if (state.finishing) throw new Error("cannot flush finished output");
    this.#enqueue({ emitter, id, state, parts, initial: false, finish: false });
  }

  #finish(emitter: Emitter, id: string): void {
    if (this.#stopped) return;
    const state = this.#live[emitter].get(id);
    if (state === undefined || state.finishing) return;
    state.finishing = true;
    this.#enqueue({ emitter, id, state, parts: undefined, initial: false, finish: true });
  }

  #enqueue(publication: Publication): void {
    const existing = this.#pending.find((pending) => pending.state === publication.state && !pending.initial);
    if (!publication.initial && existing !== undefined) {
      if (publication.parts !== undefined) existing.parts = publication.parts;
      existing.finish ||= publication.finish;
      return;
    }
    if (this.#pending.length >= this.#options.maximumPending) {
      this.fail("capacity");
      return;
    }
    this.#pending.push(publication);
    this.#start();
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
    this.#live.text.clear();
    this.#live.activity.clear();
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
          if (publication.parts !== undefined) await this.#deliver(publication);
          if (publication.finish) this.#live[publication.emitter].delete(publication.id);
        }
      } catch {
        this.fail("delivery");
      } finally {
        this.#running = undefined;
      }
    });
  }

  async #deliver({ emitter, id, state, parts = [] }: Publication): Promise<void> {
    const routing = this.#options.routing ?? {};
    const count = Math.max(parts.length, state.parts.length);
    for (let index = 0; index < count; index++) {
      if (this.#stopped) return;
      const rendered = parts[index] ?? { body: "", formattedBody: matrixHtml`<p></p>` };
      const previous = state.parts[index];
      if (previous === undefined && rendered.body.length === 0) continue;
      if (previous?.rendered.body === rendered.body && previous.rendered.formattedBody === rendered.formattedBody)
        continue;
      if (matrixHtmlContentBytes({ ...rendered, ...routing }, previous?.eventId) > this.#options.maxMatrixMessageBytes)
        throw new RangeError("output exceeds Matrix event size");
      const eventId = await this.#options.publish(emitter, {
        ...rendered,
        id,
        partIndex: index,
        ...(previous === undefined ? {} : { targetEventId: previous.eventId }),
      });
      if (this.#stopped) return;
      if (eventId === undefined) throw new Error("output publication failed");
      state.parts[index] = { eventId: previous?.eventId ?? eventId, rendered };
    }
  }

  fail(reason: PublicationFailure): void {
    if (this.#stopped) return;
    this.stop();
    this.#options.onFailure(reason);
  }
}
