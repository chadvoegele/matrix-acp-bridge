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

Pending.
