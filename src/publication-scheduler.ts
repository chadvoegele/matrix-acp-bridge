import { systemClock, type Clock, type TimerHandle } from "./clock.js";
import { validateAgentTextSettings, type AgentTextSettings } from "./config.js";

/** Shared byte/quiet/maximum-interval pacing, independent of content and transport. */
export class PublicationScheduler {
  readonly #settings: AgentTextSettings;

  readonly #clock: Clock;

  readonly #publish: () => void;

  #firstDirtyAt: number | undefined;

  #lastChangeAt = 0;

  #lastFlushAt: number | undefined;

  #bytes = 0;

  #timer: TimerHandle;

  constructor(settings: AgentTextSettings, publish: () => void, clock: Clock = systemClock) {
    validateAgentTextSettings(settings);
    this.#settings = settings;
    this.#publish = publish;
    this.#clock = clock;
  }

  get dirty(): boolean {
    return this.#firstDirtyAt !== undefined;
  }

  change(bytes: number): void {
    this.#firstDirtyAt ??= this.#clock.now();
    this.#lastChangeAt = this.#clock.now();
    this.#bytes += bytes;
    this.#clearTimer();
    const now = this.#clock.now();
    const pacedAt = this.#lastFlushAt === undefined ? now : this.#lastFlushAt + this.#settings.agentTextQuietMs;
    const quietAt = this.#lastChangeAt + this.#settings.agentTextQuietMs;
    const maximumAt = this.#firstDirtyAt + this.#settings.agentTextMaxIntervalMs;
    const sizeAt = this.#bytes >= this.#settings.agentTextFlushBytes ? pacedAt : Number.POSITIVE_INFINITY;
    const dueAt = Math.max(pacedAt, Math.min(quietAt, maximumAt, sizeAt));
    if (dueAt <= now) this.flush();
    else this.#timer = this.#clock.setTimeout(() => this.flush(), dueAt - now);
  }

  flush(): void {
    this.#clearTimer();
    if (!this.dirty) return;
    this.#firstDirtyAt = undefined;
    this.#bytes = 0;
    this.#lastFlushAt = this.#clock.now();
    this.#publish();
  }

  stop(): void {
    this.#clearTimer();
    this.#firstDirtyAt = undefined;
    this.#bytes = 0;
    this.#lastFlushAt = undefined;
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
