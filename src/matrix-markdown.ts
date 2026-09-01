import MarkdownIt from "markdown-it";

export const MATRIX_HTML_FORMAT = "org.matrix.custom.html" as const;

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

markdown.enable("strikethrough");

export function markdownToMatrixHtml(value: string): string {
  return markdown.render(value).trimEnd();
}
