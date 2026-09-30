+++
name = "Thread sessions coordinator queues reset and lifecycle"
creation_date = 2026-09-30T19:04:32Z
status = "completed"
depends_on = ["tt-thread-sessions-durable-identities-and-migration", "tt-thread-sessions-matrix-output-and-edit-routing"]
+++

# Thread-scoped agent sessions implementation

## Delivery contract
Approved source of truth: specifications/thread-scoped-agent-sessions.md, merged via GitHub spec PR #13. Repository: github.com/chadvoegele/matrix-acp-bridge. Integrate into feat/thread-scoped-sessions, based on main commit 290091d; target ONE separate implementation PR against main, never merge without the user's approval.

Use isolated agent/ticket worktrees and appropriately named branches. Read relevant source/tests and preceding ticket work logs before editing. Dependency tickets must be integrated into the feature branch before this ticket starts. Commit tested work, integrate it into feat/thread-scoped-sessions (not main), record commit IDs/results in your agent work log, and update ticket status through waap. Coordinate branch integration; never reset/overwrite other agents' work. Tickets that are parallel own separate storage vs outbound areas after shared foundations. Do not launch unrelated agents, expand scope, or create multiple feature PRs.

No changes to ACP session unloading or concurrency semantics: max_concurrent_prompts limits unresolved prompts only and does not count create/load. No aggregate room backlog cap in thread mode. All configured senders are authorized across all configured rooms; mappings confer no authorization. Authorization occurs before session work. Preserve default room behavior.

Verification: npm ci if dependencies are absent; npm run check is the final quality gate (formatting, lint, typecheck, build/test). Add focused tests per ticket and report exact commands/results. Live tests require approved harness setup and truthful disclosure of missing prerequisites. Use relevant skills, keep secrets/private artifacts out of git, mark public comments as Chad's Agent, and do not deploy to production.

## Scope
- Integrate mode selection, authorization and conversation routing through main/sync composition and BridgeCoordinator. Top-level admitted ordinary messages use their own event IDs as roots; known follow-ups reuse their thread. Unknown-thread follow-ups including /reset get the exact thread error without ACP calls/history replay. Pending admitted/reset threads remain known, not unknown.
- Separate conversation-local queue/session/activity/output routing state from room-scoped state. Serialize turns and reset inside each conversation; different threads in one room run concurrently. max_queued_turns_per_thread counts waiting queue entries as the existing room queue does (one selected entry may be waiting for a global prompt permit outside that queue count). Retain max_queued_turns_per_room in room mode. A full thread does not block other threads.
- Preserve existing max_concurrent_prompts semantics: global limit on unresolved ACP prompt requests only, with release behavior unchanged; session creation/loading does not consume slots or gain a new concurrency limit. No unloading/retention/resource-control feature.
- Persist before prompting when load is supported; lazily restore only requested sessions, suppress history replay, and recover healthy stale sessions only in the affected thread. Preserve global fatal behavior for actual shared ACP transport/protocol failures. Healthy creation/load method failure must not accidentally cross-route, create shared fallback context, or strand an admitted known thread.
- Thread /reset stays ordered, changes durable state first, retains sessionless identity and acknowledges only success. Top-level exact authorized /reset sends unthreaded guidance only, without creating a session/thread record. No ACP history deletion or cancellation of other work.
- Oversized/busy rejected top-level roots get applicable threaded errors but remain unknown; valid follow-ups to them get unknown-thread error. Known-thread busy/oversized events do not change its context. Preserve authorization-first rejection and duplicate suppression.
- Carry originating root through agent text, all verbose activity including late edits, multipart output and lifecycle/error responses. Aggregate room typing so finishing one thread cannot clear another's indicator. Preserve existing unthreaded receipts, catch-up age/count bounds, completed-ID recovery, intake/reconnect, cancellation, shutdown and retry guarantees; keep per-room recovery bounds rather than multiplying by threads.

## Files / boundaries
Own src/bridge.ts and src/main.ts integration plus bridge/main/sync-coordinator tests and activity-coordinator wiring. Keep SDK crypto, sync cursor ownership, shared state locking and room mode behavior intact. Prefer minimal refactoring over a new scheduler architecture.

## Acceptance
Focused tests prove independent sessions and simultaneous threads, serial same-thread queue/reset, correct queue and prompt bounds, pending-creation routing, reset/restart behavior, unknown/rejected-root errors, no cross-thread output/activity edits, lazy recovery, typing reference lifecycle, receipts, fatal setup failures and safe shutdown.
