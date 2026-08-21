+++
status = "final"
created = 2026-08-09
last_update = 2026-08-12
+++

# Milestone 2 — restart continuity

Status: accepted (2026-08-04)

This document defines a smaller Milestone 2 than the durable-delivery design
historically described in [m1-plaintext-matrix.md](m1-plaintext-matrix.md). It replaces that superseded M2
scope.

## Goal

Help the bridge resume after short interruptions such as a host reboot, service
restart, deployment, or brief Matrix outage.

Milestone 2:

- saves a Matrix `/sync` cursor beneath `state_dir`;
- fetches a bounded number of messages received during a short interruption;
- restores each room's ACP session when the agent supports `session/load`;
- provides an allowlisted in-room `/reset` control;
- sends best-effort typing indicators and read receipts; and
- reports catch-up, reconnect, session reset, and state failures to operators.

Synapse remains the message store. The bridge does not persist complete room
history.

## Reliability contract

Recovery state prevents a completed ACP turn from being submitted again when a
process restarts before the Matrix sync boundary is safe to advance. It does
not provide distributed exactly-once delivery: ACP and Matrix do not share a
transactional outbox.

A crash may lose:

- an event whose ACP transport or protocol turn was interrupted;
- a queued event dropped during shutdown; or
- a Matrix response after its ACP completion was durably recorded but before
  Matrix accepted the send.

The last case deliberately favors avoiding a duplicate ACP turn over replaying
the prompt, so a crash can lose a Matrix response. Exactly-once ACP execution
and response delivery require transactional ACP and Matrix outboxes, which the
bridge does not have.

## Persistent state

Milestone 2 stores its state in:

```text
<state_dir>/bridge-state.json
```

The file contains only:

- a schema version;
- the Matrix homeserver and verified user/device identity to which the state
  belongs;
- the processed opaque Matrix sync token;
- the wall-clock time at which that token was committed;
- ordered pending sync boundaries and per-room received event IDs with their
  ordered completed event IDs;
- `room ID -> ACP session ID` mappings when the initialized agent advertises
  `loadSession`.

The schema-v11 recovery ledgers contain IDs and structural ordering only. Each
room's `completedEventIds` is an exact contiguous leading subset of its
`eventIds`; no numeric completion index is persisted. They contain no Matrix
access token, event body, sender data, room transcript, ACP prompt/output,
response, or pending outbound response.

State is private because session IDs and sync metadata reveal conversation
metadata. `bridge-state.json` uses mode `0600` beneath the existing `0700`
`state_dir` and is protected by the existing process lock and path checks.

Writes use atomic replacement. The implementation serializes token and session
map updates, writes and fsyncs a private temporary file in `state_dir`, renames
it to `bridge-state.json`, and fsyncs `state_dir` before treating the checkpoint
as committed. Temporary files are safely removed or ignored after a crash.

The state has schema version 11 and strict validation. Malformed, truncated,
incompatible, identity-mismatched, duplicate, out-of-order, or over-bound
state fails startup without silently discarding the cursor or replaying
history. Only schema version 11 is accepted; users may delete or manually
migrate older state files. Diagnostics identify only the state file and
sanitized failure category.

## Matrix sync cursor

A Matrix sync token is an opaque cursor issued in the `next_batch` field of a
successful `/sync` response. The next request supplies it as `since` to ask
Synapse for changes after that point.

Conceptually:

```text
first run:  GET /sync                 -> next_batch S1
later:      GET /sync?since=S1        -> events, next_batch S2
restart:    GET /sync?since=S2        -> events received while stopped
```

The token is account-wide. It is not a message, receipt, transaction ID, or
local Matrix outbox entry.

### First successful run

When no saved cursor exists:

1. Perform an initial `/sync` without `since`.
2. Suppress its timeline events exactly as Milestone 1 does. This prevents room
   history from being interpreted as new prompts.
3. Validate the configured identity, room membership, and plaintext-room
   invariants.
4. Atomically save the returned `next_batch` token and identity binding.
5. Open live intake and ACP dispatch.

A startup that fails before validation completes must not establish a usable
first-run cursor. The next start repeats initial suppression and validation.

### Restart and reconnect

When a valid saved cursor exists:

1. Initialize ACP and validate Matrix identity as in Milestone 1.
2. Start Matrix sync using the saved cursor as `since`.
3. Query Synapse for current joined-room and encryption state and validate all
   configured rooms. Do not assume an incremental sync contains complete room
   state merely because it uses a saved cursor.
4. Continue processing later room state and membership changes needed for
   runtime invariants.
5. Classify eligible timeline messages from the first incremental response as
   catch-up events.
6. Apply the age and count bounds below.
7. Admit selected events to room queues in each room's Matrix timeline order.
8. Durably register the response's `next_batch` and the ordered IDs selected
   for agent work before dispatching any selected event.
9. Open normal live intake and dispatch.

The recovery cursor advances only after every selected event in the contiguous
prefix of registered batches reaches a terminal bridge completion. Completion
is persisted by appending the exact next event ID in that room's FIFO before
sending the corresponding Matrix response. Repeating an already completed ID
is idempotent; attempting a later ID fails closed. A completed room cannot move
the global cursor past another incomplete room in the same batch, and a later
completed batch cannot bypass an earlier incomplete batch.

Subsequent successful sync responses register their eligible IDs before any
ACP dispatch through `BridgeCoordinator.handleTimelineEvent`. A state write
failure is fatal. The bridge must not continue
while claiming that restart catch-up is healthy.

If Synapse rejects an expired or invalid saved cursor, fail startup with
recovery guidance. Do not silently fall back to an unbounded initial sync.

## Bounded catch-up

Catch-up is for short, low-volume interruptions. It is not room-history replay.

The bridge never paginates backward through `/messages` during automatic
startup. If `/sync` marks a room timeline `limited`, events omitted by Synapse
remain omitted. The bridge emits a metadata-only warning for that room.

Two new limits bound automatic catch-up:

```toml
[limits]
max_catchup_age_seconds = 900
max_catchup_events_per_room = 4
```

Both limits must be positive integers. Zero is invalid.

- If the saved checkpoint is older than `max_catchup_age_seconds`, suppress all
  catch-up message events, process required state changes, advance the cursor,
  and warn that catch-up was skipped.
- Otherwise, authorize and normalize events using the ordinary inbound policy.
- Keep at most `max_catchup_events_per_room` eligible messages from each
  configured room.
- If more eligible messages exist, keep the newest messages and preserve their
  original order. Warn with room ID and omitted count, never message content.
- The effective count is also capped at
  `1 + max_queued_turns_per_room`, so startup catch-up cannot overflow the
  room's active-plus-waiting capacity.
- Events omitted by the catch-up policy receive no `busy` response and are not
  sent to ACP.
- Once startup catch-up finishes, ordinary live events retain Milestone 1 queue
  and `busy` behavior.

Catch-up age uses the local checkpoint time, not an event body's timestamp.
If the current clock is earlier than the saved checkpoint, treat the age as
zero and emit a clock-skew warning.

The bridge retains the bounded in-memory 10,000-event FIFO as a fast duplicate
guard, but it is not the recovery authority. The saved processed cursor plus
its ordered per-room completion ledgers prevent routine replay across clean
restarts. Event bodies and ACP content are never part of this metadata.

## ACP session restoration

ACP initialization must retain the agent's advertised `loadSession` capability.

When `loadSession` is false or absent:

- do not persist newly created room/session mappings;
- discard mappings left by an agent that previously supported loading; and
- lazily create a new session for each room after every process restart.

When `loadSession` is true:

1. Persist a newly created room/session mapping before its first prompt.
2. On restart, lazily call `session/load` when a room first needs its session.
3. Use the configured `acp.cwd` and `mcpServers: []`.
4. Mark the session as loading before sending `session/load`.
5. Suppress every `session/update` for that session until `session/load`
   completes, including replayed conversation history. Do not compare replayed
   content with Matrix history or forward it to Matrix.
6. On success, clear the loading marker and use the loaded session for that
   room.

A compatible agent must emit all load-history updates before completing
`session/load`. ACP v1 cannot distinguish a late history update from output for
a subsequent prompt. The bridge therefore sends no prompt to that session until
loading completes.

A healthy-transport `session/load` method error means the mapping is stale.
Atomically delete it, create and persist a new session, and warn that room
context was reset. ACP transport or protocol failure remains fatal and must not
be converted into a fresh session.

Mappings for rooms no longer present in `matrix.allowed_rooms` are removed at
startup. A room never adopts another room's session ID.

## Session reset control

After ordinary authorization and reply-fallback normalization, an exact body of
`/reset` is a bridge control. Leading or trailing whitespace, arguments, and
other slash-prefixed text are ordinary ACP prompts.

The reset event enters the room's normal bounded queue. If the queue is full,
it receives the ordinary `busy` response and does not reset the session. When
reset reaches the front:

1. do not send it to ACP or acquire a global prompt permit;
2. atomically remove that room's persisted mapping, if any;
3. discard that room's current in-memory ACP session ID; and
4. send the exact response `Agent session reset.` with response kind `reset`.

The next ordinary prompt lazily creates a fresh ACP session. Reset does not
cancel active work, affect earlier queued events, call `session/delete`, or
delete agent-owned session data. Events queued after reset use the new session.
Resetting a room without an existing session still succeeds.

The reset response uses the existing deterministic Matrix transaction-ID,
multipart, room-send serialization, retry, and permanent-failure rules. A state
write failure is fatal and prevents a success acknowledgement.

## Typing indicators

For each ordinary ACP turn:

- send typing-on immediately before `session/prompt`, after session creation or
  loading and after acquiring the global prompt permit;
- request a 30-second timeout and refresh it every 20 seconds while the turn is
  collecting or draining ACP output;
- stop refreshing and send typing-off after rendering the response but before
  its first Matrix send; and
- make a best-effort typing-off attempt during timeout, fatal failure, and
  graceful shutdown cleanup.

Do not send typing while an event waits in a room queue or global semaphore,
while `session/load` runs, for `/reset`, or for busy, oversized, rejected, or
omitted catch-up events.

Typing operations are ephemeral and are not persisted or recovered. Their
failures are metadata-only warnings, are not retried independently, and never
fail startup, a turn, or the daemon. A failed typing-off request is bounded by
the previous 30-second server timeout.

## Read receipts

Send one unthreaded `m.read` receipt after an authorized event receives its
bridge disposition. This includes:

- an ordinary event admitted to the active or waiting room queue;
- an exact `/reset` admitted to that queue;
- an authorized oversized event; and
- an authorized event rejected with `busy`.

Do not receipt unauthorized, malformed, self-authored, unsupported, duplicate,
or catch-up-omitted events. The receipt acknowledges that the bridge inspected
the event, not that ACP or Matrix response delivery succeeded.

Receipts are ephemeral and are not persisted or recovered. Receipt failures are
metadata-only warnings, receive no bridge-managed retry, and never alter event,
turn, response, startup, or daemon outcomes.

## Shutdown

Graceful shutdown follows Milestone 1. Before releasing the state lock, flush
any accepted sync cursor or session-map update already waiting to be written.
The existing shutdown grace deadline includes this flush.

Waiting and active turns remain subject to the Milestone 1 shutdown contract.
They are not serialized for restart recovery.

## Diagnostics

Add metadata-only diagnostics for:

- saved cursor loaded;
- first cursor established;
- catch-up started and finished;
- catch-up skipped because of age;
- catch-up events omitted by count;
- limited Matrix timeline observed;
- Matrix reconnect and return to syncing;
- ACP session loaded;
- stale session mapping discarded;
- room context reset;
- typing and receipt operation failures;
- state checkpoint failure; and
- corrupt, incompatible, or identity-mismatched state.

Catch-up summaries may include room ID, elapsed downtime, selected count, and
omitted count. They must not include event bodies, sync tokens, session IDs,
Matrix access tokens, or raw SDK/ACP errors.

No health HTTP endpoint, metrics server, or periodic heartbeat is added.

## Configuration

The two catch-up keys are optional and receive the documented defaults. They
must be positive integers and follow the existing strict TOML and Node timer
bounds. Unknown keys remain errors.

Changing the configured homeserver, user ID, or device ID while retaining M2
state fails startup with recovery guidance. Changes to room and sender
allowlists do not invalidate the account-wide sync cursor. Removed room/session
mappings are pruned.

## Verification

Unit tests must cover:

- strict parsing and defaults for catch-up limits;
- first-run timeline suppression and cursor establishment;
- restart from a saved cursor;
- checkpoint identity mismatch and schema corruption;
- checkpoint write and fsync failure;
- short-downtime event selection in per-room order;
- age-based catch-up suppression;
- newest-event count truncation;
- `limited` timeline behavior without pagination;
- catch-up bounded by room queue capacity;
- no `busy` response for omitted catch-up events;
- capability-aware session-map persistence;
- successful `session/load` with phase-based update suppression;
- late load-history compatibility handling;
- stale session-load fallback;
- fatal ACP transport failure during load;
- exact `/reset` recognition, queue ordering, busy behavior, durable mapping
  removal, acknowledgement, and fresh-session creation;
- typing start, refresh, stop, cleanup, and nonfatal failures; and
- read-receipt eligibility, ordering, and nonfatal failures.

Hermetic integration tests must prove:

1. the first run suppresses history and saves a cursor;
2. a short restart submits a bounded offline message to ACP;
3. a long or high-volume interruption does not overwhelm ACP;
4. a successful loaded session preserves room context;
5. a stale mapping and `/reset` each create a fresh isolated session;
6. typing spans only an active ACP turn;
7. receipts acknowledge eligible dispositions but not omitted catch-up events;
   and
8. a restart skips a terminally completed event whose response was lost after
   completion persistence, while an interrupted event is retried once.

## Deferred

The following are not part of this reduced M2:

- event inboxes, message bodies, ACP prompts/output, or response outboxes;
- an arbitrary recent-event cache as the recovery authority;
- exactly-once ACP execution and Matrix response delivery;
- automatic Matrix history pagination;
- E2EE and crypto state; and
- remote health or metrics endpoints.
