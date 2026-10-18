/** Ordered cumulative output. finish follows the last flush; IDs are never reused. */
export interface OutputSink<Content> {
  flush(id: string, content: Content): void;
  finish(id: string): void;
}

/** Rendering changes only the payload, preserving identity and retirement order. */
export function renderOutput<Source, Rendered>(
  sink: OutputSink<Rendered>,
  render: (content: Source) => Rendered,
  onError: (error: unknown) => void,
): OutputSink<Source> {
  return {
    flush: (id, content) => {
      try {
        sink.flush(id, render(content));
      } catch (error) {
        onError(error);
      }
    },
    finish: (id) => sink.finish(id),
  };
}
