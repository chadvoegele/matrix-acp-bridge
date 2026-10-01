+++
name = "Remove project doc references from source"
creation_date = 2026-10-01T18:01:40Z
status = "pending"
+++

# Remove project documentation references from source

User clarification: docs are for tracking specifications before implementation, not something source code should refer users to. In particular remove 'see docs/thread-sessions-state.md for recovery and restore-backup rollback' from bridge-state source/error messages. Update existing PR #16.

Audit src/ production code and comments for references to repository docs/ or specifications/ files. Remove those references and replace runtime recovery text with concise self-contained actionable guidance (stop bridge, verify identity/private permissions/filesystem as appropriate; backups are user-managed). Do not refer to a bridge-created backup or automatic restore mechanism. Preserve error categories, sanitization, state behavior, and useful explanatory comments. Update tests asserting changed text. Do not remove links to external protocol specifications merely because the term spec appears, and do not delete tracking documents or change unrelated documentation.

Another WAAP agent aa-remove-state-backup-codex-61-sol is removing automatic backups and may already change this text. Work in an isolated task branch/WAAP worktree from latest origin/feat/thread-scoped-sessions; fetch/rebase onto latest remote before final push and ensure final code includes both requests. If remote races, retry safely without force. Run npm run check and git diff --check, audit no project-doc references remain in production src. Commit and push HEAD:feat/thread-scoped-sessions to update PR #16, never merge PR/default branch.

Maintain agent-specific work_log.md and update ticket status via WAAP CLI; report commit/check outcomes. Public comments must be marked Chad's Agent. No production state changes or service restarts.
