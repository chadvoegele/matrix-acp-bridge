+++
name = "Agent tests and live Matrix validation"
creation_date = 2026-09-27T12:20:07Z
status = "in-progress"
depends_on = ["tt-live-activity-batching-coordinator"]
+++

# Agent tests and live Matrix/ACP validation

Add or update `agent_tests` on `feat/verbose-acp-output` to prove `specifications/verbose-acp-output.md` works over Matrix, not only unit mocks. Do not create the PR.

Scope:
- Extend existing unencrypted E2E harness and, where feasible, encrypted harness with a deterministic scripted ACP emitter for thought chunks, agent-message chunks, read/write/edit/terminal lifecycle, long command/output, 10→11 rollover, agent-message boundary and a late update to an archived batch. Verify Matrix wire events plus `m.replace` relation and `m.new_content` (`body` and `formatted_body`), HTML colors/pre/code/details/summary, event-count limits, status colors, truncation, no duplicate outputs, and correct visible fallback. Do not assert client UI internals in wire tests.
- Add a separate opt-in real-agent test using the existing E2E_ACP_COMMAND (pi-acp) and scratch data to verify actual read/write/edit/bash status/output and exact tool metadata coverage; skip or report incomplete gracefully if agent behavior or env prerequisites prevent deterministic execution. Never change the server default model or deploy to production.
- Where environment permits, execute live tests against configured test Matrix rooms and ACP with automatic device/session/scratch cleanup. Never print credentials, raw private traces, Matrix IDs, or local private paths in the PR; no secrets in tracked fixtures. Document safe invocation and what was actually run.

Acceptance: `npm run check` and relevant `agent_tests` pass (or report a precise external prerequisite in the work log). New tests clean up on failure, are opt-in for live environments, and leave existing E2E entry points intact. Signed commit if available; merge feature branch, not main. No PR.
