import { markdownChunks, refineMarkdownChunk } from "./markdown-chunks.js";
import { utf8ByteLength } from "./text-utils.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Batch unavoidable fallback rather than rendering every growing character prefix. */
function graphemeBatches(text: string, targetBytes: number): string[] {
  const batches: string[] = [];
  let body = "";
  let bytes = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = utf8ByteLength(segment);
    if (body && bytes + size > targetBytes) {
      batches.push(body);
      body = "";
      bytes = 0;
    }
    body += segment;
    bytes += size;
  }
  if (body) batches.push(body);
  return batches;
}

/** Pack complete Markdown units in source order, measuring the actual output. */
export function packMarkdownText(
  value: string,
  maxBytes: number,
  measure: (body: string) => number,
  prefixForPart: (index: number) => string = () => "",
): string[] {
  const parts: string[] = [];
  let body = "";
  const pending = markdownChunks(value)
    .map((text) => ({ text, level: 0 }))
    .reverse();
  const fits = (text: string): boolean => measure(`${prefixForPart(parts.length)}${text}`) <= maxBytes;
  const flush = (): void => {
    parts.push(`${prefixForPart(parts.length)}${body}`);
    body = "";
  };

  while (pending.length > 0) {
    const unit = pending.pop()!;
    if (fits(body + unit.text)) {
      body += unit.text;
      continue;
    }
    if (body.length > 0 && fits(unit.text)) {
      flush();
      pending.push(unit);
      continue;
    }

    // Refine only units that cannot fit in an otherwise empty message. Normal
    // links, code spans and blocks remain intact; oversized ones must degrade.
    const smaller =
      unit.level === 0
        ? refineMarkdownChunk(unit.text)
        : unit.level === 1
          ? graphemeBatches(unit.text, Math.max(1, Math.floor(maxBytes / 8)))
          : unit.level === 2
            ? [...graphemes.segment(unit.text)].map(({ segment }) => segment)
            : [...unit.text];
    if (smaller.length <= 1) {
      if (unit.level >= 3 && [...unit.text].length <= 1) {
        throw new RangeError("maxMatrixMessageBytes cannot fit one Unicode code point");
      }
      pending.push({ text: unit.text, level: unit.level + 1 });
    } else {
      for (const text of smaller.reverse()) pending.push({ text, level: unit.level + 1 });
    }
  }
  if (body.length > 0) flush();
  return parts;
}
