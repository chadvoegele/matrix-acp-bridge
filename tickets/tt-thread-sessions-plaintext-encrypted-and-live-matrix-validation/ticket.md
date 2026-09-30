+++
name = "Thread sessions plaintext encrypted and live Matrix validation"
creation_date = 2026-09-30T19:04:33Z
status = "pending"
depends_on = ["tt-thread-sessions-integrated-regression-and-operator-documen-8d5b"]
+++

# Thread-scoped agent sessions implementation

## Delivery contract
Approved source of truth: specifications/thread-scoped-agent-sessions.md, merged via GitHub spec PR #13. Repository: github.com/chadvoegele/matrix-acp-bridge. Integrate into feat/thread-scoped-sessions, based on main commit 290091d; target ONE separate implementation PR against main, never merge without the user's approval.

Use isolated agent/ticket worktrees and appropriately named branches. Read relevant source/tests and preceding ticket work logs before editing. Dependency tickets must be integrated into the feature branch before this ticket starts. Commit tested work, integrate it into feat/thread-scoped-sessions (not main), record commit IDs/results in your agent work log, and update ticket status through waap. Coordinate branch integration; never reset/overwrite other agents' work. Tickets that are parallel own separate storage vs outbound areas after shared foundations. Do not launch unrelated agents, expand scope, or create multiple feature PRs.

No changes to ACP session unloading or concurrency semantics: max_concurrent_prompts limits unresolved prompts only and does not count create/load. No aggregate room backlog cap in thread mode. All configured senders are authorized across all configured rooms; mappings confer no authorization. Authorization occurs before session work. Preserve default room behavior.

Verification: npm ci if dependencies are absent; npm run check is the final quality gate (formatting, lint, typecheck, build/test). Add focused tests per ticket and report exact commands/results. Live tests require approved harness setup and truthful disclosure of missing prerequisites. Use relevant skills, keep secrets/private artifacts out of git, mark public comments as Chad's Agent, and do not deploy to production.

## Scope
- Extend existing agent_tests/e2e-support, unencrypted-e2e and encrypted-e2e harnesses rather than create an unrelated test system. Add repeatable thread-mode scenarios with independent roots/sessions in one room, concurrent turns, thread-local reset, unknown/rejected-root follow-ups, lazy restart and no-load behavior where supported.
- Verify actual Matrix relations on plain and decrypted events, thread placement of ordinary/verbose multipart output, replacements' m.new_content relations, deterministic retry safety, unthreaded top-level reset guidance and required-encryption no-fallback behavior. Include room-mode smoke/regression scenarios.
- Run live Matrix tests using the established test setup only after inspecting its instructions. Confirm display and follow-ups in the deployment Matrix client when feasible. Do not send test prompts to unrelated production conversations. Use password-secrets skill for credentials; keep tokens, IDs/private artifacts and logs ignored and redact work-log output.
- Ensure cleanup captures all created ACP session IDs, including sessions detached by reset, and cleans test resources using current harness conventions. Do not pretend deleting bridge mappings deletes agent history.
- Fix discovered implementation/test gaps and repeat relevant checks. If live credentials/client access is unavailable, record exact unmet prerequisites and residual risks; do not fabricate passes.

## Acceptance
Automated E2E tests and available live plaintext/encrypted scenarios pass; record commands/results and any externally blocked manual display check. npm run check remains green after remediation.
