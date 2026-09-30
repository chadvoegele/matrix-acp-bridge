import { markdownToMatrixHtml } from "./matrix-markdown.js";
import { matrixHtmlContentBytes, type MatrixHtmlBody, type MatrixOutputRouting } from "./matrix-message-content.js";

export interface MatrixTextChunk {
  readonly rendered: MatrixHtmlBody;
  readonly nextOffset: number;
}

export function renderMatrixText(body: string, routing: MatrixOutputRouting = {}): MatrixHtmlBody {
  return {
    ...(routing.threadRootEventId === undefined ? {} : { threadRootEventId: routing.threadRootEventId }),
    ...(routing.threadFallbackEventId === undefined ? {} : { threadFallbackEventId: routing.threadFallbackEventId }),
    body,
    formattedBody: markdownToMatrixHtml(body),
  };
}

/** Find the next Unicode-safe Markdown chunk that fits a Matrix message. */
export function renderMatrixTextChunk(
  characters: readonly string[],
  offset: number,
  maxBytes: number,
  routing: MatrixOutputRouting = {},
): MatrixTextChunk | undefined {
  let low = 1;
  let high = characters.length - offset;
  let fitting = 0;
  let rendered: MatrixHtmlBody | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const body = characters.slice(offset, offset + middle).join("");
    const candidate = renderMatrixText(body, routing);
    if (matrixHtmlContentBytes(candidate) <= maxBytes) {
      fitting = middle;
      rendered = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return rendered === undefined ? undefined : { rendered, nextOffset: offset + fitting };
}
