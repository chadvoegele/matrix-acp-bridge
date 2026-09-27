+++
name = "ACP and Matrix edit foundations"
creation_date = 2026-09-27T12:20:00Z
status = "completed"
+++

# ACP activity and Matrix message-edit foundations

Implement transport-level support for `specifications/verbose-acp-output.md` on the shared feature branch `feat/verbose-acp-output`. Do not create a PR or merge main; final integration ticket owns the sole PR.

Scope:
- Extend ACP update parsing/types to preserve `agent_thought_chunk`, `tool_call`, and `tool_call_update`, including optional standard `messageId`, `toolCallId`, `kind`, `status`, `title`, `content`, `locations`, and bounded tool-specific input and pi-acp `_meta.terminal_output`/`terminal_exit`. Unknown/missing fields must not crash the bridge or leak raw traces into diagnostics. Keep existing message/session behavior.
- Extend the Matrix adapter with an explicit safe HTML `m.text` send/edit surface. Matrix edits must use `m.relates_to` (`m.replace`) and `m.new_content` with a readable `body`, `format: org.matrix.custom.html`, and `formatted_body`; return or preserve the target event ID across retries. Respect configured-room and required-encryption gates; preserve existing Markdown sends and crypto failure handling.
- Add focused ACP and Matrix adapter tests for accepted/missing/malformed updates, pi-acp metadata, HTML escaping boundaries at the API, initial-send and replacement payloads, event IDs, retries, encryption gates. No public test data with real credentials, user IDs, or private paths.

Acceptance: `npm run check` passes; tests prove legacy Markdown responses still work. Read the existing adapter interfaces/tests before changing them. Commit signed if available, include ticket+agent IDs in the commit, rebase onto the shared feature branch and fast-forward merge there. Do not modify main or push a PR.
