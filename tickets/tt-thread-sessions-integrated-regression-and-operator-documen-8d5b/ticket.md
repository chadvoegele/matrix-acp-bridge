+++
name = "Thread sessions integrated regression and operator documentation"
creation_date = 2026-09-30T19:04:33Z
status = "in-progress"
depends_on = ["tt-thread-sessions-coordinator-queues-reset-and-lifecycle"]
+++

# Thread-scoped agent sessions implementation

## Delivery contract
Approved source of truth: specifications/thread-scoped-agent-sessions.md, merged via GitHub spec PR #13. Repository: github.com/chadvoegele/matrix-acp-bridge. Integrate into feat/thread-scoped-sessions, based on main commit 290091d; target ONE separate implementation PR against main, never merge without the user's approval.

Use isolated agent/ticket worktrees and appropriately named branches. Read relevant source/tests and preceding ticket work logs before editing. Dependency tickets must be integrated into the feature branch before this ticket starts. Commit tested work, integrate it into feat/thread-scoped-sessions (not main), record commit IDs/results in your agent work log, and update ticket status through waap. Coordinate branch integration; never reset/overwrite other agents' work. Tickets that are parallel own separate storage vs outbound areas after shared foundations. Do not launch unrelated agents, expand scope, or create multiple feature PRs.

No changes to ACP session unloading or concurrency semantics: max_concurrent_prompts limits unresolved prompts only and does not count create/load. No aggregate room backlog cap in thread mode. All configured senders are authorized across all configured rooms; mappings confer no authorization. Authorization occurs before session work. Preserve default room behavior.

Verification: npm ci if dependencies are absent; npm run check is the final quality gate (formatting, lint, typecheck, build/test). Add focused tests per ticket and report exact commands/results. Live tests require approved harness setup and truthful disclosure of missing prerequisites. Use relevant skills, keep secrets/private artifacts out of git, mark public comments as Chad's Agent, and do not deploy to production.

## Scope
- Audit every acceptance requirement in specifications/thread-scoped-agent-sessions.md against implementation and add missing deterministic unit/integration tests. Include authorization and malformed relations, cross-room root isolation, unknown threads, pending sessions, reset followed by restart, mode switches, no-load agents, stale-load recovery, setup failures, concurrent activity edits, encryption, dedup/retry and original room behavior.
- Test global prompt limit without counting concurrent create/load work and independent thread queue limits. Test full queue behavior for reset and known-thread input; a newly rejected top-level root remains unknown. Cover catch-up dispatch and completed-ID semantics under multiple threads, preserving existing per-room catch-up bounds.
- Exercise migration fault injection and old-schema backup restore. Ensure known/sessionless records survive restarts only under supported loading and room removal cleans inactive-mode records too.
- Update README, config.toml.example and operator docs for mode/queue configuration, shared authorized-user contexts, root/reply behavior, exact errors/reset guidance, durable migration and rollback, lazy load/no-load limitations, unbounded idle histories, concurrent setup and unchanged prompt-only limits. Keep future MCP behavior and unloading out of scope.
- Run npm run check and inspect baseline vs feature diff; fix issues and regressions, not just tests. Do not broadly reformat unrelated files or weaken checks.

## Acceptance
All automated checks pass with a concise spec-to-test coverage map in the work log. Every documented decision matches observed code/test behavior. No credentials, private traces or waap state appear in the feature branch.
