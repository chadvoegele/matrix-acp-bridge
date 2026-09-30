import type { AcpActivity, AcpToolActivity } from "./acp-activity.js";
import {
  ACTIVITY_RESULT_DETAIL_BYTES,
  ACTIVITY_TITLE_DETAIL_BYTES,
  cleanActivityText,
} from "./acp-activity.js";
import { takeBytes } from "./bounded-text.js";
import { escapeHtml } from "./html.js";

export const ACTIVITY_RESULT_PREVIEW_BYTES = 256;

export const ACTIVITY_TITLE_PREVIEW_BYTES = 160;

export interface RenderedAcpActivity {
  readonly body: string;
  readonly formattedBody: string;
}

type Color = "#000000" | "#008000" | "#C00000";
interface Segment {
  readonly text: string;
  readonly color?: Color;
}
interface Output {
  readonly segments: readonly Segment[];
  readonly plain: string;
  readonly cut: boolean;
  readonly terminal: boolean;
}

function html(value: string): string {
  return escapeHtml(value).replaceAll("\n", "&#10;");
}

function span(value: string, color: Color): string {
  return `<span data-mx-color="${color}">${html(value)}</span>`;
}

function code(segments: readonly Segment[]): string {
  return `<pre><code>${segments.map((part) => (part.color ? span(part.text, part.color) : html(part.text))).join("")}</code></pre>`;
}

function clipSegments(
  segments: readonly Segment[],
  limit: number,
  fromEnd = false,
): { segments: Segment[]; cut: boolean } {
  const ordered = fromEnd ? [...segments].reverse() : segments;
  const result: Segment[] = [];
  let left = limit;
  let cut = false;
  for (const segment of ordered) {
    const part = takeBytes(segment.text, left, fromEnd);
    if (part.text)
      result.push({
        text: part.text,
        ...(segment.color ? { color: segment.color } : {}),
      });
    left -= Buffer.byteLength(part.text, "utf8");
    if (part.cut) {
      cut = true;
      break;
    }
  }
  if (result.length < segments.length) cut = true;
  if (fromEnd) result.reverse();
  return { segments: result, cut };
}

function plain(segments: readonly Segment[]): string {
  return segments.map((part) => part.text).join("");
}

function thoughtParagraphs(value: string): string[] {
  return value
    .trim()
    .split(/\n\s*\n/u)
    .map((paragraph) => {
      const trimmed = paragraph.trim();
      const heading = /^(\*\*|__)([\s\S]+)\1$/u.exec(trimmed);
      return heading ? heading[2]!.trim() : trimmed;
    })
    .filter(Boolean);
}

function toolName(tool: AcpToolActivity): string {
  if (
    tool.title?.toLowerCase() === "mcp" ||
    /^mcp__[\w-]+$/iu.test(tool.title ?? "")
  )
    return "MCP";
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
  const path =
    tool.path ?? tool.content?.find((item) => item.type === "diff")?.path;
  if (name === "MCP") {
    const server = /^mcp__([\w-]+)$/iu.exec(tool.title ?? "")?.[1];
    if (server && tool.mcpOperation)
      return `MCP(${server}/${tool.mcpOperation})`;
    if (tool.mcpOperation) return `MCP(${tool.mcpOperation})`;
    return server ? `MCP(${server})` : "MCP";
  }
  const argument = name === "Execute" || name === "Tool" ? tool.title : path;
  return `${name}(${cleanActivityText(argument ?? "")})`;
}

function statusPalette(status: string): {
  rail: Color | "#808080";
  background: string;
  label: string;
} {
  switch (status) {
    case "completed": {
      return { rail: "#008000", background: "#E6F4EA", label: "completed" };
    }
    case "failed": {
      return { rail: "#C00000", background: "#FCE8E6", label: "failed" };
    }
    case "in_progress": {
      return { rail: "#000000", background: "#F2F2F2", label: "running" };
    }
    default: {
      return { rail: "#808080", background: "#EAEAEA", label: "pending" };
    }
  }
}

function titleMarkup(title: string, status: string): string {
  const colors = statusPalette(status);
  return `<span data-mx-bg-color="${colors.background}"><span data-mx-color="${colors.rail}">┃</span> ${span(`🔧 ${title}`, "#000000")}</span>`;
}

function compactTool(
  title: string,
  label: string,
  maxHtmlBytes: number,
): RenderedAcpActivity {
  let budget = Math.min(Buffer.byteLength(title, "utf8"), maxHtmlBytes);
  for (;;) {
    const bounded = takeBytes(title, budget);
    const body = `[${label}] 🔧 ${bounded.text} (truncated)`;
    const formattedBody = `<p>🔧 ${html(bounded.text)} (truncated)</p>`;
    if (Buffer.byteLength(formattedBody, "utf8") <= maxHtmlBytes || budget <= 0)
      return { body, formattedBody };
    budget = Math.max(0, Math.floor(budget / 2));
  }
}

function lineSegments(
  text: string,
  sign: "-" | "+",
  color: Color,
): { segments: Segment[]; cut: boolean } {
  const bounded = takeBytes(text, ACTIVITY_RESULT_DETAIL_BYTES);
  const lines = bounded.text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const segments: Segment[] = [];
  for (const [index, line] of lines.entries()) {
    segments.push(
      { text: sign, color },
      { text: `${index + 1} `, color: "#000000" },
      { text: line, color },
    );
    if (index < lines.length - 1 || bounded.text.endsWith("\n"))
      segments.push({ text: "\n" });
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
        const bounded = takeBytes(
          cleanActivityText(item.text),
          ACTIVITY_RESULT_DETAIL_BYTES,
        );
        segments.push({ text: bounded.text });
        sourceCut ||= bounded.cut;
      }
      if (item.type === "diff") {
        if (typeof item.oldText === "string") {
          const old = lineSegments(
            cleanActivityText(item.oldText),
            "-",
            "#C00000",
          );
          segments.push(...old.segments, { text: "\n" });
          sourceCut ||= old.cut;
        }
        if (typeof item.newText === "string") {
          const next = lineSegments(
            cleanActivityText(item.newText),
            "+",
            "#008000",
          );
          segments.push(...next.segments);
          sourceCut ||= next.cut;
        }
      }
    }
    const clipped = clipSegments(segments, ACTIVITY_RESULT_DETAIL_BYTES);
    return {
      segments: clipped.segments,
      plain: plain(clipped.segments),
      cut: clipped.cut || sourceCut || tool.contentCut,
      terminal: false,
    };
  }
  if (tool.terminalBytes > 0) {
    const over = tool.terminalBytes > ACTIVITY_RESULT_DETAIL_BYTES;
    const text = over
      ? `${tool.terminalHead}\n\n${tool.terminalTail}`
      : tool.terminalSmall;
    return { segments: [{ text }], plain: text, cut: over, terminal: true };
  }
  if (tool.rawFallback) {
    return {
      segments: [{ text: tool.rawFallback.text }],
      plain: tool.rawFallback.text,
      cut: tool.rawFallback.cut || tool.contentCut,
      terminal: false,
    };
  }
  return undefined;
}

/** Presents retained activity as Matrix plain text and HTML within the message budget. */
export function renderAcpActivity(
  event: AcpActivity,
  maxHtmlBytes = 32_768,
): RenderedAcpActivity {
  if (event.type === "thought") {
    const source = cleanActivityText(event.text);
    let budget = Math.min(ACTIVITY_RESULT_DETAIL_BYTES, maxHtmlBytes);
    for (;;) {
      const bounded = takeBytes(source, budget);
      const paragraphs = thoughtParagraphs(bounded.text);
      const suffix = bounded.cut || event.cut ? " (truncated)" : "";
      const body =
        paragraphs.length > 0
          ? `${paragraphs.map((paragraph) => `💭 ${paragraph}`).join("\n\n")}${suffix}`
          : `💭${suffix}`;
      const formattedBody =
        paragraphs.length > 0
          ? paragraphs
              .map(
                (paragraph, index) =>
                  `<p>💭 ${html(paragraph).replaceAll("&#10;", "<br>")}${index === paragraphs.length - 1 ? suffix : ""}</p>`,
              )
              .join("\n")
          : `<p>💭${suffix}</p>`;
      const result = { body, formattedBody };
      if (
        Buffer.byteLength(result.formattedBody, "utf8") <= maxHtmlBytes ||
        budget <= 0
      )
        return result;
      budget = Math.max(0, Math.floor(budget / 2));
    }
  }
  const fullTitle = toolTitle(event);
  const isScript = event.title === "mcpScript" && event.script !== undefined;
  const command = isScript
    ? event.script!.text
    : toolName(event) === "Execute"
      ? cleanActivityText(event.title ?? "")
      : fullTitle;
  const previewSource = isScript
    ? command.replaceAll(/\s+/gu, " ").trim()
    : command;
  const boundedPreview = takeBytes(previewSource, ACTIVITY_TITLE_PREVIEW_BYTES);
  const previewCommand = boundedPreview.cut
    ? `${takeBytes(previewSource, ACTIVITY_TITLE_PREVIEW_BYTES - Buffer.byteLength("…", "utf8")).text}…`
    : boundedPreview.text;
  const title = isScript
    ? `MCP Script(${previewCommand})`
    : toolName(event) === "Execute"
      ? `Execute(${previewCommand})`
      : previewCommand;
  const titleDetail = takeBytes(
    command,
    Math.min(
      ACTIVITY_TITLE_DETAIL_BYTES,
      Math.max(128, Math.floor(maxHtmlBytes / 3)),
    ),
  );
  const titleCut = titleDetail.cut || (isScript && event.script!.cut);
  const palette = statusPalette(event.status);
  const titleSummary = `${title}${titleCut ? " (truncated)" : ""}`;
  const titleHtml =
    isScript || previewCommand !== command
      ? `<details><summary>${titleMarkup(titleSummary, event.status)}</summary>${code([{ text: titleDetail.text }])}</details>`
      : `<p>${titleMarkup(titleSummary, event.status)}</p>`;
  const scriptBody = isScript
    ? `\nScript:\n${titleDetail.text}${titleCut ? " (truncated)" : ""}`
    : "";
  const output = resultFromContent(event);
  if (!output || output.plain.length === 0) {
    if (Buffer.byteLength(titleHtml, "utf8") <= maxHtmlBytes)
      return {
        body: `[${palette.label}] 🔧 ${titleSummary}${scriptBody}`,
        formattedBody: titleHtml,
      };
    return compactTool(titleSummary, palette.label, maxHtmlBytes);
  }
  let detailBytes = ACTIVITY_RESULT_DETAIL_BYTES;
  let previewBytes = ACTIVITY_RESULT_PREVIEW_BYTES;
  for (;;) {
    let detail = clipSegments(output.segments, detailBytes);
    if (
      output.terminal &&
      detailBytes < ACTIVITY_RESULT_DETAIL_BYTES &&
      event.terminalBytes > detailBytes
    ) {
      const head = takeBytes(
        event.terminalHead || event.terminalSmall,
        Math.floor(detailBytes * 0.75),
      );
      const tail = takeBytes(
        event.terminalTail,
        detailBytes - Buffer.byteLength(head.text, "utf8"),
        true,
      );
      detail = {
        segments: [{ text: `${head.text}\n\n${tail.text}` }],
        cut: true,
      };
    }
    const preview = clipSegments(
      output.segments,
      previewBytes,
      output.terminal,
    );
    const truncated = output.cut || detail.cut;
    const detailDiffers = preview.cut || truncated;
    const body = `[${palette.label}] 🔧 ${titleSummary}${scriptBody}\n${plain(preview.segments)}${truncated ? " (truncated)" : ""}`;
    const resultHtml = detailDiffers
      ? `<details><summary><code>${preview.segments.map((part) => (part.color ? span(part.text, part.color) : html(part.text))).join("")}</code>${truncated ? " (truncated)" : ""}</summary>${code(detail.segments)}</details>`
      : code(detail.segments);
    const formattedBody = `${titleHtml}\n<blockquote>${resultHtml}</blockquote>`;
    if (Buffer.byteLength(formattedBody, "utf8") <= maxHtmlBytes)
      return { body, formattedBody };
    if (detailBytes > previewBytes)
      detailBytes = Math.max(previewBytes, Math.floor(detailBytes / 2));
    else if (previewBytes > 16) previewBytes = Math.floor(previewBytes / 2);
    else if (detailBytes > 16) detailBytes = Math.floor(detailBytes / 2);
    else return compactTool(titleSummary, palette.label, maxHtmlBytes);
  }
}
