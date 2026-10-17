import type { ConversationPublication } from "./conversation-publication.js";
import type { MatrixEventId } from "./matrix-client.js";
import { matrixHtml } from "./matrix-html.js";
import { matrixHtmlContentBytes, type MatrixHtmlBody, type MatrixOutputRouting } from "./matrix-message-content.js";
import type { OutputSink } from "./output-sink.js";

interface PublishedPart {
  readonly eventId: MatrixEventId;
  readonly rendered: MatrixHtmlBody;
}

interface PendingOutput {
  parts: readonly MatrixHtmlBody[] | undefined;
  finish: boolean;
}

interface LiveOutput {
  readonly parts: PublishedPart[];
  pending: PendingOutput | undefined;
  finishing: boolean;
}

export interface MatrixOutputPublication extends MatrixHtmlBody {
  readonly id: string;
  readonly partIndex: number;
  readonly targetEventId?: MatrixEventId;
}

interface MatrixOutputSenderOptions {
  readonly queue: ConversationPublication;
  readonly maxMatrixMessageBytes: number;
  readonly routing?: MatrixOutputRouting;
  readonly preserveFirstFlush?: boolean;
  readonly publish: (publication: MatrixOutputPublication) => Promise<MatrixEventId | undefined>;
}

/** One emitter subscription and ID namespace; MatrixDelivery owns transport retries. */
export class MatrixOutputSender implements OutputSink<readonly MatrixHtmlBody[]> {
  readonly #options: MatrixOutputSenderOptions;

  readonly #live = new Map<string, LiveOutput>();

  #stopped = false;

  constructor(options: MatrixOutputSenderOptions) {
    if (!Number.isSafeInteger(options.maxMatrixMessageBytes) || options.maxMatrixMessageBytes < 1)
      throw new RangeError("maxMatrixMessageBytes must be a positive integer");
    this.#options = options;
    options.queue.onStop(() => {
      this.#stopped = true;
      this.#live.clear();
    });
  }

  get liveCount(): number {
    return this.#live.size;
  }

  flush(id: string, parts: readonly MatrixHtmlBody[]): void {
    if (this.#stopped || parts.length === 0) return;
    let state = this.#live.get(id);
    if (state === undefined) {
      state = { parts: [], pending: undefined, finishing: false };
      this.#live.set(id, state);
      if (this.#options.preserveFirstFlush) {
        const initial = state;
        this.#options.queue.enqueue({}, () => this.#deliver(id, initial, parts));
        return;
      }
    }
    if (state.finishing) throw new Error("cannot flush finished output");
    this.#enqueue(id, state, parts, false);
  }

  finish(id: string): void {
    if (this.#stopped) return;
    const state = this.#live.get(id);
    if (state === undefined || state.finishing) return;
    state.finishing = true;
    this.#enqueue(id, state, state.pending?.parts, true);
  }

  #enqueue(id: string, state: LiveOutput, parts: readonly MatrixHtmlBody[] | undefined, finish: boolean): void {
    const pending = state.pending ?? { parts: undefined, finish: false };
    pending.parts = parts;
    pending.finish ||= finish;
    state.pending = pending;
    this.#options.queue.enqueue(state, async () => {
      state.pending = undefined;
      if (pending.parts !== undefined) await this.#deliver(id, state, pending.parts);
      if (pending.finish) this.#live.delete(id);
    });
  }

  async #deliver(id: string, state: LiveOutput, parts: readonly MatrixHtmlBody[]): Promise<void> {
    const routing = this.#options.routing ?? {};
    const count = Math.max(parts.length, state.parts.length);
    for (let index = 0; index < count; index++) {
      if (this.#stopped) return;
      const rendered = parts[index] ?? { body: "", formattedBody: matrixHtml`<p></p>` };
      const previous = state.parts[index];
      if (previous?.rendered.body === rendered.body && previous.rendered.formattedBody === rendered.formattedBody)
        continue;
      if (matrixHtmlContentBytes({ ...rendered, ...routing }, previous?.eventId) > this.#options.maxMatrixMessageBytes)
        throw new RangeError("output exceeds Matrix event size");
      const eventId = await this.#options.publish({
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
}
