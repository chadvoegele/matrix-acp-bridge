+++
name = "Thread sessions final review and one GitHub implementation PR"
creation_date = 2026-09-30T19:04:33Z
status = "completed"
depends_on = ["tt-thread-sessions-plaintext-encrypted-and-live-matrix-validation"]
+++

# Thread-scoped agent sessions implementation

## Delivery contract
Approved source of truth: specifications/thread-scoped-agent-sessions.md, merged via GitHub spec PR #13. Repository: github.com/chadvoegele/matrix-acp-bridge. Integrate into feat/thread-scoped-sessions, based on main commit 290091d; target ONE separate implementation PR against main, never merge without the user's approval.

Use isolated agent/ticket worktrees and appropriately named branches. Read relevant source/tests and preceding ticket work logs before editing. Dependency tickets must be integrated into the feature branch before this ticket starts. Commit tested work, integrate it into feat/thread-scoped-sessions (not main), record commit IDs/results in your agent work log, and update ticket status through waap. Coordinate branch integration; never reset/overwrite other agents' work. Tickets that are parallel own separate storage vs outbound areas after shared foundations. Do not launch unrelated agents, expand scope, or create multiple feature PRs.

No changes to ACP session unloading or concurrency semantics: max_concurrent_prompts limits unresolved prompts only and does not count create/load. No aggregate room backlog cap in thread mode. All configured senders are authorized across all configured rooms; mappings confer no authorization. Authorization occurs before session work. Preserve default room behavior.

Verification: npm ci if dependencies are absent; npm run check is the final quality gate (formatting, lint, typecheck, build/test). Add focused tests per ticket and report exact commands/results. Live tests require approved harness setup and truthful disclosure of missing prerequisites. Use relevant skills, keep secrets/private artifacts out of git, mark public comments as Chad's Agent, and do not deploy to production.

## Scope
- Review the entire feature diff against the approved spec, prior ticket work logs and test evidence. Remediate any security, routing, persistence, concurrency or compatibility gaps and rerun relevant tests plus npm run check. Validate waap state with waap check.
- Ensure only planned implementation/tests/docs and the delivery plan appear on feat/thread-scoped-sessions; no waap state, credentials, private test artifacts or unrelated feature changes.
- Push the feature branch and create exactly ONE new GitHub implementation PR against main, or update the existing PR for that branch if one already exists. Spec PR #13 is already merged; this is a distinct PR. Do not merge the implementation PR or push implementation directly to main.
- Mark human-facing PR description/comments as `Chad's Agent`; include concise scope, verification commands/results, migration/rollback notes, known limitations and truthful externally blocked validation. Request review from Chad if the hosting service permits it (do not request an unrelated account named chad or self-review). Record PR URL in ticket work log/completion output.

## Acceptance
One reviewable implementation PR targets main, with green checks or transparent external blockers and a complete spec coverage audit. Leave merging for the user's approval.
