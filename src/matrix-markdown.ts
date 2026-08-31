import MarkdownIt from "markdown-it";

/** Matrix's standard rich-text format for m.room.message events. */
export const MATRIX_HTML_FORMAT = "org.matrix.custom.html" as const;

// Match the Markdown behavior used by the Matrix clients checked into this
// workspace. Raw HTML stays text, while ordinary Markdown becomes safe Matrix
// HTML. markdown-it also rejects unsafe link protocols.
const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

markdown.enable("strikethrough");

/** Render an ACP Markdown response as Matrix formatted_body HTML. */
export function markdownToMatrixHtml(value: string): string {
  return markdown.render(value).trimEnd();
}
