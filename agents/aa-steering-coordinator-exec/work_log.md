# aa-steering-coordinator-exec work log

Agent: `aa-steering-coordinator-exec`
Ticket: `tt-steering-coordinator-lane-and-lifecycle`
Branch: `aa-steering-coordinator-exec`

## 2026-10-01 — Investigation

- Read launcher instructions, both WAAP skill copies and developer role, assigned ticket, authoritative steering specification and implementation plan entirely, transport contract, foundation logs, and relevant persistence/thread/activity specifications and source/tests. No applicable AGENTS.md files were present.
- Marked ticket in-progress through WAAP before editing. All implementation stays in supplied launcher worktree; integration and ticket completion belong to integration coordinator. No worktree operations, merges, rebases, pushes, PRs, service or daemon changes.
- Rechecked public pi-acp PR #115: still open, head d7f9cb2. Inspected actual source at https://raw.githubusercontent.com/davidhs26/pi-acp/d7f9cb2428c992c62aa759919c799c5619a9b10b/src/acp/agent.ts and reused integrated SDK 1.3.0 adapter contract. No real upstream/manual agent validation claimed.
- Coordinator currently has only an ordinary FIFO; main initializes ACP itself, so advertised steering must be forwarded in coordinator construction as well as captured by initializeAcp. Commands require stored selection/payload so /prompt /reset is never reparsed as reset.
- Implementation plan: reserve first active entry through setup/gates, keep separate ordered pending steering, count unresolved decisions in shared waiting capacity, block replacement prompts/reset on unresolved decisions, and track steering durable callbacks separately after releasing decision/capacity.

## Implementation

- Stored delivery selection, stripped payload and original admission sequence per queue entry. Selection happens after original-body authorization/byte limits. Usage responses are terminal without ACP. Reset is recognized by stored selection, so `/prompt /reset` and `/steer /reset` remain agent text.
- Added separate per-conversation pending steering and one unresolved decision. The first active entry remains reserved through closed dispatch, session setup/load and global permit waiting; later steering stays selected until that prompt is actually submitted. Idle steering becomes one tracked prompt; remaining steering can inject once that prompt starts.
- Shared waiting accounting includes ordinary waiting prompts, pending steering and the unresolved decision, excluding the reserved/active prompt. Steering bypasses ordinary prompt backlog but converts behind reset barriers. `promptRequired` transfers the same entry/slot into FIFO by original admission order.
- Forwarded initialize capability from daemon startup to coordinator construction; coordinator initialization also captures it. Require advertised strict support and an installed method. Method-not-found disables support across this connection; subsequent steering falls back to FIFO. SDK remains pinned at 1.3.0; adapter foundation untouched.
- Injected decisions release lane capacity immediately and silently, with independent durable callback tracking. Original prompt durable completion/output never awaits the steering durable callback, and steering durable completion does not acquire the room outbound mutex. Converted prompts retain their callback until normal terminal handling.
- Added fixed usage, idle/unsupported fallback and method-error response descriptors using existing deterministic transactions, byte accounting, validated encryption path and thread routing. Healthy method errors complete their own event without retry, resubmission or original-prompt cancellation. Malformed/fatal/ambiguous results fail closed.
- Prompt settlement updates unresolved status before further dispatch; the next prompt/reset cannot start until outstanding steering decisions settle. Old session/collector identity stays bound to each work item. Shutdown accounts for pending durable/output work; forced grace interrupts unresolved steering and ignores late outcomes. Cancelled shutdown prompts now skip output drain, eliminating the observed shutdown test stall.
- Production changes are confined to `src/bridge.ts`, required capability wiring in `src/main.ts`, and response rendering. No sync/state schema changes, unrelated cleanup, deployment or service operations.

## Verification

- Installed locked dependencies with `npm ci --no-audit --no-fund` in the supplied worktree.
- Original regression suite passed all 419 tests after initial coordinator changes.
- Added 20 controlled coordinator test groups plus one daemon capability-forwarding group. Tests use held ACP promises, fake clocks and stream-level SDK input/output rather than model behavior or wall-clock race guesses. Extended existing renderer and plaintext/required-encryption adapter tables for all new response kinds.
- Controlled coverage: live and catch-up msg1/msg2/msg3 startup batches; closed gates and setup; serial steering during an open prompt; ordinary FIFO bypass; shared bounds and permit exclusion; original-order conversion; prompt completion before steering response with queued reset; independent durable callbacks in both directions; blocked Matrix output; silent successful injection; unchanged text/activity collector and typing; original turn deadline; cancellation/forced shutdown/late result; healthy errors and method-not-found; unsupported capability/method; usage and nonrecursive payload commands; malformed/transport/protocol/state failure; per-thread isolation; authorization, original-body oversize, dedup and receipts; drain reevaluation.
- Actual MatrixSyncCoordinator plus private on-disk state test proves injected IDs persist while the original prompt remains pending, restart suppresses those completed IDs, and an interrupted converted prompt remains recoverable. No state schema change was needed.
- Actual SDK 1.3.0 adapter stream test proves exact steering wire params, fake-clock startup timeout, fatal coordinator shutdown and zero automatic resubmission of ambiguous input. This is hermetic protocol validation, not a live pi-acp/model test.
- Early targeted development runs exposed TypeScript/lint errors in new code/fixtures and a shutdown cancellation entering drain; all corrected. Focused steering tests then passed (19 selected groups including existing shutdown regressions), followed by state/collector and wire/admission groups (2/2 each).
- Intermediate full `npm run check`: 436/436 passed. Final full `npm run check`: exit 0; Prettier, repository-wide ESLint, TypeScript typecheck, production build, test compilation, and all 440 tests passed; zero failed/cancelled/skipped/todo. Final output: `/tmp/aa-steering-coordinator-exec-final-check.log` (temporary local artifact).
- `git diff --check` passed. `waap check` passed with the prescribed central state directory.

## Handoff

- Code commit on `aa-steering-coordinator-exec`: `d7d38df0f0616841f6e1ef22525d0dacb9fa947a` — `aa-steering-coordinator-exec tt-steering-coordinator-lane-and-lifecycle: implement serial steering lane and durable lifecycle`.
- Code worktree is clean. All implementation/tests are committed and survive launcher cleanup. Work log is committed separately using only this agent's log path in the central WAAP state worktree.
- No implementation blocker remains for this ticket. Real validation against a finalized pi-acp extension was not performed: PR #115 remains open/unmerged (https://github.com/svkozak/pi-acp/pull/115). Source inspection and hermetic RPC behavior are the supported claims; server/model consumption was not asserted.
- Ticket deliberately remains `in-progress`. Integration coordinator alone integrates the committed branch into `feat/message-delivery-steering`, performs downstream integrated/operator verification, and marks ticket completed. Runner owns agent status/worktree lifecycle. No merges, rebases, pushes, PRs, main changes, service restarts or hosting daemon operations were performed.
