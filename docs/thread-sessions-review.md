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

| Requirement                                                                     | Implementation and automated evidence                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default room mode; strict mode validation; per-conversation queue default of 16 | `src/config.ts`, `src/config.test.ts`; existing room-mode coordinator tests remain enabled.                                                                                                                                                                                                                                                                                                                                                               |
| Global room/sender authorization before session lookup, creation or loading     | `src/authorization.ts`, `src/authorization.test.ts`, `src/bridge.test.ts`; reject unauthorized, self, redacted, edited and malformed events without session work. Mappings grant no access.                                                                                                                                                                                                                                                               |
| Top-level roots, ordinary replies and validated thread follow-ups               | `src/conversation-identity.ts`, its tests, authorization and bridge tests; use the root relation rather than the fallback, preserve ordinary quotes and strip actual reply fallbacks.                                                                                                                                                                                                                                                                     |
| Separate sessions for independent roots; same-thread reuse                      | Bridge and session-store tests; room/root tuple keys also isolate identical root strings across rooms.                                                                                                                                                                                                                                                                                                                                                    |
| Unknown follow-ups and resets; rejected roots remain unknown                    | Bridge tests assert the exact unknown response and zero create/load/prompt calls. Oversized roots establish no identity. Queue admission precedes identity insertion; an independent top-level root has its own empty queue, so another thread cannot make it busy.                                                                                                                                                                                       |
| All text, multipart, activity, errors and resets remain in their thread         | Bridge simultaneous-output and timeout tests; response/text/activity rendering tests; Matrix content and client tests check originals, replacement content, full payload budgets and stable transaction IDs on retries. Edit envelopes retain `m.replace`.                                                                                                                                                                                                |
| Validated encryption path and no plaintext fallback                             | `src/matrix-client.test.ts`, crypto contract/lifecycle tests and existing automated M3 integration scenarios; threaded text/HTML/edit content is passed through the same required-encryption path.                                                                                                                                                                                                                                                        |
| Persist before first prompt; lazy load; suppress replay; scoped stale recovery  | Bridge/state tests cover pending setup, persistence failures, restart, load replay and healthy stale method errors. Protocol/transport failures remain fatal.                                                                                                                                                                                                                                                                                             |
| No-load restart and admitted sessionless identity                               | Bridge tests prove old threads become unknown without load support while new roots and live reset follow-ups still work. Durable sessionless identities survive reset/restart with load support.                                                                                                                                                                                                                                                          |
| Retention and mode changes                                                      | State and bridge tests retain room/thread/sessionless records across mode changes without cross-association, prune every removed-room mapping and never prune by sender, age, inactivity or count.                                                                                                                                                                                                                                                        |
| Ordered reset; durable state change before acknowledgement                      | Bridge tests queue reset behind active work, reject reset when that thread's queue is full, isolate other threads and inject state-write failures. State tests atomically replace a mapped thread with its known sessionless identity.                                                                                                                                                                                                                    |
| Exact top-level reset guidance                                                  | Bridge tests assert unthreaded guidance, no session/mapping/prompt changes and silent unauthorized/duplicate events. Output uses existing encrypted delivery and deterministic transaction IDs.                                                                                                                                                                                                                                                           |
| Per-thread ordering/queues; prompt-only global concurrency                      | Bridge tests cover independent admission, serial turns, concurrent creation/loading, permit waiting and release before output drain. Room and thread queues share `max_queued_turns_per_conversation`, defaulting to 16; the legacy room key maps to the same limit. No aggregate backlog or setup limit is introduced.                                                                                                                                   |
| Room typing, receipts, catch-up, deduplication, cancellation and shutdown       | Bridge, sync-coordinator and main tests cover aggregate typing through drain/timeout, scoped cancellation, receipt handling, durable completed IDs, room catch-up bounds and late setup suppression during shutdown.                                                                                                                                                                                                                                      |
| Private migration, recovery guidance and rollback                               | `src/bridge-state.test.ts`, `src/main.test.ts` and [state operations](thread-sessions-state.md); schema-12 migration preserves identity, recovery ledger and room sessions using normal atomic writes, creates no backup and stops on invalid state or injected failures. Existing backup files are ignored and untouched. Restore tests use a user-created pre-upgrade backup and verify loss of post-migration changes. SDK-owned state remains intact. |

## Final-review remediation

The live harness originally checked a nonstandard nested ACP load capability and
expected response fallback targets to equal the root even for follow-ups. The
shared `agent_tests/e2e-support/thread-sessions.mjs` monitor now reads the actual
ACP v1 `agentCapabilities.loadSession` field. Both senders verify the response
root separately from its reply target, which is the latest inbound event.
Internal `threadInReplyToEventId` supplies `m.in_reply_to.event_id`, while
`threadRootEventId` supplies the thread root. The reply target is marked
`is_falling_back: true` on the wire for compatibility.
Support tests exercise these assertions against actual bridge-rendered content
and representative initialize/create/load/prompt wire frames. The dedicated thread
activity runners also check every original and replacement thread relation.
Encrypted SAS setup honors the configured private
environment-file override. Migration tests verify that existing backup paths,
including public files, are ignored and left untouched.

The plaintext restart scenario now verifies that only the requested session loads
and that its prompt reuses the original session ID. Unknown-thread checks also
verify no session creation or loading. The encrypted scenario verifies that its
follow-up reuses the first ACP session and that both exchanges stay encrypted on
the wire. Its sender exits successfully only after assertions and adapter cleanup,
matching the existing activity runner's handling of residual SDK handles. The M2
loaded-context regression now waits for durable terminal completion before test
shutdown, avoiding a filesystem cleanup race without changing production checks.

## External validation and operational limits

Both live scenarios were attempted on 2026-09-30. Their entry points now live
in the dedicated thread suite:

- `agent_tests/thread-sessions/plaintext-test.sh`
- `agent_tests/thread-sessions/encrypted-test.sh`

The relocated harnesses have local regression coverage but have not been rerun live.

Initial invocations without the private test configuration exited with status 2
and `E2E_HOMESERVER is required`. Further inspection found the repository's private
configuration, allowing real tests to proceed with temporary devices and all
artifacts outside Git.

The real plaintext scenario created distinct persisted sessions for two roots and
received correctly threaded responses. One agent response prepended an MCP
connection banner to the requested exact token, so the sender timed out and the
full scenario failed. Its live restart/reset/unknown stages were not reached.
Their deterministic automated coverage remains enabled. The real encrypted root
and follow-up scenario passed, checking authenticated decryption, encrypted raw
wire types, correct root/fallback relations and reuse of one ACP session.

The activity runners support live tests with the existing scripted ACP peer:

```sh
agent_tests/thread-sessions/plaintext-test-activity.sh
agent_tests/thread-sessions/encrypted-test-activity.sh
```

They inspect thoughts, tools, eager text, archived edits, replacement content and
thread relations; encrypted output must remain encrypted on the wire. The
observer scopes reused encrypted histories by the current test prompt's server
timestamp rather than by expected routing, so misrouted new output still fails.
Both live activity scenarios passed on 2026-09-30 using the approved setup,
`activity-wire.mjs` runners and cleanup. Before the suite separation, plaintext used
`E2E_RESPONSE_MODE=thread agent_tests/unencrypted-e2e/test-activity.sh`;
encrypted used the provisioned private environment with the scripted ACP peer.
The peer waits one second between updates so intermediate status backgrounds can
be observed over live Matrix delivery. All original assertions remain enabled.
Temporary sessions were deleted, devices revoked and private state removed. No production daemon was stopped or restarted.

Thread display and follow-ups in the deployment client remain unverified because
that client is not available in this environment.

Sessions/history and total queued work can grow with the number of threads.
Session unloading, automatic retention, separate agent processes/workspaces and
unsolicited MCP thread routing are outside this feature. Clients without thread
support may show fallback replies in the main timeline. Agents without session
loading cannot resume threads across bridge restarts.

Migration is automatic even in room mode. Users must back up private bridge state
before upgrading; the bridge creates no automatic backup. Downgrading requires
stopping the bridge and restoring their own pre-upgrade backup as described in
[the rollback procedure](thread-sessions-state.md). All post-migration bridge-state
changes are lost by restoration; agent history and SDK crypto/recovery files are
not deleted. Keep state and backups private.

`npm ci` reports two existing high-severity audit findings; this feature changes
no dependency versions or lockfile. The implementation diff contains public
source, tests, examples, operator documentation and the delivery plan. WAAP state,
work logs, credentials and private test artifacts remain outside the feature branch.
