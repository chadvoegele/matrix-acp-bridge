import { ACTIVITY_RESULT_DETAIL_BYTES, cleanActivityText } from "./acp-activity.js";
import { renderActivityCard } from "./acp-activity-rendering.js";
import type { AcpUpdate } from "./acp-activity-update.js";
import { ActivityCardCollector } from "./activity-card-collector.js";
import type { Clock } from "./clock.js";
import type { AgentTextSettings } from "./config.js";
import type { ConversationPublication } from "./conversation-publication.js";
import { matrixHtmlEditContentBytes, type MatrixHtmlBody, type MatrixOutputRouting } from "./matrix-message-content.js";
import { MatrixOutputSender, type MatrixOutputPublication } from "./matrix-output-sender.js";
import { renderMatrixTextChunks } from "./matrix-text-rendering.js";
import { renderOutput, type OutputSink } from "./output-sink.js";
import { TextCollector, type TextSnapshot } from "./text-collector.js";
import { ToolCollector } from "./tool-collector.js";

interface SessionOutputOptions {
  readonly settings: AgentTextSettings;
  readonly maxOutputBytes: number;
  readonly maxMatrixMessageBytes: number;
  readonly maxEventsPerCard: number;
  readonly maxRetainedEvents: number;
  readonly queue: ConversationPublication;
  readonly routing?: MatrixOutputRouting;
  readonly clock?: Clock;
  readonly publish: (kind: "text" | "activity", publication: MatrixOutputPublication) => Promise<string | undefined>;
  readonly onAbandoned: (reason: "capacity" | "lifecycle") => void;
}

/** Dispatches one live session's normalized ACP stream to focused domain owners. */
export class SessionOutput {
  readonly #messages: TextCollector;

  readonly #thoughts: TextCollector;

  readonly #cards: ActivityCardCollector;

  readonly #tools: ToolCollector;

  readonly #legacyThoughts: TextCollector;

  #responseId: string | undefined;

  #hasIdentifiedThought = false;

  #legacyId: string | undefined;

  #sequence = 0;

  #closed = false;

  constructor(options: SessionOutputOptions) {
    const measure = (rendered: MatrixHtmlBody) => matrixHtmlEditContentBytes({ ...rendered, ...options.routing });
    const messageSender = new MatrixOutputSender({
      ...options,
      publish: (publication) => options.publish("text", publication),
    });
    const cardSender = new MatrixOutputSender({
      ...options,
      preserveFirstFlush: true,
      publish: (publication) => options.publish("activity", publication),
    });
    this.#cards = new ActivityCardCollector({
      limits: {
        maxEvents: options.maxEventsPerCard,
        maxMessageBytes: options.maxMatrixMessageBytes,
        measure: (card) => measure(renderActivityCard(card, Number.MAX_SAFE_INTEGER, measure)),
      },
      maxRetainedEvents: options.maxRetainedEvents,
      onCapacity: () => options.onAbandoned("capacity"),
      sink: renderOutput(
        cardSender,
        (card) => [renderActivityCard(card, options.maxMatrixMessageBytes, measure)],
        () => options.queue.fail("delivery"),
      ),
    });
    this.#messages = new TextCollector({
      ...options,
      sink: renderOutput(
        messageSender,
        (content) => renderMatrixTextChunks(content.text, options.maxMatrixMessageBytes, measure),
        () => options.queue.fail("delivery"),
      ),
    });
    this.#thoughts = new TextCollector({
      ...options,
      maxOutputBytes: Math.min(options.maxOutputBytes, ACTIVITY_RESULT_DETAIL_BYTES),
      sink: this.#createThoughtSink("identified:"),
    });
    this.#legacyThoughts = new TextCollector({
      ...options,
      maxOutputBytes: Math.min(options.maxOutputBytes, ACTIVITY_RESULT_DETAIL_BYTES),
      sink: this.#createThoughtSink("legacy:"),
    });
    this.#tools = new ToolCollector({
      ...options,
      onCapacity: () => options.onAbandoned("capacity"),
      sink: { flush: (id, content) => this.#cards.flushTool(id, content), finish: (id) => this.#cards.finishTool(id) },
    });
    options.queue.onStop(() => {
      if (
        this.#tools.activeCount > 0 ||
        this.#thoughts.hasPendingText ||
        this.#legacyThoughts.hasPendingText ||
        options.queue.pendingCount > 0
      )
        options.onAbandoned("lifecycle");
      this.#closed = true;
      this.#messages.stop();
      this.#thoughts.stop();
      this.#legacyThoughts.stop();
      this.#tools.stop();
      this.#cards.close();
    });
  }

  get retainedEvents(): number {
    return this.#cards.retainedEvents;
  }

  get retainedCards(): number {
    return this.#cards.retainedCards;
  }

  get hasPendingText(): boolean {
    return this.#messages.hasPendingText;
  }

  accept(update: AcpUpdate): void {
    if (this.#closed) return;
    if (update.kind === "tool_call" || update.kind === "tool_call_update") {
      this.#finishLegacyThought();
      this.#tools.accept(update);
      return;
    }
    if (update.kind !== "agent_message_chunk" && update.kind !== "agent_thought_chunk") return;
    if (update.messageId && update.messageId !== this.#responseId) {
      this.#messages.finish();
      this.#thoughts.finish();
      this.#hasIdentifiedThought = false;
      this.#responseId = update.messageId;
    }
    if (update.kind === "agent_message_chunk") {
      if (update.text.trim()) {
        this.#finishLegacyThought();
        this.#cards.collapse();
      }
      if (update.messageId) this.#messages.append(update.messageId, update.text);
      return;
    }
    if (update.messageId) {
      const text = cleanActivityText(update.text);
      if (!this.#hasIdentifiedThought && !text.trim()) return;
      this.#finishLegacyThought();
      if (!this.#hasIdentifiedThought) {
        this.#cards.openThought(`identified:${update.messageId}`);
        this.#hasIdentifiedThought = true;
      }
      this.#thoughts.append(update.messageId, text, update.textCut);
      return;
    }
    if (this.#legacyId === undefined) {
      if (!update.text.trim()) return;
      this.#legacyId = `legacy-thought-${this.#sequence++}`;
      this.#cards.openThought(`legacy:${this.#legacyId}`);
    }
    this.#legacyThoughts.append(this.#legacyId, cleanActivityText(update.text), update.textCut);
  }

  #createThoughtSink(prefix: string): OutputSink<TextSnapshot> {
    return {
      flush: (id, content) => this.#cards.flushThought(prefix + id, content),
      finish: (id) => this.#cards.finishThought(prefix + id),
    };
  }

  #finishLegacyThought(): void {
    this.#legacyThoughts.finish();
    this.#legacyId = undefined;
  }
}
