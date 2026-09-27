+++
name = "Developer live activity remediation"
creation_date = 2026-09-27T13:28:10Z
status = "ready"
+++

# WAAP developer remediation
Use Codex gpt-6-sol to complete `tt-remediate-live-activity-validation`. Read `/home/chad/.pi/agent/skills/waap/SKILL.md`, the ticket, repository spec and live test harness. `waap agent run` prepares your isolated worktree; set ticket in-progress, keep chronological work log, run `waap check`. WAAP state mutation must run outside sandbox with elevated permissions when needed.

# Feature integration and PR
Existing feature branch `feat/verbose-acp-output` is in sibling `feature-verbose-acp-output`. Rebase your agent branch onto it BEFORE edits. After signed commit(s) and tests, rebase if needed, fast-forward merge to feature worktree, push feature branch and update EXISTING PR #11 only. NEVER merge main and NEVER create another PR. Use password-secrets skill and per-command GH_TOKEN for gh access; do not print decrypted tokens. Keep credentials, Matrix IDs, and private traces out of public PR/code. Your ticket references an ignored canonical-root `.env` with live test prerequisites; source it safely (no `set -x`) for tests, not into tracked files. Test wrappers perform cleanup; verify no residual state after each run. Update PR body with actual results. Mark ticket completed only after integrating feature and verifying state. Include your agent+ticket IDs in commits.
