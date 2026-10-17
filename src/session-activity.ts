import { AcpActivityModel, isActiveTool } from "./acp-activity.js";
import { AcpActivityBatches, type ActivityBatch, type ActivityBatchLimits } from "./acp-activity-batches.js";
import type { AcpUpdate } from "./acp-activity-update.js";
import type { RenderedAcpActivity } from "./acp-activity-rendering.js";
import type { ConversationPublication } from "./conversation-publication.js";

interface BatchDelivery {
  eventId: string | undefined;
  pending: boolean;
  dirty: boolean;
}

interface SessionActivityOptions {
  readonly queue: ConversationPublication;
  readonly limits: ActivityBatchLimits;
  readonly maxRetainedEvents: number;
  readonly publish: (rendered: RenderedAcpActivity, targetEventId?: string) => Promise<string | undefined>;
  readonly onAbandoned: (reason: "capacity" | "delivery" | "lifecycle") => void;
}

/** Session ownership is independent of prompt completion and assistant text identity. */
export class SessionActivity {
  readonly #model = new AcpActivityModel();

  readonly #batches: AcpActivityBatches;

  readonly #deliveries = new Map<ActivityBatch, BatchDelivery>();

  #closed = false;

  constructor(readonly options: SessionActivityOptions) {
    this.#batches = new AcpActivityBatches(options.limits);
    options.queue.onStop(() => this.close());
  }

  get retainedEvents(): number {
    return this.#model.events.length;
  }

  get retainedBatches(): number {
    return this.#batches.retainedCount;
  }

  accept(update: AcpUpdate): void {
    if (this.#closed) return;
    const activity = this.#model.accept(update);
    if (update.kind === "agent_message_chunk" && update.text.trim()) {
      for (const batch of this.#batches.collapse()) this.#schedule(batch);
    }
    if (activity === undefined) return;
    if (this.retainedEvents > this.options.maxRetainedEvents) {
      this.options.onAbandoned("capacity");
      this.options.queue.stop();
      return;
    }
    for (const batch of this.#batches.accept(activity)) this.#schedule(batch);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (
      this.#model.events.some((event) => isActiveTool(event)) ||
      [...this.#deliveries.values()].some((delivery) => delivery.pending)
    )
      this.options.onAbandoned("lifecycle");
    this.#model.close();
    this.#batches.clear();
    this.#deliveries.clear();
  }

  #schedule(batch: ActivityBatch): void {
    let state = this.#deliveries.get(batch);
    if (state === undefined) {
      state = { eventId: undefined, pending: false, dirty: false };
      this.#deliveries.set(batch, state);
    }
    state.dirty = true;
    if (state.pending) return;
    state.pending = true;
    const delivery = state;
    // The original must show the expanded view even if text collapses it before delivery.
    const initial = delivery.eventId === undefined ? this.#batches.render(batch) : undefined;
    this.options.queue.enqueue(batch, async () => {
      let published = false;
      try {
        let first = initial;
        while (delivery.dirty && !this.#closed) {
          delivery.dirty = false;
          const rendered = first ?? this.#batches.render(batch);
          first = undefined;
          const id = await this.options.publish(rendered, delivery.eventId);
          if (this.#closed) return;
          if (id === undefined) {
            this.options.onAbandoned("delivery");
            this.options.queue.stop();
            return;
          }
          delivery.eventId = id;
          if (rendered === initial) {
            const current = this.#batches.render(batch);
            delivery.dirty ||= current.body !== rendered.body || current.formattedBody !== rendered.formattedBody;
          }
        }
        published = true;
      } catch (error) {
        this.options.onAbandoned("delivery");
        throw error;
      } finally {
        delivery.pending = false;
        if (
          published &&
          !this.#closed &&
          !delivery.dirty &&
          batch.collapsed &&
          !batch.events.some((event) => isActiveTool(event))
        ) {
          this.#model.release(batch.events);
          this.#batches.release(batch);
          this.#deliveries.delete(batch);
        }
      }
    });
  }
}
