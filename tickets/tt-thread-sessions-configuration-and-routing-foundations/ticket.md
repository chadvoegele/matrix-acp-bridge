+++
name = "Thread sessions configuration and routing foundations"
creation_date = 2026-09-30T19:04:32Z
status = "pending"
+++

# Thread-scoped agent sessions implementation

## Delivery contract
Approved source of truth: specifications/thread-scoped-agent-sessions.md, merged via GitHub spec PR #13. Repository: github.com/chadvoegele/matrix-acp-bridge. Integrate into feat/thread-scoped-sessions, based on main commit 290091d; target ONE separate implementation PR against main, never merge without the user's approval.

Use isolated agent/ticket worktrees and appropriately named branches. Read relevant source/tests and preceding ticket work logs before editing. Dependency tickets must be integrated into the feature branch before this ticket starts. Commit tested work, integrate it into feat/thread-scoped-sessions (not main), record commit IDs/results in your agent work log, and update ticket status through waap. Coordinate branch integration; never reset/overwrite other agents' work. Tickets that are parallel own separate storage vs outbound areas after shared foundations. Do not launch unrelated agents, expand scope, or create multiple feature PRs.

No changes to ACP session unloading or concurrency semantics: max_concurrent_prompts limits unresolved prompts only and does not count create/load. No aggregate room backlog cap in thread mode. All configured senders are authorized across all configured rooms; mappings confer no authorization. Authorization occurs before session work. Preserve default room behavior.

Verification: npm ci if dependencies are absent; npm run check is the final quality gate (formatting, lint, typecheck, build/test). Add focused tests per ticket and report exact commands/results. Live tests require approved harness setup and truthful disclosure of missing prerequisites. Use relevant skills, keep secrets/private artifacts out of git, mark public comments as Chad's Agent, and do not deploy to production.

## Scope
- Add `[matrix] response_mode = room | thread`, default room; reject unknown values. Add `[limits] max_queued_turns_per_thread`, independent default 16 with existing queue validation. Keep max_concurrent_prompts unchanged. Update strict config parsing, serialization, examples, and config tests.
- Define a typed conversation identity that distinguishes a room conversation from `(room ID, thread root event ID)` without ambiguous string concatenation. Keep authorization separate from session ownership; all allowed senders share access to known threads in allowed rooms.
- Extend normalized inbound metadata and authorizer options for thread routing. Room mode still rejects m.thread. Thread mode accepts standard m.thread relations with a valid root event_id, optional boolean is_falling_back, and optional valid m.in_reply_to event_id; define/test supported shapes explicitly. Route by root, never fallback target. Ordinary m.in_reply_to remains a new top-level conversation. Reject edits, unsupported/malformed relations, redactions and unauthorized/self messages.
- Strip genuine reply fallback only when indicated by supported relation metadata; preserve ordinary quotes, especially thread messages without fallback replies. Preserve enough validated routing metadata for oversized errors without allowing unauthorized events to trigger responses.

## Files / boundaries
Start with src/config.ts, src/authorization.ts, their tests, and a small shared conversation-identity module if useful. Define narrow cross-ticket contracts for optional thread roots on inbound/output metadata; do not implement storage or the coordinator here. Document contracts in the work log for dependent tickets.

## Acceptance
Unit tests cover default room compatibility, independent queue defaults, bad mode/limit values, thread-only authorization, root vs fallback targeting, malformed IDs/types, ordinary replies/quotes, and authorization-before-any-session-operation. Build/typecheck and targeted tests pass.
