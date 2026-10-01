# Steering ACP transport work log

Agent: `aa-steering-transport-exec`
Ticket: `tt-steering-acp-extension-transport`
Branch: `aa-steering-transport-exec`

## 2026-10-01 — Contract inspection and implementation plan

- Read launcher instructions, WAAP skill/developer role, ticket, authoritative steering specification and implementation plan, ACP client/tests and relevant output/session/persistence contracts.
- Marked ticket in-progress through WAAP; integration coordinator owns integration and completion. Work remains exclusively in launcher worktree; no merge, push, PR, or service changes.
- Queried public GitHub API and fetched actual changed source/tests for pi-acp PR #115. It is open/unmerged at `d7f9cb2428c992c62aa759919c799c5619a9b10b` (https://github.com/svkozak/pi-acp/pull/115). `src/acp/agent.ts` awaits native `steer` then returns `injected`; idle opt-in returns `promptRequired`/`noRunningTurn`; no opt-in can return detached `startedNewTurn`; native errors become RequestError.internalError.
- Installed locked dependencies with `npm ci --no-audit --no-fund`. SDK 1.3.0's `ClientContext.request<Response, Params>(method: string, params)` uses the shared connection's independently ID-tracked pending-response map. No upgrade is needed.
- Planned public API: optional `AcpClient.steer(sessionId, text, timeoutMs)` implemented by production; `agentCapabilities.steering` advertised only for strict boolean `_meta.steering.supported === true`. Valid typed results have `kind: steering`, `outcome: injected` or `outcome: promptRequired` with `reason: noRunningTurn`. Healthy method failures include `methodNotFound` for coordinator capability disabling.
- Timeout belongs to the adapter. Coordinator must pass milliseconds from existing `limits.startupTimeoutSeconds`; adapter closes connection on expiry and returns fatal transport failure, with no retry or prompt conversion. An injected clock permits deterministic timeout tests. No new configuration is introduced. Admission, serialization, shutdown gating, fallback and durable Matrix completion belong to coordinator ticket.
- No finalized-upstream/manual LLM integration claimed: upstream PR remains open; this ticket verifies adapter contract through controllable fake streams.

## Implementation and validation

- Implemented strict optional steering capability parsing while retaining `loadSession`, typed `AcpSteeringResult`/`AcpSteeringMethodError`/`AcpSteeringOutcome`, and the optional interface method with its production implementation.
- Steering uses SDK 1.3.0's generic custom-method request on the existing connection with mandatory idle opt-in. It preserves shared wire ID checks and leaves original prompt collectors/cancellation untouched. Valid injected/idle outcomes discard unrelated metadata; malformed/unknown/detached outcomes signal fatal protocol failure and close transport.
- Healthy method failures return sanitized `methodNotFound` discrimination without cancelling the original prompt or retrying input. Adapter timeout uses supplied bounded milliseconds, independently of the prompt timer, and closes transport on an ambiguous missing response. Timers clear on success, method error, protocol/transport failure, and orderly close. Responses racing close cannot produce successful steering decisions.
- Added `docs/steering-acp-transport.md` with verified upstream source links, API shapes, timeout ownership and coordinator obligations: capability/method gating, serial per-conversation steering, reset barriers, disabling capability after method-not-found, idle conversion and durable silent completion.
- Added 12 top-level fake-stream tests (33 ACP adapter tests total): capability shape variants and `loadSession` preservation; exact Unicode request; independent prompt/steering IDs; both response orders; preserved text/activity/cancellation; idle opt-in without automatic submission; healthy method errors and privacy; malformed results; deterministic timeout; EOF/read/write/wire/unknown-ID failures; duplicate replies; orderly close/late response; independent sessions with reversed steering replies.
- During development, corrected TypeScript narrowing of private state across await by centralizing connection-failure checks, and corrected an unbound-method lint warning in a test helper. The early adapter run passed 30/30 before the final three coverage additions.
- Final `npm run check` passed (exit 0): Prettier, full ESLint, TypeScript typecheck, production build, test compilation, and all 411 tests (411 passed; 0 failed, cancelled, skipped or todo). This includes all 33 adapter tests. Full output captured during execution at `/tmp/aa-steering-transport-exec-check.log` (temporary, not a committed artifact).
- `git diff --check` passed. `waap check` passed with the instructed central state directory.
- Code commit: `3521da6a966c5e5ed9346f38307d2ff50ac198d1` on `aa-steering-transport-exec`, containing only `src/acp-client.ts`, `src/acp-client.test.ts`, and `docs/steering-acp-transport.md`. Working tree clean after commit.
- No implementation blocker found. Real integration against finalized pi-acp was not performed; PR #115 is still open, so only inspected source and controllable fake-stream RPC behavior are claimed. Coordinator/durable Matrix integration and manual deployment verification belong to downstream tickets.
- Ticket intentionally remains in-progress for coordinator integration/completion. No merges, pushes, PRs, worktree changes, service restarts, or unrelated WAAP state modifications were performed. Work log commits are isolated on the central WAAP state branch.
