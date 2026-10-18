import { takeBytes } from "./bounded-text.js";
import type { Clock } from "./clock.js";
import type { AgentTextSettings } from "./config.js";
import type { OutputSink } from "./output-sink.js";
import { PublicationScheduler } from "./publication-scheduler.js";
import { OUTPUT_TRUNCATION_MARKER } from "./response-rendering.js";

export interface TextSnapshot {
  readonly text: string;
  readonly cut: boolean;
}

interface TextCollectorOptions {
  readonly settings: AgentTextSettings;
  readonly maxOutputBytes: number;
  readonly sink: OutputSink<TextSnapshot>;
  readonly clock?: Clock;
}

/** One bounded response. Messages and thoughts use separate instances. */
export class TextCollector {
  readonly #options: TextCollectorOptions;

  readonly #scheduler: PublicationScheduler;

  #id: string | undefined;

  #text = "";

  #cut = false;

  #stopped = false;

  constructor(options: TextCollectorOptions) {
    if (
      !Number.isSafeInteger(options.maxOutputBytes) ||
      options.maxOutputBytes < Buffer.byteLength(OUTPUT_TRUNCATION_MARKER)
    )
      throw new RangeError("maxOutputBytes cannot fit the truncation marker");
    this.#options = options;
    this.#scheduler = new PublicationScheduler(options.settings, () => this.#emit(), options.clock);
  }

  get hasPendingText(): boolean {
    return this.#scheduler.dirty;
  }

  append(id: string, delta: string, cut = false): boolean {
    if (this.#stopped) return false;
    if (id.length === 0) throw new TypeError("text ID must be nonempty");
    if (this.#id !== id) {
      this.finish();
      if (this.#stopped) return false;
      this.#id = id;
    }
    if ((delta.length === 0 && !cut) || this.#cut) return true;
    const addition = takeBytes(delta, this.#options.maxOutputBytes - Buffer.byteLength(this.#text));
    this.#text += addition.text;
    this.#cut = addition.cut || cut;
    if (this.#cut) {
      this.#text =
        takeBytes(this.#text, this.#options.maxOutputBytes - Buffer.byteLength(OUTPUT_TRUNCATION_MARKER)).text +
        OUTPUT_TRUNCATION_MARKER;
    }
    this.#scheduler.change(
      Buffer.byteLength(addition.text) + (this.#cut ? Buffer.byteLength(OUTPUT_TRUNCATION_MARKER) : 0),
    );
    return !this.#stopped;
  }

  flush(id = this.#id): void {
    if (id !== undefined && id === this.#id) this.#scheduler.flush();
  }

  finish(id = this.#id): void {
    if (id === undefined || id !== this.#id || this.#stopped) return;
    this.flush(id);
    this.#options.sink.finish(id);
    this.#scheduler.stop();
    this.#id = undefined;
    this.#text = "";
    this.#cut = false;
  }

  stop(): void {
    this.#stopped = true;
    this.#scheduler.stop();
    this.#id = undefined;
    this.#text = "";
  }

  #emit(): void {
    if (this.#id !== undefined && !this.#stopped && this.#text.length > 0)
      this.#options.sink.flush(this.#id, { text: this.#text, cut: this.#cut });
  }
}
