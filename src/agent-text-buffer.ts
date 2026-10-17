import { takeBytes } from "./bounded-text.js";
import { systemClock, type Clock, type TimerHandle } from "./clock.js";
import { validateAgentTextSettings, type AgentTextSettings } from "./config.js";
import { ConversationPublication } from "./conversation-publication.js";
import type { MatrixEventId } from "./matrix-client.js";
import { matrixHtml } from "./matrix-html.js";
import {
  matrixHtmlContentBytes,
  matrixHtmlEditContentBytes,
  type MatrixHtmlBody,
  type MatrixOutputRouting,
} from "./matrix-message-content.js";
import { renderMatrixTextChunks } from "./matrix-text-rendering.js";
import { OUTPUT_TRUNCATION_MARKER } from "./response-rendering.js";

interface PublishedPart {
  readonly eventId: MatrixEventId;
  readonly rendered: MatrixHtmlBody;
}

interface TextBlock {
  readonly messageId: string;
  text: string;
  truncated: boolean;
  unpublishedBytes: number;
  firstDirtyAt: number | undefined;
  lastChunkAt: number;
  lastFlushAt: number | undefined;
  timer: TimerHandle;
  parts: PublishedPart[];
}

export interface AgentTextPublication extends MatrixHtmlBody {
  readonly messageId: string;
  readonly partIndex: number;
  readonly targetEventId?: MatrixEventId;
}

interface AgentTextBufferOptions {
  readonly settings: AgentTextSettings;
  readonly maxOutputBytes: number;
  readonly maxMatrixMessageBytes: number;
  readonly queue: ConversationPublication;
  /** Use MatrixDelivery.sendLive here; this component never owns transport retries. */
  readonly publish: (publication: AgentTextPublication) => Promise<MatrixEventId | undefined>;
  readonly routing?: MatrixOutputRouting;
  readonly clock?: Clock;
}

/** Owns just the current identified assistant message for one live session. */
export class AgentTextBuffer {
  readonly #options: AgentTextBufferOptions;

  readonly #clock: Clock;

  #current: TextBlock | undefined;

  #stopped = false;

  #unsubscribe: (() => void) | undefined;

  constructor(options: AgentTextBufferOptions) {
    validateAgentTextSettings(options.settings);
    if (
      !Number.isSafeInteger(options.maxOutputBytes) ||
      options.maxOutputBytes < Buffer.byteLength(OUTPUT_TRUNCATION_MARKER)
    ) {
      throw new RangeError("maxOutputBytes cannot fit the truncation marker");
    }
    if (!Number.isSafeInteger(options.maxMatrixMessageBytes) || options.maxMatrixMessageBytes < 1) {
      throw new RangeError("maxMatrixMessageBytes must be a positive integer");
    }
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#unsubscribe = options.queue.onStop(() => this.stop());
  }

  /** False means intake must stop; no rejected delta may be reported as delivered. */
  append(messageId: string, delta: string): boolean {
    if (this.#stopped || this.#options.queue.stopped) return false;
    if (messageId.length === 0) throw new TypeError("assistant message ID must be nonempty");
    if (this.#current?.messageId !== messageId) {
      this.#retireCurrent();
      if (this.#options.queue.stopped) {
        this.stop();
        return false;
      }
      this.#current = {
        messageId,
        text: "",
        truncated: false,
        unpublishedBytes: 0,
        firstDirtyAt: undefined,
        lastChunkAt: this.#clock.now(),
        lastFlushAt: undefined,
        timer: undefined,
        parts: [],
      };
    }
    const block = this.#current;
    if (delta.length === 0) return true;
    if (block.truncated) return true;
    const previousBytes = Buffer.byteLength(block.text);
    const available = this.#options.maxOutputBytes - previousBytes;
    const addition = takeBytes(delta, available);
    block.text += addition.text;
    if (addition.cut) {
      const prefix = takeBytes(block.text, this.#options.maxOutputBytes - Buffer.byteLength(OUTPUT_TRUNCATION_MARKER));
      block.text = prefix.text + OUTPUT_TRUNCATION_MARKER;
      block.truncated = true;
    }
    block.unpublishedBytes +=
      Buffer.byteLength(addition.text) + (addition.cut ? Buffer.byteLength(OUTPUT_TRUNCATION_MARKER) : 0);
    block.firstDirtyAt ??= this.#clock.now();
    block.lastChunkAt = this.#clock.now();
    this.#schedule(block);
    return !this.#options.queue.stopped;
  }

  /** Activity flushes without changing message identity. Enqueue activity after this call. */
  flush(): boolean {
    if (this.#current !== undefined) this.#requestFlush(this.#current);
    return !this.#stopped && !this.#options.queue.stopped;
  }

  get hasPendingText(): boolean {
    return this.#current?.firstDirtyAt !== undefined || this.#options.queue.pendingCount > 0;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#current !== undefined) this.#clearTimer(this.#current);
    this.#current = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  #retireCurrent(): void {
    const block = this.#current;
    if (block === undefined || block.text.length === 0) return;
    this.#requestFlush(block);
    this.#clearTimer(block);
    // A final queue entry releases mappings only after earlier publication completes.
    this.#options.queue.enqueue(block, async () => {
      await this.#publish(block);
      block.text = "";
      block.parts = [];
    });
  }

  #schedule(block: TextBlock): void {
    this.#clearTimer(block);
    const settings = this.#options.settings;
    const now = this.#clock.now();
    const pacedAt = block.lastFlushAt === undefined ? now : block.lastFlushAt + settings.agentTextQuietMs;
    const quietAt = block.lastChunkAt + settings.agentTextQuietMs;
    const maximumAt = block.firstDirtyAt! + settings.agentTextMaxIntervalMs;
    const sizeAt = block.unpublishedBytes >= settings.agentTextFlushBytes ? pacedAt : Number.POSITIVE_INFINITY;
    const dueAt = Math.max(pacedAt, Math.min(quietAt, maximumAt, sizeAt));
    if (dueAt <= now) {
      this.#requestFlush(block);
      return;
    }
    block.timer = this.#clock.setTimeout(() => {
      block.timer = undefined;
      this.#requestFlush(block);
    }, dueAt - now);
  }

  #requestFlush(block: TextBlock): void {
    this.#clearTimer(block);
    if (this.#stopped || block.firstDirtyAt === undefined) return;
    block.firstDirtyAt = undefined;
    block.unpublishedBytes = 0;
    block.lastFlushAt = this.#clock.now();
    if (!this.#options.queue.enqueue(block, () => this.#publish(block))) this.stop();
  }

  #clearTimer(block: TextBlock): void {
    if (block.timer !== undefined) this.#clock.clearTimeout(block.timer);
    block.timer = undefined;
  }

  async #publish(block: TextBlock): Promise<void> {
    if (this.#stopped || this.#options.queue.stopped) return;
    const routing = this.#options.routing ?? {};
    const chunks = renderMatrixTextChunks(block.text, this.#options.maxMatrixMessageBytes, (rendered) =>
      matrixHtmlEditContentBytes({ ...rendered, ...routing }),
    );
    // Repacking Markdown can reduce the number of parts. Clear existing surplus
    // events with replacements; never create an empty placeholder event.
    const count = Math.max(chunks.length, block.parts.length);
    for (let index = 0; index < count; index++) {
      if (this.#stopped || this.#options.queue.stopped) return;
      const rendered = chunks[index] ?? { body: "", formattedBody: matrixHtml`<p></p>` };
      const previous = block.parts[index];
      if (previous?.rendered.body === rendered.body && previous.rendered.formattedBody === rendered.formattedBody)
        continue;
      if (
        matrixHtmlContentBytes({ ...rendered, ...routing }, previous?.eventId) > this.#options.maxMatrixMessageBytes
      ) {
        throw new RangeError("agent text exceeds Matrix event size");
      }
      const eventId = await this.#options.publish({
        ...rendered,
        messageId: block.messageId,
        partIndex: index,
        ...(previous === undefined ? {} : { targetEventId: previous.eventId }),
      });
      if (eventId === undefined) throw new Error("agent text publication failed");
      block.parts[index] = { eventId: previous?.eventId ?? eventId, rendered };
    }
  }
}
