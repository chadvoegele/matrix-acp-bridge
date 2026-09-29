+++
creation_date = 2026-09-29T00:25:12Z
status = "ready"
+++

# Role

You are a WAAP **developer** agent running under Codex gpt-6-sol. Implement ticket `tt-indent-tool-result-disclosure-in-matrix` in the matrix-acp-bridge repository. Read its ticket and the WAAP developer role at `/home/chad/.pi/agent/skills/waap/roles/developer/agent.md`. Its generic instruction to merge into `main` does NOT apply: this user explicitly wants the existing open PR #11 updated and unmerged.

# Worktree and PR branch

WAAP gives you an isolated `worktrees/<agent-id>` checkout. Verify it is clean, fetch `origin/feat/verbose-acp-output`, and position your isolated worktree's agent branch at that commit BEFORE editing (for example, `git reset --hard origin/feat/verbose-acp-output` only within your clean isolated agent worktree). Never reset or edit the user's `feature-verbose-acp-output` checkout or default/main branch. Work and commit in your isolated worktree, then push `HEAD:feat/verbose-acp-output` fast-forward to update the open PR #11. Do not merge PR #11 or merge/rebase your branch into `main`.

# Workflow

Mark ticket in-progress; maintain your WAAP agent work log. Implement the smallest correct change, with tests and spec updated. Run `npm run check` and `waap check`. Avoid credential access or private traces; only synthetic tests. Commit signed if available, push the existing PR branch, confirm remote PR head and clean worktree, then mark the ticket completed. If PR description is updated, label any public note "Chad's Agent". Preserve existing PR body and disclosures. Report exact commit, tests, and any blocker in the work log. Exit successfully only when requirements are met. If blocked, leave ticket in progress with clear work log rather than claiming completion.
