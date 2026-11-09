import { systemClock, type Clock } from "./clock.js";
import type { MatrixEventId } from "./matrix-client.js";
import { matrixHtml } from "./matrix-html.js";
import {
  matrixHtmlContentBytes,
  matrixHtmlEditContentBytes,
  type MatrixHtmlBody,
  type MatrixOutputRouting,
} from "./matrix-message-content.js";
import { renderMatrixTextChunks } from "./matrix-text-rendering.js";
import type { OutputSink } from "./output-sink.js";

export type PublicationFailure = "delivery";

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
  readonly parts: readonly MatrixHtmlBody[];
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
  readonly clock?: Clock;
  readonly onCapacity?: (phase: "dropping" | "recovered", dropped: number, maximumPending: number) => void;
}

export class ConversationPublication {
  readonly #options: ConversationPublicationOptions;

  readonly #pending: Publication[] = [];

  readonly #live = { text: new Map<string, LiveOutput>(), activity: new Map<string, LiveOutput>() };

  #running: Promise<void> | undefined;

  #stopped = false;

  #active: LiveOutput | undefined;

  #episode: { recoveredAt: number | undefined; dropped: number; notified: boolean } | undefined;

  readonly #stopListeners = new Set<() => void>();

  readonly messages: OutputSink<readonly MatrixHtmlBody[]>;

  readonly cards: OutputSink<readonly MatrixHtmlBody[]>;

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
        this.#enqueue({ emitter, id, state, parts, initial: true });
        return;
      }
    }
    if (state.finishing) throw new Error(`cannot flush finished ${emitter} output before accepted content drains`);
    this.#enqueue({ emitter, id, state, parts, initial: false });
  }

  #finish(emitter: Emitter, id: string): void {
    if (this.#stopped) return;
    const state = this.#live[emitter].get(id);
    if (state === undefined || state.finishing) return;
    state.finishing = true;
    this.#releaseFinished(emitter, id, state);
  }

  #enqueue(publication: Publication): void {
    const existingIndex = this.#pending.findIndex((pending) => pending.state === publication.state && !pending.initial);
    if (!publication.initial && existingIndex !== -1) {
      this.#pending[existingIndex] = publication;
      return;
    }
    if (this.#pending.length >= this.#options.maximumPending) {
      if (publication.state.parts.length === 0 && !this.#hasAcceptedOutput(publication.state))
        this.#live[publication.emitter].delete(publication.id);
      this.shed();
      return;
    }
    this.#pending.push(publication);
    this.#start();
  }

  #hasAcceptedOutput(state: LiveOutput): boolean {
    return this.#active === state || this.#pending.some((pending) => pending.state === state);
  }

  #releaseFinished(emitter: Emitter, id: string, state: LiveOutput): void {
    if (state.finishing && !this.#hasAcceptedOutput(state)) this.#live[emitter].delete(id);
  }

  /** Retained collector pressure shares the same bounded notice episode. */
  shed(): void {
    if (this.#stopped) return;
    const noticeCooldownMs = 30_000;
    const now = (this.#options.clock ?? systemClock).now();
    if (
      this.#episode === undefined ||
      (this.#episode.recoveredAt !== undefined && now - this.#episode.recoveredAt >= noticeCooldownMs)
    ) {
      this.#episode = { recoveredAt: undefined, dropped: 0, notified: false };
      this.#options.onCapacity?.("dropping", 1, this.#options.maximumPending);
    }
    this.#episode.dropped = Math.min(Number.MAX_SAFE_INTEGER, this.#episode.dropped + 1);
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
    this.#episode = undefined;
    this.#active = undefined;
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
        await this.#drain();
        this.#reportRecovery();
      } catch {
        this.fail("delivery");
      } finally {
        this.#running = undefined;
        if (!this.#stopped && (this.#pending.length > 0 || this.#episode?.notified === false)) this.#start();
      }
    });
  }

  async #drain(): Promise<void> {
    while (!this.#stopped) {
      const publication = this.#pending.shift();
      if (publication === undefined) {
        const episode = this.#episode;
        if (episode === undefined || episode.notified) return;
        episode.notified = true;
        await this.#deliver(this.#createCapacityNotice());
        continue;
      }
      this.#active = publication.state;
      await this.#deliver(publication);
      this.#active = undefined;
      this.#releaseFinished(publication.emitter, publication.id, publication.state);
    }
  }

  #createCapacityNotice(): Publication {
    const notice = "Agent output exceeded capacity. Dropping messages to Matrix until capacity is available.";
    return {
      emitter: "text",
      id: "capacity-notice",
      initial: false,
      state: { parts: [], finishing: true },
      parts: renderMatrixTextChunks(notice, this.#options.maxMatrixMessageBytes, (part) =>
        matrixHtmlEditContentBytes({ ...part, ...this.#options.routing }),
      ),
    };
  }

  #reportRecovery(): void {
    if (
      this.#stopped ||
      this.#pending.length > 0 ||
      this.#episode === undefined ||
      this.#episode.recoveredAt !== undefined
    )
      return;
    this.#episode.recoveredAt = (this.#options.clock ?? systemClock).now();
    this.#options.onCapacity?.("recovered", this.#episode.dropped, this.#options.maximumPending);
  }

  async #deliver({ emitter, id, state, parts }: Publication): Promise<void> {
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
