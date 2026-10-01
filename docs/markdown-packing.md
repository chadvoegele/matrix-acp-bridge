# Markdown-aware message packing

Live agent text and threaded multipart responses share a greedy packer:

1. Use the Markdown parser's source maps to keep complete top-level blocks.
2. Add consecutive units while the actual serialized Matrix payload fits.
3. Refine an oversized block into words and protected inline constructs.
4. Only if a construct cannot fit alone, use bounded grapheme batches, then
   individual graphemes and code points when necessary. Every emitted candidate
   still passes the exact byte counter.

Links, images, code spans and common paired emphasis stay intact when they fit.
The inline boundary scanner is conservative, not a second CommonMark parser;
complex emphasis is best-effort. Oversized fences, lists and other indivisible
constructs may lose formatting. No synthetic delimiters are inserted: concatenated
message bodies, excluding multipart labels, reconstruct the original source.

Rendering is independent of room/thread routing. Payload measurement adds the
routing metadata at the serialization boundary. Multipart HTML renders its label
separately so it cannot change the following block's Markdown interpretation.
Reference definitions are collected once and shared across parts; the Matrix
adapter sends the prepared, escaped HTML rather than re-rendering each fragment.
Whitespace and definition-only chunks use an empty paragraph as their nonempty
HTML envelope, preserving their source without interrupting live delivery.

Packing preserves source order and is greedy, not globally optimal. Room-mode
non-live responses retain their established plain-text splitting policy.
