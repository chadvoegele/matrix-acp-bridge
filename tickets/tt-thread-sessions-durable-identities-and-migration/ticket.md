+++
name = "Thread sessions durable identities and migration"
creation_date = 2026-09-30T19:04:32Z
status = "completed"
depends_on = ["tt-thread-sessions-configuration-and-routing-foundations"]
+++

# Thread-scoped agent sessions implementation

## Delivery contract
Approved source of truth: specifications/thread-scoped-agent-sessions.md, merged via GitHub spec PR #13. Repository: github.com/chadvoegele/matrix-acp-bridge. Integrate into feat/thread-scoped-sessions, based on main commit 290091d; target ONE separate implementation PR against main, never merge without the user's approval.

Use isolated agent/ticket worktrees and appropriately named branches. Read relevant source/tests and preceding ticket work logs before editing. Dependency tickets must be integrated into the feature branch before this ticket starts. Commit tested work, integrate it into feat/thread-scoped-sessions (not main), record commit IDs/results in your agent work log, and update ticket status through waap. Coordinate branch integration; never reset/overwrite other agents' work. Tickets that are parallel own separate storage vs outbound areas after shared foundations. Do not launch unrelated agents, expand scope, or create multiple feature PRs.

No changes to ACP session unloading or concurrency semantics: max_concurrent_prompts limits unresolved prompts only and does not count create/load. No aggregate room backlog cap in thread mode. All configured senders are authorized across all configured rooms; mappings confer no authorization. Authorization occurs before session work. Preserve default room behavior.

Verification: npm ci if dependencies are absent; npm run check is the final quality gate (formatting, lint, typecheck, build/test). Add focused tests per ticket and report exact commands/results. Live tests require approved harness setup and truthful disclosure of missing prerequisites. Use relevant skills, keep secrets/private artifacts out of git, mark public comments as Chad's Agent, and do not deploy to production.

## Scope
- Extend session-store and bridge-state boundaries to distinguish room sessions and thread records; thread records can be known without a session ID. Use the foundation conversation identity. Preserve room API compatibility where practical.
- Persist thread/session mappings before first prompt when session/load is supported. Atomically reset a thread to a durable known/sessionless record, allowing restart before the next prompt to create a fresh session. Admission can retain known/sessionless identity while setup is pending; rejected roots must not create such records. Do not eagerly load sessions.
- Preserve both modes' records across mode switches. Prune all records for removed allowed_rooms; changing allowed_senders must not delete records. When loading is unsupported, discard unusable prior mappings/identities consistently and let old threads become unknown; retain live in-process thread identity. No age/count/inactivity eviction.
- Design and implement automatic migration from the current main schema (currently version 12; inspect actual baseline), preserving account identity, initialized status, completed IDs and SDK sync recovery state. Keep SDK-owned sync cursor handling intact. Create a private pre-migration backup before replacement; do not overwrite an original backup on subsequent starts. Backup/migration failure stops startup without overwriting original state. Maintain lock ownership, atomic-write durability and sanitized errors.
- Unsupported/corrupt state fails with guidance, never silently resets. Document and test stop/restore-backup rollback to the old binary, explicitly losing post-migration state. Do not add an export tool.

## Files / boundaries
Own src/session-store.ts, src/bridge-state.ts and their tests, with focused state contracts consumed by the coordinator ticket. Avoid modifying bridge.ts concurrently with other work.

## Acceptance
Tests cover root/room isolation including duplicate root strings in different rooms, optional session IDs, durable reset, migration and repeated startup, backup permissions, backup/write/fsync/rename failure safety, removed-room pruning, both-mode retention and no-load behavior. Existing recovery-ledger and room-state tests remain green.
