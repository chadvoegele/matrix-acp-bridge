import { markdownReferences, markdownToMatrixHtml, type MarkdownReferences } from "./matrix-markdown.js";
import { packMarkdownText } from "./markdown-packing.js";
import { matrixHtml } from "./matrix-html.js";
import { matrixHtmlContentBytes, type MatrixHtmlBody } from "./matrix-message-content.js";

export interface MatrixTextChunk {
  readonly rendered: MatrixHtmlBody;
  readonly nextOffset: number;
}

export type MatrixTextMeasure = (rendered: MatrixHtmlBody) => number;

export function renderMatrixText(body: string, references: MarkdownReferences = {}): MatrixHtmlBody {
  const formattedBody = markdownToMatrixHtml(body, references);
  // Whitespace and reference definitions can render empty, but the HTML send
  // API requires a nonempty value. Preserve their source without visible text.
  return { body, formattedBody: formattedBody || (body.length > 0 ? matrixHtml`<p></p>` : "") };
}

/** Keep the multipart label from changing the following block's Markdown context. */
export function renderMatrixMultipartText(body: string, references: MarkdownReferences): MatrixHtmlBody {
  const separator = body.indexOf("\n");
  const rendered = renderMatrixText(body.slice(separator + 1), references);
  return {
    ...rendered,
    body,
    formattedBody: matrixHtml`${body.slice(0, separator)}<br>\n` + rendered.formattedBody,
  };
}

/** Greedily pack Markdown units; the caller supplies any routing-aware wire budget. */
export function renderMatrixTextChunks(
  body: string,
  maxBytes: number,
  measure: MatrixTextMeasure = matrixHtmlContentBytes,
  references: MarkdownReferences = markdownReferences(body),
): MatrixHtmlBody[] {
  if (body.length === 0) return [];
  const render = (text: string): MatrixHtmlBody => renderMatrixText(text, references);
  const measureText = (text: string): number => measure(render(text));
  const bodies = measureText(body) <= maxBytes ? [body] : packMarkdownText(body, maxBytes, measureText);
  return bodies.map((text) => render(text));
}

/** Compatibility helper for callers that consume one Unicode-indexed chunk. */
export function renderMatrixTextChunk(
  characters: readonly string[],
  offset: number,
  maxBytes: number,
  measure: MatrixTextMeasure = matrixHtmlContentBytes,
): MatrixTextChunk | undefined {
  if (offset >= characters.length) return;
  try {
    const rendered = renderMatrixTextChunks(
      characters.slice(offset).join(""),
      maxBytes,
      measure,
      markdownReferences(characters.join("")),
    )[0];
    return rendered === undefined ? undefined : { rendered, nextOffset: offset + [...rendered.body].length };
  } catch (error) {
    if (error instanceof RangeError) return;
    throw error;
  }
}
