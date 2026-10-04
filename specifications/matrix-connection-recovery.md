+++
status = "final"
created = 2026-08-20
last_update = 2026-08-20
+++

# Matrix connection recovery

## Purpose

Keep the existing Matrix client, ACP sessions, completed-event ledger, and
Rust crypto instance alive through transient transport failures. Recovery is
owned by the pinned matrix-js-sdk; bridge restart recovery is separately
defined by the normal initial-sync completed-ID contract in
[m2-persistence.md](m2-persistence.md).

## Scope

The bridge must distinguish transient connection loss from permanent Matrix
failure. A transient outage must not recreate the Matrix client, restart ACP,
clear SDK or crypto state, or alter the durable completed-event ledger.

## Startup failures

Before the first `PREPARED` state, transient `RECONNECTING` and `ERROR` states
remain within startup. The SDK owns its normal connection probes and sync
retries; `startup_timeout_seconds` remains the upper bound for reaching
`PREPARED`. Permanent authentication, room, crypto, or protocol failures fail
startup immediately.

Startup always uses the SDK's normal initial-sync path. No restart-specific
saved token, startup cache response, or alternative sync loop is introduced.

## Runtime outage

After `PREPARED`, the first transient `RECONNECTING` or `ERROR` starts one
outage. During it:

- the bridge, ACP connection, session mappings, state lock, Matrix client, and
  Rust crypto instance remain open;
- any number of transient errors remain nonfatal;
- matrix-js-sdk owns probing and randomized retry timing;
- the bridge does not call `startClient()` again or construct another client;
- no event reaches ACP until a successful SDK sync batch passes the ordinary
  authorization, completed-ID, and registration gates; and
- already admitted ACP turns may continue and retain their normal Matrix-send
  retry behavior.

The successful SDK response ends the outage only after the adapter validates
its response boundary and hands the normalized batch to the existing bridge
path. A limited timeline remains bounded and produces only a metadata warning.
The bridge does not paginate history or use a transient outage as a reason to
replay a completed event.

## Backoff ownership

matrix-js-sdk is the sole owner of sync retry timing. The bridge must not add a
parallel timer loop, force an immediate retry, or shorten the SDK delay. This
prevents duplicate sync requests, duplicate event delivery, and replacement
crypto state.

## Diagnostics

On the first transient failure emit one metadata-only
`matrix-connection-lost` warning with safe failure classification, HTTP status
or Matrix errcode, and whether startup completed. Repeated failures may emit
rate-limited `matrix-reconnect-retry` warnings with attempt count and elapsed
time. On successful synchronization emit one
`matrix-connection-restored` info event with outage duration and failure
count. Shutdown during an outage emits no false restoration.

Diagnostics must not contain URLs, query parameters, access tokens, sync
tokens, headers, event content, session IDs, raw errors, or stack traces.

## Permanent failures and shutdown

Invalid authentication, non-retryable HTTP failures, malformed sync boundaries,
unexpected SDK processing errors, and unsolicited `STOPPED` remain fatal.
SIGINT, SIGTERM, startup timeout, ACP failure, and permanent Matrix failure
stop the SDK once, cancel its active sync/retry work, flush accepted state
within the shutdown grace period, close crypto/ACP, and release the lock. No
reconnect callback may restart work after intake stops.

## Compatibility and migration

No bridge-state or crypto-state migration is provided. The bridge-state reset
procedure is documented in the README and M2 specification. Runtime
reconnection does not change the schema-v12 completed-ID ledger.

## Verification

Hermetic tests must cover transient startup and runtime errors, startup
timeouts, permanent failures, repeated retry states, one lost/restored pair of
diagnostics, shutdown during backoff, response-boundary validation, and
continued exactly-once completed-ID suppression. Required-encryption tests
must prove crypto identity is not regenerated during an outage.
