+++
name = "ACP activity HTML renderer"
creation_date = 2026-09-27T12:20:06Z
status = "pending"
depends_on = ["tt-acp-and-matrix-edit-foundations"]
+++

# Render bounded ACP activity as Matrix HTML

Implement the pure activity model/renderer for `specifications/verbose-acp-output.md` on `feat/verbose-acp-output`; use the ACP/Matrix contracts from the foundation ticket. This ticket does not own coordinator orchestration or the PR.

Scope:
- Normalize thought runs and evolving tool calls by `toolCallId`; use `messageId` when present, fallback consecutive thought grouping, ignore whitespace-only `"\n\n"` as a new thought. Preserve escaped readable plain-text fallback. No duplication from `rawOutput` when displayable content exists.
- Render pending/running/completed/failed rails and tinted titles; Read/Write/Edit/Execute examples, pi-acp terminal output streaming and status. Writes/edits show returned old/new strings (not a computed unified patch), line-number gutters counted from complete file text and `-`/`+` before numbers. ACP `locations[].line` is not a hunk range. Treat unknown tool shapes safely.
- Implement limits: tool output visible 1 KiB and detailed 8 KiB; terminal title visible 160 Unicode characters and detailed 2 KiB. Long command title itself and long output preview itself are separate clickable `<summary>` controls, with expanded `<pre><code>`. Mark `(truncated)` on the summary only if the expanded text is cut. Read/file previews use head; streaming terminal summary uses recent tail and detail uses first 6 KiB + last 2 KiB when over cap. Keep buffers bounded, escape all HTML, handle UTF-8 boundaries, control sequences and pathological short lines. Test nested HTML and fallback/plain text.
- Prefer a small independently testable module and exhaustive focused tests; avoid coupling to Matrix SDK. No invented ACP result data or leaked traces.

Acceptance: `npm run check` passes and unit tests cover each example, malformed/missing updates, extreme output lengths, exact cutoff, streaming tails, special HTML characters, status progression, and safe plain fallback. Signed commit if available; merge to shared feature branch, not main; no PR.
