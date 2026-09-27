import type { AcpToolCallUpdate, AcpToolContent, AcpUpdate } from "./acp-client.js";

export const ACTIVITY_RESULT_PREVIEW_BYTES = 1024;
export const ACTIVITY_RESULT_DETAIL_BYTES = 8192;
export const ACTIVITY_TITLE_PREVIEW_CHARACTERS = 160;
export const ACTIVITY_TITLE_DETAIL_BYTES = 2048;

// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\))/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

type Color = "#000000" | "#008000" | "#C00000";
interface Segment { readonly text: string; readonly color?: Color }
interface BoundedText { readonly text: string; readonly cut: boolean }
interface Output { readonly segments: readonly Segment[]; readonly plain: string; readonly cut: boolean; readonly terminal: boolean }

export interface AcpThoughtActivity {
  readonly type: "thought";
  readonly messageId?: string;
  text: string;
}
export interface AcpToolActivity {
  readonly type: "tool";
  readonly toolCallId?: string;
  title?: string;
  toolKind?: string;
  status: string;
  path?: string;
  isWrite: boolean;
  content?: readonly AcpToolContent[];
  contentCut: boolean;
  rawFallback: BoundedText | undefined;
  terminalSmall: string;
  terminalHead: string;
  terminalTail: string;
  terminalBytes: number;
}
export type AcpActivity = AcpThoughtActivity | AcpToolActivity;
export interface RenderedAcpActivity { readonly body: string; readonly formattedBody: string }

function clean(value: string): string {
  return value.replaceAll(ANSI_SEQUENCE, "").replaceAll(CONTROL_CHARACTER, "");
}

function takeBytes(value: string, limit: number, fromEnd = false): BoundedText {
  if (Buffer.byteLength(value, "utf8") <= limit) return { text: value, cut: false };
  let bytes = 0;
  const characters: string[] = [];
  const source = fromEnd ? [...value].reverse() : value;
  for (const character of source) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > limit) break;
    characters.push(character);
    bytes += size;
  }
  if (fromEnd) characters.reverse();
  return { text: characters.join(""), cut: true };
}

function html(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("\n", "&#10;");
}
function span(value: string, color: Color): string {
  return `<span data-mx-color="${color}">${html(value)}</span>`;
}
function code(segments: readonly Segment[]): string {
  return `<pre><code>${segments.map((part) => part.color ? span(part.text, part.color) : html(part.text)).join("")}</code></pre>`;
}
function clipSegments(segments: readonly Segment[], limit: number, fromEnd = false): { segments: Segment[]; cut: boolean } {
  const ordered = fromEnd ? [...segments].reverse() : segments;
  const result: Segment[] = [];
  let left = limit;
  let cut = false;
  for (const segment of ordered) {
    const part = takeBytes(segment.text, left, fromEnd);
    if (part.text) result.push({ text: part.text, ...(segment.color ? { color: segment.color } : {}) });
    left -= Buffer.byteLength(part.text, "utf8");
    if (part.cut) { cut = true; break; }
  }
  if (result.length < segments.length) cut = true;
  if (fromEnd) result.reverse();
  return { segments: result, cut };
}
function plain(segments: readonly Segment[]): string { return segments.map((part) => part.text).join(""); }
function inputPath(value: AcpToolCallUpdate["rawInput"]): string | undefined {
  if (value && typeof value === "object" && !Array.isArray(value) && "path" in value && typeof value.path === "string") return value.path;
  return undefined;
}
function toolName(tool: AcpToolActivity): string {
  if (tool.toolKind === "execute") return "Execute";
  if (tool.toolKind === "read") return "Read";
  if (tool.toolKind === "edit") {
    if (tool.title?.toLowerCase() === "write" || tool.isWrite) return "Write";
    return "Edit";
  }
  return "Tool";
}
function toolTitle(tool: AcpToolActivity): string {
  const name = toolName(tool);
  const path = tool.path ?? tool.content?.find((item) => item.type === "diff")?.path;
  const argument = name === "Execute" || name === "Tool" ? tool.title : path;
  return `${name}(${clean(argument ?? "")})`;
}
function statusPalette(status: string): { rail: Color | "#808080"; background: string; label: string } {
  switch (status) {
    case "completed": { return { rail: "#008000", background: "#E6F4EA", label: "completed" }; }
    case "failed": { return { rail: "#C00000", background: "#FCE8E6", label: "failed" }; }
    case "in_progress": { return { rail: "#000000", background: "#F2F2F2", label: "running" }; }
    default: { return { rail: "#808080", background: "#EAEAEA", label: "pending" }; }
  }
}
function titleMarkup(title: string, status: string): string {
  const colors = statusPalette(status);
  return `<span data-mx-bg-color="${colors.background}"><span data-mx-color="${colors.rail}">┃</span> ${span(`🔧 ${title}`, "#000000")}</span>`;
}
function lineSegments(text: string, sign: "-" | "+", color: Color): { segments: Segment[]; cut: boolean } {
  const bounded = takeBytes(text, ACTIVITY_RESULT_DETAIL_BYTES);
  const lines = bounded.text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const segments: Segment[] = [];
  for (const [index, line] of lines.entries()) {
    segments.push({ text: sign, color }, { text: `${index + 1} `, color: "#000000" }, { text: line, color });
    if (index < lines.length - 1 || bounded.text.endsWith("\n")) segments.push({ text: "\n" });
  }
  return { segments, cut: bounded.cut };
}
function resultFromContent(tool: AcpToolActivity): Output | undefined {
  const display = tool.content?.filter((item) => item.type !== "terminal");
  if (display && display.length > 0) {
    const segments: Segment[] = [];
    let sourceCut = false;
    for (const item of display) {
      if (segments.length > 0) segments.push({ text: "\n\n" });
      if (item.type === "content") {
        const bounded = takeBytes(clean(item.text), ACTIVITY_RESULT_DETAIL_BYTES);
        segments.push({ text: bounded.text });
        sourceCut ||= bounded.cut;
      }
      if (item.type === "diff") {
        if (typeof item.oldText === "string") {
          const old = lineSegments(clean(item.oldText), "-", "#C00000");
          segments.push(...old.segments, { text: "\n" });
          sourceCut ||= old.cut;
        }
        if (typeof item.newText === "string") {
          const next = lineSegments(clean(item.newText), "+", "#008000");
          segments.push(...next.segments);
          sourceCut ||= next.cut;
        }
      }
    }
    const clipped = clipSegments(segments, ACTIVITY_RESULT_DETAIL_BYTES);
    return { segments: clipped.segments, plain: plain(clipped.segments), cut: clipped.cut || sourceCut || tool.contentCut, terminal: false };
  }
  if (tool.terminalBytes > 0) {
    const over = tool.terminalBytes > ACTIVITY_RESULT_DETAIL_BYTES;
    const text = over ? `${tool.terminalHead}\n\n${tool.terminalTail}` : tool.terminalSmall;
    return { segments: [{ text }], plain: text, cut: over, terminal: true };
  }
  if (tool.rawFallback) {
    return { segments: [{ text: tool.rawFallback.text }], plain: tool.rawFallback.text, cut: tool.rawFallback.cut, terminal: false };
  }
  return undefined;
}

function boundedContent(content: readonly AcpToolContent[]): { content: AcpToolContent[]; cut: boolean } {
  const result: AcpToolContent[] = [];
  let left = ACTIVITY_RESULT_DETAIL_BYTES;
  let cut = false;
  for (const item of content) {
    if (item.type === "terminal") continue;
    if (item.type === "content") {
      const bounded = takeBytes(clean(item.text), left);
      result.push({ type: "content", text: bounded.text });
      left -= Buffer.byteLength(bounded.text, "utf8");
      cut ||= bounded.cut;
    } else {
      const old = typeof item.oldText === "string" ? takeBytes(clean(item.oldText), left) : undefined;
      if (old) left -= Buffer.byteLength(old.text, "utf8");
      const next = typeof item.newText === "string" ? takeBytes(clean(item.newText), left) : undefined;
      if (next) left -= Buffer.byteLength(next.text, "utf8");
      const oldField = item.oldText === null ? { oldText: null } : {};
      result.push({ type: "diff", path: takeBytes(clean(item.path), 1024).text,
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
    const bounded = takeBytes(`${separator}${clean(item.text)}`, ACTIVITY_RESULT_DETAIL_BYTES - Buffer.byteLength(text, "utf8"));
    text += bounded.text;
    found = true;
    cut ||= bounded.cut;
  }
  return found ? { text, cut } : undefined;
}

/** Holds one turn's activity. Tool updates change the original event object. */
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
      if (!update.text.trim()) return undefined;
      let event = update.messageId ? this.#thoughts.get(update.messageId) : this.#lastThought;
      if (!event) {
        event = { type: "thought", text: "", ...(update.messageId ? { messageId: update.messageId } : {}) };
        this.events.push(event);
        if (update.messageId) this.#thoughts.set(update.messageId, event);
      }
      const capacity = ACTIVITY_RESULT_DETAIL_BYTES - Buffer.byteLength(event.text, "utf8");
      event.text += takeBytes(clean(update.text), Math.max(0, capacity)).text;
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
    if (update.title !== undefined) event.title = takeBytes(clean(update.title), ACTIVITY_TITLE_DETAIL_BYTES + 16).text;
    if (update.toolKind !== undefined) event.toolKind = update.toolKind;
    if (update.status !== undefined) event.status = update.status;
    if (update.rawInput !== undefined) {
      const path = inputPath(update.rawInput);
      if (path !== undefined) event.path = takeBytes(clean(path), 1024).text;
      if (update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput) &&
        "content" in update.rawInput && typeof update.rawInput.content === "string") event.isWrite = true;
    }
    if (update.locations?.[0]?.path && !event.path) event.path = takeBytes(clean(update.locations[0].path), 1024).text;
    if (update.content !== undefined) {
      const bounded = boundedContent(update.content);
      if (bounded.content.length > 0) {
        event.content = bounded.content;
        event.contentCut = bounded.cut;
      }
    }
    if (update.rawOutput !== undefined) event.rawFallback = rawFallback(update.rawOutput);
    if (update.terminalOutput?.data) {
      const chunk = clean(update.terminalOutput.data);
      const bytes = Buffer.byteLength(chunk, "utf8");
      event.terminalBytes = Math.min(Number.MAX_SAFE_INTEGER, event.terminalBytes + bytes);
      if (event.terminalBytes <= ACTIVITY_RESULT_DETAIL_BYTES) event.terminalSmall += chunk;
      else {
        if (event.terminalHead === "") event.terminalHead = takeBytes(event.terminalSmall + chunk, 6144).text;
        event.terminalSmall = "";
      }
      event.terminalTail = takeBytes(event.terminalTail + chunk, 2048, true).text;
    }
    return event;
  }
}

export function renderAcpActivity(event: AcpActivity, maxHtmlBytes = 32_768): RenderedAcpActivity {
  if (event.type === "thought") {
    const value = clean(event.text);
    return { body: `💭 ${value}`, formattedBody: `<p>💭 ${html(value)}</p>` };
  }
  const fullTitle = toolTitle(event);
  const command = toolName(event) === "Execute" ? clean(event.title ?? "") : fullTitle;
  const commandCharacters = [...command];
  const previewCommand = commandCharacters.length > ACTIVITY_TITLE_PREVIEW_CHARACTERS
    ? `${commandCharacters.slice(0, ACTIVITY_TITLE_PREVIEW_CHARACTERS - 1).join("")}…` : command;
  const title = toolName(event) === "Execute" ? `Execute(${previewCommand})` : previewCommand;
  const titleDetail = takeBytes(command, ACTIVITY_TITLE_DETAIL_BYTES);
  const titleCut = titleDetail.cut;
  const palette = statusPalette(event.status);
  const titleSummary = `${title}${titleCut ? " (truncated)" : ""}`;
  const titleHtml = previewCommand === command
    ? `<p>${titleMarkup(titleSummary, event.status)}</p>`
    : `<details><summary>${titleMarkup(titleSummary, event.status)}</summary>${code([{ text: titleDetail.text }])}</details>`;
  const output = resultFromContent(event);
  if (!output || output.plain.length === 0) return { body: `[${palette.label}] 🔧 ${titleSummary}`, formattedBody: titleHtml };
  let detailBytes = ACTIVITY_RESULT_DETAIL_BYTES;
  let previewBytes = ACTIVITY_RESULT_PREVIEW_BYTES;
  for (;;) {
    let detail = clipSegments(output.segments, detailBytes);
    if (output.terminal && detailBytes < ACTIVITY_RESULT_DETAIL_BYTES && event.terminalBytes > detailBytes) {
      const head = takeBytes(event.terminalHead || event.terminalSmall, Math.floor(detailBytes * 0.75));
      const tail = takeBytes(event.terminalTail, detailBytes - Buffer.byteLength(head.text, "utf8"), true);
      detail = { segments: [{ text: `${head.text}\n\n${tail.text}` }], cut: true };
    }
    const preview = output.terminal
      ? clipSegments(output.segments, previewBytes, true)
      : clipSegments(output.segments, previewBytes);
    const truncated = output.cut || detail.cut;
    const detailDiffers = preview.cut || truncated;
    const body = `[${palette.label}] 🔧 ${titleSummary}\n${plain(preview.segments)}${truncated ? " (truncated)" : ""}`;
    const resultHtml = detailDiffers
      ? `<details><summary><code>${preview.segments.map((part) => part.color ? span(part.text, part.color) : html(part.text)).join("")}</code>${truncated ? " (truncated)" : ""}</summary>${code(detail.segments)}</details>`
      : code(detail.segments);
    const formattedBody = `${titleHtml}\n${resultHtml}`;
    if (Buffer.byteLength(formattedBody, "utf8") <= maxHtmlBytes) return { body, formattedBody };
    if (detailBytes > previewBytes) detailBytes = Math.max(previewBytes, Math.floor(detailBytes / 2));
    else if (previewBytes > 16) previewBytes = Math.floor(previewBytes / 2);
    else if (detailBytes > 16) detailBytes = Math.floor(detailBytes / 2);
    else return { body: `[${palette.label}] 🔧 Activity (truncated)`, formattedBody: `<p>🔧 Activity (truncated)</p>` };
  }
}
