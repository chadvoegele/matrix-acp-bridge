+++
name = "Steering integrated verification and operator docs"
creation_date = 2026-10-01T20:30:24Z
status = "pending"
depends_on = ["tt-steering-coordinator-lane-and-lifecycle"]
+++

# Integrated steering review, regression coverage and operator docs

Implement phase 4 of docs/message-delivery-implementation-plan.md after all implementation tickets integrate. Independently audit every requirement of specifications/mid-turn-steering.md against code; fix correctness gaps rather than only writing a review. Keep scope to agreed behavior.

Extend controllable fake-agent integration and sync-ledger tests for concurrent extension request while prompt remains pending; multiple steer-default events admitted before dispatch/session setup; first becomes prompt, rest steer; explicit /prompt preserves FIFO. Validate silent injected completion and pending fallback prompts, duplicate suppression and catch-up same selection rules, independent terminal callbacks and failed durable write. Exercise room/thread identity, top-level thread starts, queued reset barrier, correctly routed encrypted fallback/error notices, byte accounting and privacy. Reuse existing encrypted harness and add focused unit/contract coverage where live environment unavailable.

Update README feature/config/operator guidance including commands/default, prompt FIFO vs steering lane, acceptance vs consumption, Pi-owned queue scheduling, unsupported-agent fallback, shared backlog and server-queue limitations, restart and session-scoped cancellation limitations. Config example must match. Verify actual PR #115 extension using available pi-acp revision if feasible; do not claim a real upstream test passed when only fake coverage exists. No service restarts of hosting pi-web daemon. No deployment or main merge.

Run full npm run check and independently inspect git diff vs origin/main for unrelated churn, missing tests, unsafe error replay, boundary/lifecycle deadlocks, and specification drift. Record exact checks and real integration limitations in work log. Commit fixes/docs/tests on WAAP branch and hand off; final orchestration opens implementation PR after integration and re-running gates. Do not mark tickets complete merely because code compiles; acceptance must hold.
