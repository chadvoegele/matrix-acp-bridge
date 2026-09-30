+++
status = "draft"
created = 2026-09-30
last_update = 2026-09-30
+++

# Thread-scoped agent sessions

## Purpose

Let users start independent agent conversations in one Matrix room without
mixing their histories or filling the main timeline with agent output.

## Context

The bridge currently routes prompts, queues work, and persists ACP sessions by
room. Outbound responses have no Matrix thread relation, and inbound thread
relations are rejected. This feature extends the plaintext, persistence, and
encryption milestones and must also cover verbose ACP output when available.

## Goals

- Start a separate agent conversation for each top-level user message.
- Keep follow-ups and all turn output in that conversation's Matrix thread.
- Run separate threads concurrently within existing global limits.
- Preserve thread/session mappings without automatic expiry.
- Preserve existing room-scoped behavior unless explicitly enabled.

## Non-goals

- Per-room configuration overrides.
- Automatic session expiry, retention limits, or agent-history deletion.
- Separate agent processes or workspace sandboxes per thread.
- Changing room membership, sender authorization, or encryption requirements.
- Thread routing for unsolicited MCP-originated messages.

## Specification

### Configuration and compatibility

Add a global `[matrix]` setting, proposed as
`response_mode = "room" | "thread"`. Omission must select `"room"`; unknown
values must fail configuration validation.

Room mode must retain current behavior, including room-local `/reset` and
rejection of inbound thread relations. Thread mode changes both Matrix output
placement and ACP session scope; it is not merely a presentation option.

### Thread roots and inbound routing

In thread mode, each authorized, ordinary top-level message must start an
independent conversation. Its Matrix event ID is the thread root; the bridge
must send its response into a thread rooted at that message, rather than post a
separate agent-owned root. An ordinary Matrix reply without an `m.thread`
relation is still a top-level message and starts its own conversation.

An authorized message with a valid `m.thread` relation must route to the
conversation identified by `(room ID, thread root event ID)`, not by its
fallback reply target. Repeated follow-ups reuse that conversation's current
ACP session. Different roots must not share sessions, even within one room.

Inbound authorization must accept supported Matrix thread relation shapes,
validate their event IDs and field types, and strip actual reply fallbacks
without removing ordinary quoted text. Edits, malformed relations, unsupported
relations, redactions, self-authored messages, and unauthorized senders remain
rejected. Authorization must occur before session creation or loading.

The policy for a thread whose root has no bridge mapping is an open question
below. Missing mappings alone must not authorize replaying or prompting from
historical root content.

### Outbound messages

All turn-related output must stay in its originating thread: agent text,
verbose thought/tool activity, multipart continuations, reset acknowledgements,
and applicable busy, oversized, timeout, cancellation, or error responses.
Thread metadata must be present on original messages and retained in edited
replacement content without replacing the edit's `m.replace` relation.

Every part of a turn must target the same root. Retry behavior and deterministic
transaction IDs must continue preventing duplicate sends. Relation metadata
must be included in full-payload byte accounting where such accounting is used.

Threaded output must use the existing validated-room encryption path. There
must be no plaintext fallback when encryption is required. Matrix clients
without thread support may display fallback replies in the main timeline; the
bridge cannot guarantee a thread-only presentation in every client.

### Sessions, persistence, and retention

Session identity must be scoped by room and thread root. Persist a new mapping
before its first prompt when the agent supports `session/load`. On restart,
load the session lazily when its thread next receives work, and suppress ACP
history replay during loading as in the persistence milestone.

Without `session/load`, old conversation context cannot survive bridge restarts;
the first subsequent prompt must create a fresh session. Healthy-transport
stale-session errors must retain the existing fresh-session recovery policy,
but apply only to the affected thread. Protocol or transport failures must not
be disguised as successful session recovery.

There must be no automatic expiry or eviction of valid persisted thread/session
mappings based on age, inactivity, or count. Existing removal of mappings for
rooms no longer allowed remains applicable. Reset replaces a mapping but does
not request deletion of agent-owned history. Sessions and histories can therefore
accumulate; retention controls are deferred until needed.

Retaining a mapping must not imply eagerly loading every session on startup.
Agent-side memory retention depends on the ACP implementation; this feature
makes no guarantee that inactive agent sessions are unloaded.

### Queueing and concurrency

Prompts within one thread must execute serially in admission order. Different
threads, including threads in the same room, must be eligible to run concurrently,
bounded by `max_concurrent_prompts`. Starting or resetting one thread must not
cancel another thread's active work.

The proposed queue policy applies `max_queued_turns_per_room` as an aggregate
waiting-work limit across a room's threads, preserving its current room-wide
resource bound rather than multiplying it by the number of threads. This policy
needs confirmation before implementation.

Typing state is room-scoped in Matrix. The bridge must not clear room typing
while another thread still has active work requiring the indicator. Existing
receipt, catch-up, deduplication, cancellation, shutdown, and retry guarantees
remain applicable; they must not cause cross-thread output or state changes.

### Reset

In thread mode, an exact normalized body of `/reset` inside a thread must reset
only that thread's session. It must enter the same ordered queue as prompts,
without cancelling active work. When it reaches the front, atomically remove
the existing mapping and discard the current session reference. Send
`Agent session reset.` inside that thread only after the state change succeeds.
The next ordinary prompt must lazily create a fresh session; reset must not
reuse the old session. No agent-owned history is deleted.

An exact top-level `/reset` must have no effect: no session creation, no ACP
prompt, no reset, and no response. Existing authorization, deduplication, and
receipt handling still apply. Other slash-prefixed text remains ordinary prompt
text under the existing exact-match policy.

### State migration and mode changes

The state format must distinguish room mappings from thread mappings. Existing
room-scoped state must remain usable in room mode; enabling thread mode must
not assign an old shared room session to any thread. Disabling thread mode must
not treat a thread session as the room session.

Thread mappings should remain available across mode changes when the agent
supports loading, so temporarily disabling thread mode does not itself erase
thread context. The implementation must document the migration and rollback
policy before changing the durable state schema.

## Verification

- Default configuration preserves existing room-mode behavior; invalid modes fail.
- Two top-level messages in one room create different ACP sessions and roots.
- Thread follow-ups reuse the correct session, including fallback replies that
  reference another event within the same thread.
- Same-thread prompts serialize; different threads run concurrently within the
  global limit and enforce the selected queue bound.
- Unauthorized, malformed, edited, and duplicate events create no extra sessions.
- Agent text, activity, edits, split output, errors, and retries retain correct
  thread placement in plaintext and encrypted end-to-end tests.
- Thread reset affects only subsequent work in that thread; top-level reset is
  a no-op. Failed state writes cannot produce successful reset acknowledgements.
- Restart loads only requested thread sessions, suppresses history replay, and
  recovers stale mappings without affecting other threads.
- Missing `session/load` support follows the documented fresh-session behavior.
- No inactivity or age-based cleanup removes persisted mappings.
- Existing state migration and mode switching never cross-associate sessions.
- Concurrent turns preserve room typing state until the last relevant turn ends.
- Verify thread display and follow-ups in the Matrix client used for deployment.

## Open questions

- Confirm the configuration spelling and aggregate room queue policy above.
- Should a valid follow-up in an unmapped thread create a fresh session, or only
  threads rooted at previously admitted top-level messages be supported? The
  answer also governs existing threads and roots absent from local history.
- Define durable-state rollback support and retention across mode changes.
- Decide how future unsolicited MCP messages interact with threaded rooms;
  they remain outside this feature's initial routing scope.

## References

- [Plaintext Matrix bridge](m1-plaintext-matrix.md)
- [Persistence and session reset](m2-persistence.md)
- [Encryption](m3-encryption.md)
- [Verbose ACP output](verbose-acp-output.md)
- [Matrix bridge as MCP server](matrix-bridge-as-mcp-server.md)
