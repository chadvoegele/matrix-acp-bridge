import { MATRIX_HTML_FORMAT } from "./matrix-markdown.js";

export interface MatrixHtmlBody {
  readonly body: string;
  readonly formattedBody: string;
}

/** Build the exact wire content used for both delivery and byte accounting. */
export function matrixHtmlContent(message: MatrixHtmlBody, targetEventId?: string): Readonly<Record<string, unknown>> {
  const newContent = {
    msgtype: "m.text",
    body: message.body,
    format: MATRIX_HTML_FORMAT,
    formatted_body: message.formattedBody,
  } as const;
  return targetEventId === undefined
    ? newContent
    : {
        ...newContent,
        body: `* ${message.body}`,
        formatted_body: `* ${message.formattedBody}`,
        "m.new_content": newContent,
        "m.relates_to": { rel_type: "m.replace", event_id: targetEventId },
      };
}

export function matrixHtmlContentBytes(message: MatrixHtmlBody, targetEventId?: string): number {
  return Buffer.byteLength(JSON.stringify(matrixHtmlContent(message, targetEventId)), "utf8");
}

/** Reserve the edit envelope before its target event ID is known. */
export function matrixHtmlEditContentBytes(message: MatrixHtmlBody): number {
  return matrixHtmlContentBytes(message, `$${"x".repeat(254)}`);
}
