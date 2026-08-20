+++
status = "final"
created = 2026-08-20
last_update = 2026-08-20
+++

# Matrix connection recovery

## Purpose

Keep the bridge running through temporary Matrix homeserver, DNS, routing, TLS, proxy, and network failures. The bridge must detect and report a Matrix connection outage, remain connected to ACP, and let the Matrix SDK retry with backoff until synchronization resumes or the daemon is stopped.

This specification changes the current behavior that treats a post-startup Matrix `ERROR` sync state as fatal. It builds on [Milestone 2 — restart continuity](m2-persistence.md) and the [cursor-aware Matrix store](cursor-aware-matrix-store.md).

## Context

matrix-js-sdk owns the `/sync` request loop, connectivity probes, randomized retry delays, and transitions among `SYNCING`, `RECONNECTING`, `ERROR`, and `CATCHUP`. Its `ERROR` state can mean that several transient attempts failed; it does not by itself mean the client stopped retrying.

The bridge currently emits a fatal `matrix_transport` error when it observes `ERROR` after `PREPARED`. That shuts down ACP and the Matrix client while the SDK is still capable of reconnecting. A service manager may restart the entire bridge, unnecessarily interrupting active ACP turns and increasing recovery risk.

## Goals

- Survive transient Matrix sync connection failures without exiting or resetting ACP sessions.
- Detect and log one outage lifecycle without exposing sensitive request data.
- Continue retrying with backoff for an unbounded runtime outage.
- Resume from the current in-process sync token without initial-sync fallback or history replay.
- Preserve durable cursor and pending-event recovery semantics during an outage.
- Fail promptly for permanent authentication, cursor, state, crypto, room-invariant, and SDK processing failures.
- Stop retry activity promptly during graceful or forced shutdown.

## Non-goals

- Reimplement `/sync`, SDK connectivity probes, or SDK retry scheduling.
- Add a second bridge-managed retry loop around `startClient()`.
- Recreate the Matrix client or Rust crypto machine during a connection outage.
- Change outbound message retry, ACP retry, queue, catch-up limit, or delivery guarantees.
- Make an invalid access token or rejected sync cursor recover automatically.
- Add a health server, metrics endpoint, or service-manager integration.

## Specification

### Failure classification

A Matrix sync failure is **transient** when matrix-js-sdk designates it retryable or it is caused by a network failure, DNS failure, connection reset, connection timeout, HTTP 408, HTTP 429, or HTTP 5xx response.

The following remain fatal:

- invalid or expired Matrix authentication;
- rejection of the bridge's saved or current sync cursor;
- HTTP redirects and non-retryable HTTP 4xx responses;
- configured room membership or encryption invariant failures;
- Rust crypto initialization, restoration, persistence, or processing failures;
- private bridge-state failures;
- malformed or unsafe SDK data that prevents cursor or event-boundary validation;
- `sync.unexpectedError`, because matrix-js-sdk emits it after a successful `/sync` response fails during local processing and may already have advanced its in-process token; and
- an unsolicited SDK `STOPPED` state while the bridge is not stopping.

Raw SDK error text must not determine policy outside the Matrix adapter. The adapter must expose a normalized transient or permanent classification using stable status and errcode fields.

### Startup connection failures

Before the first `PREPARED` state, a transient connection failure must leave the adapter in its `starting` lifecycle. The adapter must not reject startup merely because the SDK transitions through `RECONNECTING` or transient `ERROR`.

matrix-js-sdk must continue its normal connection probes and `/sync` retries. The daemon's existing `startup_timeout_seconds` remains the upper bound for reaching `PREPARED`. If that deadline expires, startup fails and normal shutdown runs. A permanent failure fails startup immediately.

Every startup retry with a durable checkpoint must retain `since=<checkpoint>` as required by the cursor-aware store specification. No retry may fall back to an initial sync.

### Runtime outage state

After `PREPARED`, the first transient `RECONNECTING` or `ERROR` transition starts one Matrix outage. During that outage:

- the bridge process, ACP connection, ACP sessions, durable state lock, Matrix client, and Rust crypto instance must remain open;
- transient `ERROR` transitions must not emit a fatal bridge error, regardless of their count;
- the Matrix subsystem must remain in a reconnecting state while matrix-js-sdk performs connectivity probes and retries with its randomized backoff;
- the bridge must not call `startClient()` again, construct another Matrix client, clear SDK state, clear crypto state, or alter the durable cursor;
- no event may enter ACP except through a successful cursor-bearing sync response and the existing durable registration gate;
- already admitted ACP turns may continue;
- responses completed during the outage retain the existing Matrix send retry and stable transaction-ID behavior; and
- typing and receipt failures remain nonfatal and do not create independent reconnect loops.

Runtime retry has no elapsed-time or attempt limit. Operators stop the daemon through its normal signal or service controls. Permanent failures still terminate the daemon with exit code 1.

### Backoff ownership

matrix-js-sdk must remain the sole owner of sync retry timing. The bridge must use the SDK's supported retry and connectivity-probe behavior rather than layering timers around it. This avoids concurrent `/sync` loops, duplicate event delivery, replacement crypto state, and disagreement over the active cursor.

The bridge treats the SDK-managed randomized delay between connectivity probes as its backoff-to-retry loop. It must not call the SDK's immediate-retry API automatically or shorten the SDK-selected delay.

### Recovery

A successful `/sync` response after an outage ends the outage only after the adapter has verified its cursor-bearing startup/runtime contract and handed the response to the existing sync-batch path. The returned `next_batch` and eligible event IDs must be durably registered before any newly received prompt reaches ACP.

Events received while disconnected follow existing Matrix and bridge behavior when synchronization resumes. This specification does not add history pagination or expand bounded startup catch-up. A `limited` timeline retains its existing metadata-only warning.

Recovery must not:

- perform an initial sync;
- suppress post-cursor events as first-run history;
- replay a previously completed event;
- create or reload ACP sessions solely because Matrix disconnected; or
- regenerate the Matrix encryption identity.

### Diagnostics

Diagnostics must describe an outage as one lifecycle rather than logging every SDK state transition.

On the first transient failure, emit `matrix-connection-lost` at warning level with only available safe fields:

- normalized failure kind;
- HTTP status or Matrix errcode when present; and
- whether startup had completed.

Repeated failures during the same outage may emit a rate-limited `matrix-reconnect-retry` warning with attempt count and elapsed milliseconds. They must not include URLs, query parameters, sync tokens, access tokens, headers, event content, raw errors, or stack traces.

After successful synchronization resumes, emit `matrix-connection-restored` at info level with outage duration and observed failure count. Clear the outage counters only after this diagnostic.

A permanent failure must retain the existing sanitized fatal diagnostic. Shutdown during an outage is normal shutdown and must not emit a false restoration or additional transport-failure diagnostic.

### Shutdown

SIGINT, SIGTERM, startup timeout, ACP fatal failure, or another permanent failure must stop the SDK once. Stopping the SDK must cancel its active `/sync`, connectivity request, and pending retry timer. No reconnect callback may restart work after Matrix intake has stopped.

The existing shutdown grace deadline and state flush requirements remain unchanged.

## Compatibility and migration

No bridge-state or crypto-state migration is required. Existing cursors, pending recovery ledgers, ACP session mappings, and transaction IDs remain valid.

This specification supersedes only requirements that make a transient Matrix sync connection failure fatal. Permanent Matrix failures and all non-Matrix fatal behavior remain unchanged.

No new configuration is added. Runtime Matrix reconnection is intentionally unbounded; startup remains bounded by `startup_timeout_seconds`.

## Verification

### Unit tests

Tests must verify:

1. A transient `RECONNECTING` before `PREPARED` does not reject startup.
2. A transient `ERROR` before `PREPARED` does not reject startup; startup may later reach `PREPARED`.
3. Startup timeout still fails and stops the SDK while it is reconnecting.
4. A permanent startup error fails immediately.
5. After `PREPARED`, `RECONNECTING` and any number of transient `ERROR` states do not emit a fatal event or stop Matrix or ACP.
6. A later successful cursor-bearing sync emits one restoration diagnostic and resumes batch delivery.
7. Only one lost and one restored diagnostic are emitted per outage; retry diagnostics are rate-limited and metadata-only.
8. Invalid authentication, rejected cursors, non-retryable HTTP failures, `sync.unexpectedError`, and unsolicited `STOPPED` remain fatal.
9. Shutdown during backoff cancels retry activity and produces no later callbacks or diagnostics.
10. A saved cursor remains in every startup retry until a successful `next_batch` replaces it.

### Integration tests

Hermetic tests with mocked Matrix HTTP must prove:

- the bridge remains running across at least three failed `/sync` attempts, including the SDK transition to `ERROR`;
- retries use the same current cursor and never issue an initial `/sync`;
- one post-cursor event returned after recovery reaches ACP exactly once;
- an ACP turn active when Matrix disconnects may finish, and its response is sent with the same transaction ID after Matrix recovers;
- pending durable event completion and cursor advancement remain correct across the outage;
- a permanent authentication or cursor error still shuts down the complete composition; and
- required-encryption mode keeps the same Matrix device fingerprints and decrypts a post-recovery event without reinitializing Rust crypto.

The tests must exercise the production Matrix adapter and SDK retry path, not only manually emit fake sync states.

## References

- [Matrix–ACP bridge specification](m1-plaintext-matrix.md)
- [Milestone 2 — restart continuity](m2-persistence.md)
- [Cursor-aware Matrix SDK store for restart recovery](cursor-aware-matrix-store.md)
- `src/matrix-client.ts`
- `src/main.ts`
- matrix-js-sdk 42.2.0 `SyncApi`
