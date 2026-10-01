+++
name = "Final PR16 review merge cleanup Codex 6.1 Sol"
creation_date = 2026-10-01T18:12:58Z
status = "ready"
+++

Carry out WAAP ticket tt-full-pr-16-review-conditional-merge-and-cleanup at /home/chad/.local/state/waap/data/home/chad/code/github.com/chadvoegele/matrix-acp-bridge/tickets/tt-full-pr-16-review-conditional-merge-and-cleanup/ticket.md. Read it completely and follow repository/user guidance. This run is scheduled after the queue-limit ticket completes. User explicitly requests full PR #16 review, then merge if okay, then safe cleanup.

Use isolated WAAP worktree/task branch from latest PR head. Independently review the complete PR against current default branch and all comments, verify final user requirements, run full checks, verify exact-head CI. Fix clear issues minimally and reverify, but do not merge if blockers/uncertainty remain. If all okay, merge #16 with exact head guard, update clean local main, and safely clean only this PR's verified merged/clean/inactive worktrees/branches as described in ticket. Never stop production services, discard user changes, or remove unrelated/active/WAAP worktrees. Runner cleans your own worktree at exit.

Use git-repositories/password-secrets skills and nopass_pass.sh p/github.com/chadvoegele/admin_token without exposing secrets. Public comments marked Chad's Agent. Maintain agent-specific WAAP work_log.md and ticket status via CLI. Report review/checks/CI/merge commit and cleanup or blockers accurately. Keep durable WAAP state outside source commits.
