+++
name = "Conversation queue limit Codex 6.1 Sol"
creation_date = 2026-10-01T18:05:49Z
status = "running"
system = "codex"
+++

Implement WAAP ticket tt-consolidate-per-conversation-queue-limit at /home/chad/.local/state/waap/data/home/chad/code/github.com/chadvoegele/matrix-acp-bridge/tickets/tt-consolidate-per-conversation-queue-limit/ticket.md. Read it fully and follow repository guidance. Use one new per-conversation limit internally/config, keep the old room key only as legacy parse alias, README only new name.

Use isolated WAAP worktree/task branch from latest origin/feat/thread-scoped-sessions. Implement/test/commit and push HEAD:feat/thread-scoped-sessions non-forced to update PR #16; never merge PR/default branch. Fetch/rebase immediately before final push to preserve concurrent agents' changes and retry races safely. Do not edit other worktrees.

Use applicable git-repositories/password-secrets skills. If GitHub authentication is needed use nopass_pass.sh p/github.com/chadvoegele/admin_token without exposing secrets. Update ticket status via WAAP CLI, maintain agent-specific work_log.md, report commit/check outcomes. Keep WAAP artifacts outside source commits. Public comments marked Chad's Agent. No production state changes or service restarts.
