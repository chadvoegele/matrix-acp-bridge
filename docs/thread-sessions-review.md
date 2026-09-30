# Thread sessions implementation review

Chad's Agent reviewed the implementation against the approved
[thread-scoped sessions specification](../specifications/thread-scoped-agent-sessions.md)
and the [delivery plan](thread-sessions-implementation-plan.md). The implementation
retains room mode by default and adds opt-in conversation identity, queues,
persistence and output routing by `(room ID, thread root event ID)`.

## Specification coverage

The following automated tests are included in `npm run check`. Adapter and
coordinator tests provide deterministic failure injection; they do not substitute
for a live homeserver or deployment-client test.

| Requirement                                                                       | Implementation and automated evidence                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default room mode; strict mode validation; independent thread queue default of 16 | `src/config.ts`, `src/config.test.ts`; existing room-mode coordinator tests remain enabled.                                                                                                                                                                                                                                                                                                   |
| Global room/sender authorization before session lookup, creation or loading       | `src/authorization.ts`, `src/authorization.test.ts`, `src/bridge.test.ts`; reject unauthorized, self, redacted, edited and malformed events without session work. Mappings grant no access.                                                                                                                                                                                                   |
| Top-level roots, ordinary replies and validated thread follow-ups                 | `src/conversation-identity.ts`, its tests, authorization and bridge tests; use the root relation rather than the fallback, preserve ordinary quotes and strip actual reply fallbacks.                                                                                                                                                                                                         |
| Separate sessions for independent roots; same-thread reuse                        | Bridge and session-store tests; room/root tuple keys also isolate identical root strings across rooms.                                                                                                                                                                                                                                                                                        |
| Unknown follow-ups and resets; rejected roots remain unknown                      | Bridge tests assert the exact unknown response and zero create/load/prompt calls. Oversized roots establish no identity. Queue admission precedes identity insertion; an independent top-level root has its own empty queue, so another thread cannot make it busy.                                                                                                                           |
| All text, multipart, activity, errors and resets remain in their thread           | Bridge simultaneous-output and timeout tests; response/text/activity rendering tests; Matrix content and client tests check originals, replacement content, full payload budgets and stable transaction IDs on retries. Edit envelopes retain `m.replace`.                                                                                                                                    |
| Validated encryption path and no plaintext fallback                               | `src/matrix-client.test.ts`, crypto contract/lifecycle tests and existing automated M3 integration scenarios; threaded text/HTML/edit content is passed through the same required-encryption path.                                                                                                                                                                                            |
| Persist before first prompt; lazy load; suppress replay; scoped stale recovery    | Bridge/state tests cover pending setup, persistence failures, restart, load replay and healthy stale method errors. Protocol/transport failures remain fatal.                                                                                                                                                                                                                                 |
| No-load restart and admitted sessionless identity                                 | Bridge tests prove old threads become unknown without load support while new roots and live reset follow-ups still work. Durable sessionless identities survive reset/restart with load support.                                                                                                                                                                                              |
| Retention and mode changes                                                        | State and bridge tests retain room/thread/sessionless records across mode changes without cross-association, prune every removed-room mapping and never prune by sender, age, inactivity or count.                                                                                                                                                                                            |
| Ordered reset; durable state change before acknowledgement                        | Bridge tests queue reset behind active work, reject reset when that thread's queue is full, isolate other threads and inject state-write failures. State tests atomically replace a mapped thread with its known sessionless identity.                                                                                                                                                        |
| Exact top-level reset guidance                                                    | Bridge tests assert unthreaded guidance, no session/mapping/prompt changes and silent unauthorized/duplicate events. Output uses existing encrypted delivery and deterministic transaction IDs.                                                                                                                                                                                               |
| Per-thread ordering/queues; prompt-only global concurrency                        | Bridge tests cover independent admission, serial turns, concurrent creation/loading, permit waiting and release before output drain. Room queues retain their existing limit. No aggregate backlog or setup limit is introduced.                                                                                                                                                              |
| Room typing, receipts, catch-up, deduplication, cancellation and shutdown         | Bridge, sync-coordinator and main tests cover aggregate typing through drain/timeout, scoped cancellation, receipt handling, durable completed IDs, room catch-up bounds and late setup suppression during shutdown.                                                                                                                                                                          |
| Private migration, recovery guidance and rollback                                 | `src/bridge-state.test.ts`, `src/main.test.ts` and [state operations](thread-sessions-state.md); schema-12 migration preserves identity, recovery ledger and room sessions, publishes the original private backup before replacement and stops on invalid state or injected failures. Restore tests verify original bytes and loss of post-migration changes. SDK-owned state remains intact. |

## Final-review remediation

The live harness originally checked a nonstandard nested ACP load capability and
expected response fallback targets to equal the root even for follow-ups. The
shared `agent_tests/e2e-support/thread-sessions.mjs` monitor now reads the actual
ACP v1 `agentCapabilities.loadSession` field. Both senders verify the response
root separately from its fallback target, which is the latest inbound event.
Support tests exercise these assertions against actual bridge-rendered content
and representative initialize/create/load/prompt wire frames.

The plaintext restart scenario now verifies that only the requested session loads
and that its prompt reuses the original session ID. Unknown-thread checks also
verify no session creation or loading. The encrypted scenario verifies that its
follow-up reuses the first ACP session and that both exchanges stay encrypted on
the wire.

## External validation and operational limits

Both live entry points were attempted on 2026-09-30:

- `agent_tests/unencrypted-e2e/thread-sessions-test.sh`
- `agent_tests/encrypted-e2e/thread-sessions-test.sh`

Both exited with status 2 and `E2E_HOMESERVER is required` before provisioning.
Live plaintext/encrypted behavior and thread display/follow-ups in the deployment
client remain unverified. Running these scenarios requires the documented test
homeserver/account/room credentials and ACP endpoint; deployment-client access is
also required for display verification. No live pass is claimed and no production
service was operated.

Sessions/history and total queued work can grow with the number of threads.
Session unloading, automatic retention, separate agent processes/workspaces and
unsolicited MCP thread routing are outside this feature. Clients without thread
support may show fallback replies in the main timeline. Agents without session
loading cannot resume threads across bridge restarts.

Migration is automatic even in room mode. Downgrading requires stopping the
bridge and restoring `bridge-state.pre-v13.json` as described in
[the rollback procedure](thread-sessions-state.md). All post-migration bridge-state
changes are lost by restoration; agent history and SDK crypto/recovery files are
not deleted. Keep the state and original backup private.

`npm ci` reports two existing high-severity audit findings; this feature changes
no dependency versions or lockfile. The implementation diff contains public
source, tests, examples, operator documentation and the delivery plan. WAAP state,
work logs, credentials and private test artifacts remain outside the feature branch.
