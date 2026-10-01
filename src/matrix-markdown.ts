import MarkdownIt from "markdown-it";

export const MATRIX_HTML_FORMAT = "org.matrix.custom.html" as const;

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

markdown.enable("strikethrough");

/** Top-level block line ranges, using the same parser and normalization as rendering. */
export function markdownBlockMaps(value: string): Array<[number, number]> {
  const tokens: ReturnType<typeof markdown.parse> = [];
  // Match markdown-it's core normalization, but stop before inline processing
  // removes reference-definition tokens. Line numbers still index original lines.
  const normalized = value.replaceAll(/\r\n?/g, "\n").replaceAll("\0", "\uFFFD");
  markdown.block.parse(normalized, markdown, {}, tokens);
  return tokens.filter((token) => token.level === 0 && token.map !== null).map((token) => token.map!);
}

export interface MarkdownReferences {
  readonly [label: string]: { readonly href: string; readonly title: string };
}

/** Keep reference-style links resolvable when their definitions land in another part. */
export function markdownReferences(value: string): MarkdownReferences {
  const environment: { references?: MarkdownReferences } = {};
  markdown.parse(value, environment);
  return environment.references ?? {};
}

export function markdownToMatrixHtml(value: string, references: MarkdownReferences = {}): string {
  // Rendering a candidate may discover definitions; never mutate shared context.
  return markdown.render(value, { references: { ...references } }).trimEnd();
}
