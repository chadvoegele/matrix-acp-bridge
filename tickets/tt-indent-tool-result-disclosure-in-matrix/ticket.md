+++
name = "Indent tool result disclosure in Matrix"
creation_date = 2026-09-29T00:24:52Z
status = "in-progress"
+++

# Indent live tool results beneath their tool call

Implement the Element-tested layout D in the open implementation PR #11, branch `feat/verbose-acp-output` (not `main`). User approved the test message named "D · indented collapsible long output" in the existing plaintext Matrix test room. It had a tool title and code input, followed by a `<blockquote>` containing a result `<details>` whose `<summary><code>` held the short preview and whose expanded `<pre><code>` held the bounded full result. The user requested no "Result · completed" label or connector line inside this indented block. A short result should also be indented under the corresponding tool call in a `<blockquote><pre><code>…</code></pre></blockquote>`.

Requirements:
- Apply to tool results generally, including `mcpScript`, not only the scripted example. Preserve status-colored tool title rail, code-input disclosure, output preview rules (256 UTF-8 bytes or 3 lines), expanded output cap (8 KiB), readable plain-text fallback, sanitization and Matrix size limits.
- Put the *entire result* (its compact preview summary AND expanded code for long output, or plain code for short output) inside `<blockquote>`. The quote bar must be outside `<pre><code>`, not copied as literal result content. Do not add "Result · completed" or a dangling arrow label. Existing status remains in the tool title and fallback as appropriate.
- Keep archived batching, late edits, and original tool-call correlation unchanged. Account for HTML wrapper bytes in render budgeting; avoid fallback unexpectedly dropping script or preview in normal cases.
- Update `specifications/verbose-acp-output.md` and focused renderer/bridge/wire tests. Test both short and long outputs, HTML escaping, plain text, and source/result separation for `mcpScript`. Run `npm run check`.
- No private Matrix IDs, credentials, real scripts, private memory contents, or unsanitized traces in code/tests/spec/PR. Do not run provisioning-heavy live Matrix tests unless reliable; the already-sent synthetic message D is the visual reference.
- Commit signed if available and push directly to `origin/feat/verbose-acp-output` to update PR #11. Keep PR open for user review. Update PR description with this change and test count if possible; do not merge into `main`. Mark WAAP ticket complete only after push/verification. Record progress in the WAAP agent work log.
