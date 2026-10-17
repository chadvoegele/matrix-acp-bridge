import type { AcpActivity, AcpThoughtActivity, AcpToolActivity } from "./acp-activity.js";
import type { OutputSink } from "./output-sink.js";
import type { TextSnapshot } from "./text-collector.js";

export interface ActivityCard {
  readonly events: readonly AcpActivity[];
  readonly collapsed: boolean;
}

export interface ActivityCardLimits {
  readonly maxEvents: number;
  readonly maxMessageBytes: number;
  readonly measure: (card: ActivityCard) => number;
}

interface CardEntry {
  readonly id: string;
  readonly card: CardState;
  content: AcpActivity;
  finished: boolean;
}

interface CardState {
  readonly id: string;
  readonly entries: CardEntry[];
  collapsed: boolean;
  published: boolean;
}

interface ActivityCardCollectorOptions {
  readonly limits: ActivityCardLimits;
  readonly maxRetainedEvents: number;
  readonly sink: OutputSink<ActivityCard>;
  readonly onCapacity: () => void;
}

/** Structured composition and entry lifetime; no Matrix identity or publication timers. */
export class ActivityCardCollector {
  readonly #options: ActivityCardCollectorOptions;

  readonly #cards = new Set<CardState>();

  readonly #thoughts = new Map<string, CardEntry>();

  readonly #tools = new Map<string, CardEntry>();

  #current: CardState | undefined;

  #sequence = 0;

  #closed = false;

  constructor(options: ActivityCardCollectorOptions) {
    if (!Number.isSafeInteger(options.maxRetainedEvents) || options.maxRetainedEvents < 1)
      throw new RangeError("maxRetainedEvents must be a positive integer");
    this.#options = options;
  }

  get retainedEvents(): number {
    return this.#thoughts.size + this.#tools.size;
  }

  get retainedCards(): number {
    return this.#cards.size;
  }

  openThought(id: string): void {
    if (this.#closed || this.#thoughts.has(id)) return;
    this.#add(this.#thoughts, id, { type: "thought", text: "", cut: false });
  }

  flushThought(id: string, content: TextSnapshot): void {
    if (this.#closed) return;
    this.openThought(id);
    const entry = this.#thoughts.get(id);
    if (entry === undefined) return;
    const thought: AcpThoughtActivity = { type: "thought", text: content.text, cut: content.cut };
    entry.content = thought;
    this.#emit(entry.card);
  }

  finishThought(id: string): void {
    this.#finish(this.#thoughts, id);
  }

  flushTool(id: string, content: AcpToolActivity): void {
    if (this.#closed) return;
    const entry = this.#tools.get(id) ?? this.#add(this.#tools, id, content);
    if (entry === undefined) return;
    entry.content = content;
    this.#emit(entry.card);
  }

  finishTool(id: string): void {
    this.#finish(this.#tools, id);
  }

  collapse(): void {
    if (this.#closed) return;
    for (const card of this.#cards) this.#collapse(card);
    this.#current = undefined;
  }

  close(): void {
    this.#closed = true;
    this.#cards.clear();
    this.#thoughts.clear();
    this.#tools.clear();
    this.#current = undefined;
  }

  #add(index: Map<string, CardEntry>, id: string, content: AcpActivity): CardEntry | undefined {
    if (this.retainedEvents >= this.#options.maxRetainedEvents) {
      this.#options.onCapacity();
      return;
    }
    let card = this.#current;
    if (card !== undefined) {
      const events = [...card.entries.map((entry) => entry.content), content];
      if (
        card.entries.length >= this.#options.limits.maxEvents ||
        (events.length > 1 &&
          this.#options.limits.measure({ events, collapsed: false }) > this.#options.limits.maxMessageBytes)
      ) {
        this.#collapse(card);
        card = undefined;
      }
    }
    if (card === undefined) {
      card = { id: `card-${this.#sequence++}`, entries: [], collapsed: false, published: false };
      this.#cards.add(card);
      this.#current = card;
    }
    const entry: CardEntry = { id, card, content, finished: false };
    card.entries.push(entry);
    index.set(id, entry);
    return entry;
  }

  #finish(index: Map<string, CardEntry>, id: string): void {
    if (this.#closed) return;
    const entry = index.get(id);
    if (entry === undefined) return;
    entry.finished = true;
    this.#release(entry.card);
  }

  #collapse(card: CardState): void {
    if (card.collapsed) return;
    card.collapsed = true;
    this.#emit(card);
    this.#release(card);
  }

  #emit(card: CardState): void {
    const events = card.entries
      .map((entry) => entry.content)
      .filter((event) => event.type === "tool" || event.text.trim().length > 0);
    if (events.length === 0) return;
    if (!card.published) {
      card.published = true;
      this.#options.sink.flush(card.id, { events, collapsed: false });
    } else if (!card.collapsed) this.#options.sink.flush(card.id, { events, collapsed: false });
    if (card.collapsed) this.#options.sink.flush(card.id, { events, collapsed: true });
  }

  #release(card: CardState): void {
    if (!card.collapsed || card.entries.some((entry) => !entry.finished)) return;
    this.#options.sink.finish(card.id);
    for (const entry of card.entries) {
      (entry.content.type === "thought" ? this.#thoughts : this.#tools).delete(entry.id);
    }
    this.#cards.delete(card);
    if (this.#current === card) this.#current = undefined;
  }
}
