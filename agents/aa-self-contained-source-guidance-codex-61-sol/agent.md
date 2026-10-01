+++
name = "Self contained source guidance Codex 6.1 Sol"
creation_date = 2026-10-01T18:01:57Z
status = "running"
session_id = "01a0f8a1-70f4-7e10-bec3-b1cf8e66aa71"
system = "codex"
+++

Implement WAAP ticket tt-remove-project-doc-references-from-source at /home/chad/.local/state/waap/data/home/chad/code/github.com/chadvoegele/matrix-acp-bridge/tickets/tt-remove-project-doc-references-from-source/ticket.md. Read fully and follow repository guidance. Remove repository-doc links from source code/comments/runtime guidance, keep recovery instructions self-contained.

Work in isolated WAAP worktree/task branch based on latest origin/feat/thread-scoped-sessions. Another agent removes automatic state backups and may touch same code. Coordinate by fetching/rebasing current remote before final push, preserving their changes. Implement/test/commit and push HEAD:feat/thread-scoped-sessions non-forced to update PR #16, do not merge PR/default branch. Never edit others' worktrees. If no changes remain after concurrent agent's work, verify and report that rather than adding churn.

Use applicable git-repositories/password-secrets skills. For GitHub auth use nopass_pass.sh p/github.com/chadvoegele/admin_token without exposing secrets. Maintain agent-specific work_log.md, update ticket status via WAAP CLI, report verification/commit. Public comments marked Chad's Agent. No private production state or service changes.
