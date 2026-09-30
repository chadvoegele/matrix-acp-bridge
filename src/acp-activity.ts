import type { AcpToolCallUpdate, AcpToolContent, AcpUpdate } from "./acp-activity-update.js";
import { isRecord, stringProperty } from "./object-validation.js";
import { takeBytes } from "./bounded-text.js";

export const ACTIVITY_RESULT_DETAIL_BYTES = 8192;
export const ACTIVITY_TITLE_DETAIL_BYTES = 2048;

export interface BoundedText { readonly text: string; readonly cut: boolean }

export interface AcpThoughtActivity {
  readonly type: "thought";
  readonly messageId?: string;
  text: string;
  cut: boolean;
}
export interface AcpToolActivity {
  readonly type: "tool";
  readonly toolCallId?: string;
  title?: string;
  toolKind?: string;
  status: string;
  path?: string;
  isWrite: boolean;
  mcpOperation?: string;
  script?: BoundedText;
  content?: readonly AcpToolContent[];
  contentCut: boolean;
  rawFallback: BoundedText | undefined;
  terminalSmall: string;
  terminalHead: string;
  terminalTail: string;
  terminalBytes: number;
}
export type AcpActivity = AcpThoughtActivity | AcpToolActivity;

/** Removes terminal escape sequences and non-display control characters. */
export function cleanActivityText(value: string): string {
  // eslint-disable-next-line no-control-regex
  const ansiSequence = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\))/g;
  // eslint-disable-next-line no-control-regex
  const controlCharacter = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
  return value.replaceAll(ansiSequence, "").replaceAll(controlCharacter, "");
}

function mcpOperation(value: AcpToolCallUpdate["rawInput"]): string | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value.call;
  const candidate = typeof nested === "string" ? nested
    : stringProperty(nested, "tool", "toolName", "name") ?? stringProperty(value, "tool", "toolName", "name", "describe");
  if (candidate !== undefined && /^[\w.\-/:]{1,128}$/u.test(candidate)) return candidate;
  return typeof value.search === "string" ? "search" : undefined;
}
function inputPath(value: AcpToolCallUpdate["rawInput"]): string | undefined {
  if (value && typeof value === "object" && !Array.isArray(value) && "path" in value && typeof value.path === "string") return value.path;
  return undefined;
}

function boundedContent(content: readonly AcpToolContent[]): { content: AcpToolContent[]; cut: boolean } {
  const result: AcpToolContent[] = [];
  let left = ACTIVITY_RESULT_DETAIL_BYTES;
  let cut = false;
  for (const item of content) {
    if (item.type === "terminal") continue;
    if (item.type === "content") {
      const bounded = takeBytes(cleanActivityText(item.text), left);
      result.push({ type: "content", text: bounded.text });
      left -= Buffer.byteLength(bounded.text, "utf8");
      cut ||= bounded.cut;
    } else {
      const old = typeof item.oldText === "string" ? takeBytes(cleanActivityText(item.oldText), left) : undefined;
      if (old) left -= Buffer.byteLength(old.text, "utf8");
      const next = typeof item.newText === "string" ? takeBytes(cleanActivityText(item.newText), left) : undefined;
      if (next) left -= Buffer.byteLength(next.text, "utf8");
      const oldField = item.oldText === null ? { oldText: null } : {};
      result.push({ type: "diff", path: takeBytes(cleanActivityText(item.path), 1024).text,
        ...oldField, ...(old ? { oldText: old.text } : {}),
        ...(next ? { newText: next.text } : {}) });
      cut ||= Boolean(old?.cut || next?.cut);
    }
    if (left === 0) cut ||= content.length > result.length;
    if (left === 0) break;
  }
  return { content: result, cut };
}

function rawFallback(value: AcpToolCallUpdate["rawOutput"]): BoundedText | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("content" in value) || !Array.isArray(value.content)) return undefined;
  let text = "";
  let cut = false;
  let found = false;
  for (const item of value.content as readonly unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !("text" in item) || typeof item.text !== "string") continue;
    const separator = found ? "\n\n" : "";
    const bounded = takeBytes(`${separator}${cleanActivityText(item.text)}`, ACTIVITY_RESULT_DETAIL_BYTES - Buffer.byteLength(text, "utf8"));
    text += bounded.text;
    found = true;
    cut ||= bounded.cut;
  }
  return found ? { text, cut } : undefined;
}

/** Holds one turn's bounded, normalized activity. Tool updates change the original event object. */
export class AcpActivityModel {
  readonly events: AcpActivity[] = [];
  readonly #tools = new Map<string, AcpToolActivity>();
  readonly #thoughts = new Map<string, AcpThoughtActivity>();
  #lastThought: AcpThoughtActivity | undefined;
  #closed = false;

  close(): void { this.#closed = true; }

  accept(update: AcpUpdate): AcpActivity | undefined {
    if (this.#closed) return undefined;
    if (update.kind === "agent_message_chunk") {
      if (update.text.trim()) this.#lastThought = undefined;
      return undefined;
    }
    if (update.kind === "agent_thought_chunk") {
      let event = update.messageId ? this.#thoughts.get(update.messageId) : this.#lastThought;
      if (!update.text.trim() && !event) return undefined;
      if (!event) {
        event = { type: "thought", text: "", cut: false, ...(update.messageId ? { messageId: update.messageId } : {}) };
        this.events.push(event);
        if (update.messageId) this.#thoughts.set(update.messageId, event);
      }
      const capacity = ACTIVITY_RESULT_DETAIL_BYTES - Buffer.byteLength(event.text, "utf8");
      const bounded = takeBytes(cleanActivityText(update.text), Math.max(0, capacity));
      event.text += bounded.text;
      event.cut ||= bounded.cut || update.textCut === true;
      this.#lastThought = event;
      return event;
    }
    if (update.kind !== "tool_call" && update.kind !== "tool_call_update") return undefined;
    this.#lastThought = undefined;
    let event = update.toolCallId ? this.#tools.get(update.toolCallId) : undefined;
    if (!event) {
      if (update.kind !== "tool_call") return undefined;
      event = { type: "tool", status: "pending", isWrite: false, contentCut: false, rawFallback: undefined,
        terminalSmall: "", terminalHead: "", terminalTail: "", terminalBytes: 0,
        ...(update.toolCallId ? { toolCallId: update.toolCallId } : {}) };
      this.events.push(event);
      if (update.toolCallId) this.#tools.set(update.toolCallId, event);
    }
    if (update.title !== undefined) event.title = takeBytes(cleanActivityText(update.title), ACTIVITY_TITLE_DETAIL_BYTES + 16).text;
    if (update.toolKind !== undefined) event.toolKind = update.toolKind;
    if (update.status !== undefined) event.status = update.status;
    if (update.rawInput !== undefined) {
      const path = inputPath(update.rawInput);
      if (path !== undefined) event.path = takeBytes(cleanActivityText(path), 1024).text;
      if (update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput) &&
        "content" in update.rawInput && typeof update.rawInput.content === "string") event.isWrite = true;
      const operation = mcpOperation(update.rawInput);
      if (operation !== undefined) event.mcpOperation = operation;
      if (event.title === "mcpScript") {
        const script = stringProperty(update.rawInput, "code");
        if (script !== undefined) event.script = takeBytes(cleanActivityText(script), ACTIVITY_RESULT_DETAIL_BYTES);
      }
    }
    if (update.locations?.[0]?.path && !event.path) event.path = takeBytes(cleanActivityText(update.locations[0].path), 1024).text;
    if (update.content !== undefined) {
      const bounded = boundedContent(update.content);
      if (bounded.content.length > 0) {
        event.content = bounded.content;
        event.contentCut = bounded.cut || update.contentCut === true;
      }
    }
    if (update.rawOutput !== undefined) event.rawFallback = rawFallback(update.rawOutput);
    event.contentCut ||= update.activityCut === true;
    if (event.script && update.activityCut) event.script = { ...event.script, cut: true };
    if (update.terminalOutput?.data) {
      const chunk = cleanActivityText(update.terminalOutput.data);
      const bytes = Buffer.byteLength(chunk, "utf8");
      event.terminalBytes = Math.min(Number.MAX_SAFE_INTEGER, event.terminalBytes + (update.terminalOutput.originalBytes ?? bytes));
      if (event.terminalBytes <= ACTIVITY_RESULT_DETAIL_BYTES) event.terminalSmall += chunk;
      else {
        if (event.terminalHead === "") event.terminalHead = takeBytes(event.terminalSmall + chunk, 6142).text;
        event.terminalSmall = "";
      }
      event.terminalTail = takeBytes(event.terminalTail + chunk, 2048, true).text;
    }
    return event;
  }
}
