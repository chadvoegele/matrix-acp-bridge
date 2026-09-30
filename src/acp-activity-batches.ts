import type { AcpActivity } from "./acp-activity.js";
import { renderAcpActivity, type RenderedAcpActivity } from "./acp-activity-rendering.js";

export interface ActivityBatch {
  readonly index: number;
  readonly events: readonly AcpActivity[];
  readonly collapsed: boolean;
}

interface MutableActivityBatch extends ActivityBatch {
  readonly events: AcpActivity[];
  collapsed: boolean;
}

export interface ActivityBatchLimits {
  readonly maxEvents: number;
  readonly maxMessageBytes: number;
  readonly measure: (rendered: RenderedAcpActivity) => number;
}

/** Groups activity for presentation; delivery state belongs to the caller. */
export class AcpActivityBatches {
  readonly #batches: MutableActivityBatch[] = [];
  readonly #eventBatches = new WeakMap<AcpActivity, MutableActivityBatch>();
  #current: MutableActivityBatch | undefined;

  constructor(readonly limits: ActivityBatchLimits) {}

  accept(activity: AcpActivity): readonly ActivityBatch[] {
    const existing = this.#eventBatches.get(activity);
    if (existing !== undefined) return [existing];
    const changed: ActivityBatch[] = [];
    let batch = this.#current;
    if (batch !== undefined && batch.events.length >= this.limits.maxEvents) {
      this.#collapse(batch, changed);
      batch = undefined;
    }
    batch ??= this.#start(changed);
    batch.events.push(activity);
    if (batch.events.length > 1 && this.limits.measure(this.render(batch)) > this.limits.maxMessageBytes) {
      batch.events.pop();
      this.#collapse(batch, changed);
      batch = this.#start(changed);
      batch.events.push(activity);
    }
    this.#eventBatches.set(activity, batch);
    changed.push(batch);
    return changed;
  }

  collapse(): readonly ActivityBatch[] {
    const changed: ActivityBatch[] = [];
    for (const batch of this.#batches) this.#collapse(batch, changed);
    this.#current = undefined;
    return changed;
  }

  render(batch: ActivityBatch): RenderedAcpActivity {
    const wrapperStart = batch.collapsed ? `<details><summary>Past agent events (${batch.events.length})</summary>` : "";
    const wrapperEnd = batch.collapsed ? "</details>" : "";
    let budget = Math.max(64, Math.floor(this.limits.maxMessageBytes / batch.events.length));
    for (;;) {
      const entries = batch.events.map((event) => renderAcpActivity(event, budget));
      const body = entries.map((entry) => entry.body).join("\n");
      const formattedBody = `${wrapperStart}${entries.map((entry) => entry.formattedBody).join("\n")}${wrapperEnd}`;
      const rendered = { body, formattedBody };
      if (this.limits.measure(rendered) <= this.limits.maxMessageBytes || budget <= 16) return rendered;
      budget = Math.max(16, Math.floor(budget * 0.7));
    }
  }

  #collapse(batch: MutableActivityBatch, changed: ActivityBatch[]): void {
    if (batch.collapsed) return;
    batch.collapsed = true;
    changed.push(batch);
  }

  #start(changed: ActivityBatch[]): MutableActivityBatch {
    const previous = this.#batches.at(-1);
    if (previous !== undefined) this.#collapse(previous, changed);
    const batch: MutableActivityBatch = { index: this.#batches.length, events: [], collapsed: false };
    this.#batches.push(batch);
    this.#current = batch;
    return batch;
  }
}
