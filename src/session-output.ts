import { ACTIVITY_RESULT_DETAIL_BYTES, cleanActivityText } from "./acp-activity.js";
import { renderActivityCard } from "./acp-activity-rendering.js";
import { isUsableMessageId, type AcpUpdate } from "./acp-activity-update.js";
import { ActivityCardCollector } from "./activity-card-collector.js";
import type { Clock } from "./clock.js";
import type { AgentTextSettings } from "./config.js";
import type { ConversationPublication } from "./conversation-publication.js";
import { matrixHtmlEditContentBytes, type MatrixHtmlBody, type MatrixOutputRouting } from "./matrix-message-content.js";
import { renderMatrixTextChunks } from "./matrix-text-rendering.js";
import { renderOutput } from "./output-sink.js";
import { TextCollector } from "./text-collector.js";
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
  readonly onAbandoned: (reason: "capacity" | "lifecycle") => void;
}

/** Dispatches one live session's normalized ACP stream to focused domain owners. */
export class SessionOutput {
  readonly #messages: TextCollector;

  readonly #thoughts: TextCollector;

  readonly #cards: ActivityCardCollector;

  readonly #tools: ToolCollector;

  #responseId: string | undefined;

  #hasIdentifiedThought = false;

  #closed = false;

  constructor(options: SessionOutputOptions) {
    const measure = (rendered: MatrixHtmlBody) => matrixHtmlEditContentBytes({ ...rendered, ...options.routing });
    this.#cards = new ActivityCardCollector({
      limits: {
        maxEvents: options.maxEventsPerCard,
        maxMessageBytes: options.maxMatrixMessageBytes,
        measure: (card) => measure(renderActivityCard(card, Number.MAX_SAFE_INTEGER, measure)),
      },
      maxRetainedEvents: options.maxRetainedEvents,
      onCapacity: () => options.onAbandoned("capacity"),
      sink: renderOutput(
        options.queue.cards,
        (card) => [renderActivityCard(card, options.maxMatrixMessageBytes, measure)],
        () => options.queue.fail("delivery"),
      ),
    });
    this.#messages = new TextCollector({
      ...options,
      sink: renderOutput(
        options.queue.messages,
        (content) => renderMatrixTextChunks(content.text, options.maxMatrixMessageBytes, measure),
        () => options.queue.fail("delivery"),
      ),
    });
    this.#thoughts = new TextCollector({
      ...options,
      maxOutputBytes: Math.min(options.maxOutputBytes, ACTIVITY_RESULT_DETAIL_BYTES),
      sink: {
        flush: (id, content) => this.#cards.flushThought(id, content),
        finish: (id) => this.#cards.finishThought(id),
      },
    });
    this.#tools = new ToolCollector({
      ...options,
      onCapacity: () => options.onAbandoned("capacity"),
      sink: { flush: (id, content) => this.#cards.flushTool(id, content), finish: (id) => this.#cards.finishTool(id) },
    });
    options.queue.onStop(() => {
      if (this.#tools.activeCount > 0 || this.#thoughts.hasPendingText || options.queue.pendingCount > 0)
        options.onAbandoned("lifecycle");
      this.#closed = true;
      this.#messages.stop();
      this.#thoughts.stop();
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
      this.#tools.accept(update);
      return;
    }
    if (update.kind !== "agent_message_chunk" && update.kind !== "agent_thought_chunk") return;
    if (!isUsableMessageId(update.messageId)) return;
    if (update.messageId !== this.#responseId) {
      this.#messages.finish();
      this.#thoughts.finish();
      this.#hasIdentifiedThought = false;
      this.#responseId = update.messageId;
    }
    if (update.kind === "agent_message_chunk") {
      if (update.text.trim()) {
        this.#cards.collapse();
      }
      this.#messages.append(update.messageId, update.text);
      return;
    }
    const text = cleanActivityText(update.text);
    if (!this.#hasIdentifiedThought && !text.trim()) return;
    if (!this.#hasIdentifiedThought) {
      this.#cards.openThought(update.messageId);
      this.#hasIdentifiedThought = true;
    }
    this.#thoughts.append(update.messageId, text, update.textCut);
  }
}
