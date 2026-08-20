+++
status = "final"
created = 2026-08-09
last_update = 2026-08-20
+++

# Milestone 2 — restart continuity

Status: accepted (2026-08-20)

This document defines restart recovery for the current bridge. Synapse remains
the message store; the bridge does not persist room history, Matrix event
bodies, or a durable Matrix sync cursor.

## Goal

Resume after a host reboot, service restart, deployment, or short Matrix
outage while preventing a terminally completed Matrix event from being sent to
ACP again. Recovery uses the SDK's normal initial sync plus a bounded,
per-room completed-event ledger.

Milestone 2 provides:

- normal initial sync with a configured per-room timeline limit;
- first-run history suppression through an atomic completed-ID baseline;
- restart admission of unseen IDs from the bounded initial-sync timeline;
- age and per-room admission bounds, independent of ACP queue limits;
- ACP session restoration when the agent supports `session/load`;
- an allowlisted in-room `/reset` control;
- best-effort typing indicators and read receipts; and
- metadata-only recovery, reconnect, session, and state diagnostics.

## Reliability contract

State prevents a completed ACP turn from being submitted again when a process
restarts. It does not provide distributed exactly-once delivery: ACP and
Matrix do not share a transactional outbox.

A crash may lose an event whose ACP turn was interrupted, a queued event
dropped during shutdown, or a Matrix response after ACP completion was
durably recorded. The last case favors avoiding a duplicate ACP turn over
replaying the prompt, so a response can be lost.

An interrupted event remains absent from the completed-ID ledger and is
eligible for retry when it appears in a later initial-sync timeline. A
terminal event is recorded before its response is sent.

## Persistent state

The private state file is:

```text
<state_dir>/bridge-state.json
```

Schema version 12 contains only:

- the schema version and verified Matrix homeserver/user/device identity;
- `initialized`, indicating that the first initial-sync baseline committed;
- `room ID -> ACP session ID` mappings when the agent advertises
  `loadSession`; and
- bounded per-room `completedEventIds`.

The ledger stores event IDs and ordering only. It contains no access token,
sync response, event body, sender content, ACP prompt/output, transcript,
response, or ciphertext. Each mutation is serialized, written to a mode-0600
temporary file, fsynced, atomically renamed, and followed by a directory fsync.
The state directory remains mode 0700 and process-locked.

Schema-v12 state is strict and identity-bound. Malformed, truncated,
identity-mismatched, unsupported, duplicate, or invalid state fails startup;
the bridge does not silently discard it. There is no migration from older
cursor-era state. Operators must stop the daemon and remove or move only
`bridge-state.json`, then let a fresh normal initial sync establish a new
baseline. Required-mode crypto state is preserved separately.

## Normal startup and baseline

The Matrix adapter always calls the real SDK's normal `startClient()` path with
`initialSyncLimit = initial_sync_timeline_limit`; it does not seed a saved
token, pass a `since` startup option, or restore a cached sync response.

### First startup

When `initialized` is false:

1. Start the SDK's normal initial sync.
2. Validate Matrix identity, room membership, and encryption invariants.
3. Authorize eligible events for metadata only.
4. Atomically record every eligible event ID in the first response and set
   `initialized = true`.
5. Open live intake and ACP dispatch.

No event from that first initial-sync response reaches ACP, including events
that arrive before the SDK reports readiness. A failure before the baseline
replacement leaves the state fresh so the next start repeats suppression.

### Restart startup

When `initialized` is true:

1. Start the same normal initial-sync path and validate current room state.
2. Treat the returned timeline as a bounded recovery candidate, not as live
   history and not as a saved-token response.
3. Authorize eligible events and suppress every event ID already completed for
   that room.
4. Apply the age and count bounds below to unseen IDs.
5. Compact the completed ledger atomically against the current timeline and
   terminal omissions before dispatch.
6. Admit selected events in Matrix order through the ordinary ACP queue.
7. Open normal live intake after recovery selection is committed.

Selected recovery events are marked as catch-up for bridge policy and
diagnostics. They receive the ordinary authorization path, session restoration,
read-receipt, completion-before-response, and interrupted-turn behavior.

## Bounded initial-sync recovery

`initial_sync_timeline_limit` controls the number of timeline events the SDK
requests per room on every normal startup. It bounds the input returned by the
homeserver; it is not an ACP admission limit and does not measure event age.

The recovery admission settings are:

```toml
[limits]
initial_sync_timeline_limit = 100
max_catchup_age_seconds = 900
max_catchup_events_per_room = 4
```

All three values are positive integers. For an initialized bridge:

- only eligible, unseen event IDs are candidates;
- an event older than `max_catchup_age_seconds` by its Matrix origin timestamp
  is terminally omitted;
- at most `max_catchup_events_per_room` recent unseen events are selected per
  room, keeping the newest bounded suffix in original Matrix order;
- the effective selected count is also capped by
  `1 + max_queued_turns_per_room`, the ACP active-plus-waiting capacity;
- an omitted event receives no busy/error response and is not sent to ACP;
- omitted IDs are recorded as terminal for the current bounded window so the
  ledger cannot grow without bound; and
- a limited timeline is not paginated, with only a metadata warning.

The age bound and admission count apply only during initialized startup
recovery. Ordinary live events use the normal queue, busy, and prompt limits.
The bridge never compares bodies or ACP content to decide whether an event is
completed. Compaction retains completed IDs visible in the current timeline
and removes older IDs outside that bounded window.

## ACP session restoration

ACP initialization retains the agent's advertised `loadSession` capability.
When it is absent, persisted mappings are discarded and each room lazily gets
a new session after restart. When present, a mapping is persisted before its
first prompt; restart lazily calls `session/load` with the configured cwd and
`mcpServers: []`; load-history updates are suppressed until load completes; a
successful load serves the recovered event and later live events. A healthy
transport `session/load` method error discards the stale mapping and creates a
new one; transport/protocol failure remains fatal.

Mappings for rooms outside `matrix.allowed_rooms` are pruned. A room never
uses another room's session ID.

## Session reset, typing, receipts, and shutdown

After normal authorization, an exact `/reset` is a queued bridge control. It
does not reach ACP, removes the room mapping atomically, and returns exactly
`Agent session reset.`. The next ordinary prompt creates a fresh session.
Whitespace, arguments, and other slash text remain ordinary prompts.

Typing is sent only for an active ACP turn, refreshed every 20 seconds with a
30-second timeout, and stopped before the first response send. Typing failures
are metadata-only. One unthreaded `m.read` receipt is sent after an authorized
event receives a bridge disposition; unauthorized and omitted events receive
none. Receipt failures are metadata-only.

Graceful shutdown stops Matrix, flushes accepted ledger and session mutations
within the existing grace period, closes ACP/crypto, and releases the lock.

## Diagnostics and privacy

Diagnostics may report baseline establishment, initialized recovery start and
finish, selected/omitted counts, age/count omission reason, limited timelines,
session loading/reset, reconnect lifecycle, and state failures. They must not
contain event bodies, access tokens, sync responses/tokens, ACP content,
session IDs, ciphertext, or raw SDK/ACP errors.

## Configuration and verification

Unknown TOML keys remain errors. `initial_sync_timeline_limit` defaults to 100;
the age and per-room admission defaults are 900 seconds and 4 events. The
homeserver/user/device identity remains bound to the state file; changing it
requires an explicit state reset.

Hermetic tests must cover first-run suppression, atomic baseline state,
restart admission of unseen IDs, completed-ID suppression, interrupted-event
retry, age/count omission, limited timelines, compaction, session loading,
reset, typing, receipts, and state failures. They must assert no cursor or
pending-batch fields exist in schema-v12 state.

Required live tests must prove a normal initial sync after restart submits an
offline event once, never submits a completed event again, restores the ACP
session where supported, and leaves bounded, cursor-free state. Plaintext and
required-encryption modes must retain their existing wire and crypto
continuity guarantees.

## Deferred

Event inboxes, message bodies, response outboxes, distributed exactly-once
delivery, automatic history pagination, and durable crypto migration remain
out of scope.
