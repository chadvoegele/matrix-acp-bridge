import { markdownBlockMaps } from "./matrix-markdown.js";

/**
 * Source-preserving top-level blocks for greedy rendered-payload packing.
 * Separating whitespace belongs to the preceding block; leading whitespace to
 * the first. Lists, quotes, tables and fences remain whole. No source is rebuilt
 * from tokens (markdown-it normalizes newlines and inline token content).
 */
export function markdownChunks(text: string): string[] {
  if (!text) return [];
  const lineOffsets = [0];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    lineOffsets.push(match.index + match[0].length);
  }
  const starts = markdownBlockMaps(text).map(([start]) => lineOffsets[start] ?? text.length);
  const boundaries = [...new Set([0, ...starts.slice(1), text.length])];
  return boundaries.slice(0, -1).map((start, index) => text.slice(start, boundaries[index + 1]));
}

/**
 * Refine an oversized block into word and construct units, keeping
 * balanced links/images, code spans, and simple paired emphasis/strike whole.
 * This is a conservative boundary scanner, not another Markdown parser: it may
 * keep non-Markdown delimiters together, and complex emphasis is best-effort.
 *
 * An indivisible construct stays a single unit. The packer owns Unicode-safe
 * fallback for a unit that cannot fit alone. Oversized fences/lists/quotes may
 * lose block context; no synthetic delimiters are added.
 */
export function refineMarkdownChunk(text: string): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let start = 0;
  let index = 0;
  const balanced = new Map<number, number>();
  while (index < text.length) {
    const end = constructEnd(text, index, balanced);
    if (end > index) {
      if (text[index] !== "\\") {
        if (start < index) chunks.push(text.slice(start, index));
        chunks.push(text.slice(index, end));
        start = end;
      }
      index = end;
    } else if (/\s/u.test(text[index]!)) {
      // Separate whitespace so a fitting construct need not carry extra bytes.
      if (start < index) chunks.push(text.slice(start, index));
      start = index;
      while (index < text.length && /\s/u.test(text[index]!)) index++;
      chunks.push(text.slice(start, index));
      start = index;
    } else {
      index += text.codePointAt(index)! > 0xff_ff ? 2 : 1;
    }
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

function constructEnd(text: string, start: number, balanced: Map<number, number>): number {
  const marker = text[start];
  if (marker === "\\") return Math.min(text.length, start + 1 + (text.codePointAt(start + 1)! > 0xff_ff ? 2 : 1));
  if (marker === "`") return codeEnd(text, start);
  if (marker === "[" || (marker === "!" && text[start + 1] === "[")) {
    const labelStart = marker === "!" ? start + 1 : start;
    const labelEnd = balancedEnd(text, labelStart, "[", "]", balanced);
    if (!labelEnd) return 0;
    if (text[labelEnd] === "(") {
      return balancedEnd(text, labelEnd, "(", ")", balanced) || labelEnd;
    }
    if (text[labelEnd] === "[") {
      return balancedEnd(text, labelEnd, "[", "]", balanced) || labelEnd;
    }
    // Also protect shortcut references and labels with unresolved definitions.
    return labelEnd;
  }
  if (marker === "*" || marker === "_" || marker === "~") {
    const length = runLength(text, start);
    if (marker === "~" && length !== 2) return 0;
    const delimiter = marker.repeat(length);
    let index = start + length;
    if (/\s/u.test(text[index] ?? "")) return 0;
    while (index < text.length) {
      switch (text[index]) {
        case "\\": {
          index += 2;

          break;
        }
        case "`": {
          index = codeEnd(text, index) || index + runLength(text, index);

          break;
        }
        case marker: {
          const closingLength = runLength(text, index);
          if (closingLength === delimiter.length && !/\s/u.test(text[index - 1]!)) {
            return index + closingLength;
          }
          index += closingLength;

          break;
        }
        default: {
          index++;
        }
      }
    }
  }
  return 0;
}

function runLength(text: string, start: number): number {
  let end = start + 1;
  while (text[end] === text[start]) end++;
  return end - start;
}

function codeEnd(text: string, start: number): number {
  const length = runLength(text, start);
  let index = start + length;
  while (index < text.length) {
    const next = text.indexOf("`", index);
    if (next === -1) return 0;
    const closingLength = runLength(text, next);
    if (closingLength === length) return next + length;
    index = next + closingLength;
  }
  return 0;
}

function balancedEnd(text: string, start: number, open: string, close: string, cache: Map<number, number>): number {
  const cached = cache.get(start);
  if (cached !== undefined) return cached;
  // Record nested pairs, including unmatched openings, while scanning once.
  // Later openings must not rescan the same malformed suffix quadratically.
  const openings = [start];
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
    } else if (text[index] === "`") {
      index = codeEnd(text, index) || index + runLength(text, index);
    } else if (
      open === "(" &&
      (text[index] === "<" || ((text[index] === '"' || text[index] === "'") && /\s/u.test(text[index - 1]!)))
    ) {
      // Angle destinations and quoted titles may contain literal parentheses.
      const closing = text[index] === "<" ? ">" : text[index]!;
      index++;
      while (index < text.length && text[index] !== closing) {
        index += text[index] === "\\" ? 2 : 1;
      }
      if (index === text.length) break;
      index++;
    } else if (text[index] === open) {
      openings.push(index);
      index++;
    } else if (text[index] === close) {
      cache.set(openings.pop()!, index + 1);
      if (openings.length === 0) return index + 1;
      index++;
    } else {
      index++;
    }
  }
  for (const opening of openings) cache.set(opening, 0);
  return 0;
}
