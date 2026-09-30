import { escapeHtml } from "./html.js";

declare const safeMatrixHtml: unique symbol;

/** HTML assembled from static markup and escaped dynamic values. */
export type MatrixSafeHtml = string & { readonly [safeMatrixHtml]: true };

export function matrixHtml(
  strings: TemplateStringsArray,
  ...values: readonly (string | number)[]
): MatrixSafeHtml {
  let result = strings[0] ?? "";
  for (const [index, value] of values.entries()) {
    result += escapeHtml(String(value));
    result += strings[index + 1] ?? "";
  }
  return result as MatrixSafeHtml;
}
