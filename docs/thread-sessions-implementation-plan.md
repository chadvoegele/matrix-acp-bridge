# Thread-scoped sessions implementation plan

## Delivery

Implement [the approved specification](../specifications/thread-scoped-agent-sessions.md), merged in [spec PR #13](https://github.com/chadvoegele/matrix-acp-bridge/pull/13).

- Integration branch: `feat/thread-scoped-sessions`, based on `main` commit `290091d`.
- Deliver one separate GitHub implementation PR targeting `main`.
- Do not merge that implementation PR until the user approves it.
- Use isolated ticket worktrees; integrate dependencies into the feature branch before starting dependent work. Serialize branch integration; do not overwrite other agents' commits.
- WAAP tickets live on the repository's separate `waap` branch, not in implementation commits. Use `waap check` and `waap ticket list` from a repository worktree.

## Scope guardrails

Room mode remains the default. Thread mode scopes queue/session identity to `(room ID, thread root event ID)` while preserving room-wide authorization, typing and catch-up bounds.

`max_concurrent_prompts` retains its existing prompt-only semantics; creation/loading does not count. No session unloading, setup-concurrency control, aggregate backlog cap, automatic history expiry or unsolicited MCP thread routing is added.

Thread mode uses an independent `max_queued_turns_per_thread` default of 16. Busy/oversized rejected top-level roots remain unknown. Reset retains durable sessionless thread identity when loading is supported. Both modes retain their records across switches; removed rooms are pruned. State migration creates a private backup and rollback requires restoring it.

## Ticket DAG

```text
Configuration and routing foundations
          |                |
          v                v
Durable identities    Matrix output and edits
          |                |
          +--------+-------+
                   v
         Coordinator and lifecycle
                   |
                   v
       Regression and operator docs
                   |
                   v
      Plaintext/encrypted/live validation
                   |
                   v
         Final review and one PR
```

| Stage           | WAAP ticket                                                          | Main responsibility                                                                             |
| --------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Foundations     | `tt-thread-sessions-configuration-and-routing-foundations`           | Config, conversation identity, authorized inbound thread metadata and fallback handling         |
| Persistence     | `tt-thread-sessions-durable-identities-and-migration`                | Room/thread records, sessionless identity, atomic reset, migration/backup and rollback          |
| Output          | `tt-thread-sessions-matrix-output-and-edit-routing`                  | Text/HTML relations, edit envelopes, byte budgets, synthetic responses and encryption           |
| Coordinator     | `tt-thread-sessions-coordinator-queues-reset-and-lifecycle`          | Independent queues/sessions, prompt semaphore, reset/recovery, activity routing and room typing |
| Regression      | `tt-thread-sessions-integrated-regression-and-operator-documen-8d5b` | Spec coverage audit, failure-path tests, compatibility and operator documentation               |
| Live validation | `tt-thread-sessions-plaintext-encrypted-and-live-matrix-validation`  | Existing E2E harness extensions, live Matrix verification and cleanup                           |
| Delivery        | `tt-thread-sessions-final-review-and-one-github-implementation-pr`   | Review/remediation, final checks and exactly one implementation PR                              |

Persistence and output can run in parallel after foundations establish their shared contracts. Coordinator changes wait for both. Later stages are serial to ensure validation reflects integrated code.

## Verification and completion

Each ticket adds focused tests and records commands, results and integration commits in its agent work log. Final verification runs `npm run check` and applicable existing/live Matrix harnesses.

Coverage must include default room compatibility, thread isolation and serial ordering, cross-thread concurrency, prompt-only limits, rejected/unknown roots, authorization, malformed relations, ordinary replies/quotes, reset followed by restart, lazy loading, no-load agents, stale recovery, state fault injection, mode switches, removed-room pruning, activity edits, payload limits, encryption, retry/deduplication, receipts, typing, catch-up and shutdown.

Live credentials or manual-client access may be external blockers; disclose them rather than claim success. Keep private state and credentials out of commits. The final PR description must identify test evidence, migration/rollback procedures and remaining limitations. No agents have been launched as part of planning.
