import { AcpToolModel, type AcpToolActivity } from "./acp-activity.js";
import type { AcpToolCallUpdate } from "./acp-activity-update.js";
import type { Clock } from "./clock.js";
import type { AgentTextSettings } from "./config.js";
import type { OutputSink } from "./output-sink.js";
import { PublicationScheduler } from "./publication-scheduler.js";

interface ToolCollectorOptions {
  readonly settings: AgentTextSettings;
  readonly sink: OutputSink<AcpToolActivity>;
  readonly maxRetainedEvents: number;
  readonly onCapacity: () => void;
  readonly clock?: Clock;
}

interface ToolState {
  readonly id: string;
  readonly scheduler: PublicationScheduler;
}

/** Concurrent patch streams, each independently paced and explicitly terminal. */
export class ToolCollector {
  readonly #model = new AcpToolModel();

  readonly #states = new Map<AcpToolActivity, ToolState>();

  readonly #options: ToolCollectorOptions;

  #sequence = 0;

  #stopped = false;

  constructor(options: ToolCollectorOptions) {
    this.#options = options;
  }

  get activeCount(): number {
    return this.#states.size;
  }

  accept(update: AcpToolCallUpdate): void {
    if (this.#stopped) return;
    const event = this.#model.accept(update);
    if (event === undefined) return;
    let state = this.#states.get(event);
    const started = state === undefined;
    if (state === undefined) {
      if (this.#states.size >= this.#options.maxRetainedEvents) {
        this.#options.onCapacity();
        return;
      }
      const id = event.toolCallId ?? `anonymous-tool-${this.#sequence++}`;
      const scheduler = new PublicationScheduler(
        this.#options.settings,
        () => this.#options.sink.flush(id, { ...event }),
        this.#options.clock,
      );
      state = { id, scheduler };
      this.#states.set(event, state);
    }
    const terminal = event.status === "completed" || event.status === "failed";
    const bytes =
      Buffer.byteLength(update.terminalOutput?.data ?? "") + Buffer.byteLength(JSON.stringify(update.content ?? []));
    state.scheduler.change(bytes);
    if (started || terminal) state.scheduler.flush();
    if (!terminal) return;
    state.scheduler.stop();
    this.#options.sink.finish(state.id);
    this.#states.delete(event);
    this.#model.release([event]);
  }

  stop(): void {
    this.#stopped = true;
    for (const state of this.#states.values()) state.scheduler.stop();
    this.#states.clear();
    this.#model.close();
  }
}
