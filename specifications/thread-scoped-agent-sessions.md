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
- Keep room-scoped behavior as the default; use thread-scoped behavior only when
  explicitly configured.

## Non-goals

- Per-room configuration overrides.
- Automatic session expiry, retention limits, or agent-history deletion.
- Separate agent processes or workspace sandboxes per thread.
- Changing room membership, sender authorization, or encryption requirements.
- Thread routing for unsolicited MCP-originated messages.

## Specification

### Configuration and compatibility

Add a global `[matrix]` setting, `response_mode = "room" | "thread"`.
Omission must select `"room"`; unknown values must fail configuration validation.
Add `max_queued_turns_per_thread` under `[limits]`, defaulting independently to
16 even when `max_queued_turns_per_room` is customized.

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

An authorized follow-up in an unknown thread must receive the exact error
`Unknown thread agent session. Please start a new thread.` inside that thread.
The bridge must not create or load an ACP session, forward the follow-up to ACP,
or replay historical root content. This also applies to `/reset` in an unknown
thread. A known thread awaiting session creation after admission or reset is
not an unknown thread; its routing identity must remain recorded.

A top-level message rejected as oversized or busy must receive its applicable
error in a thread rooted at that message, but must not establish a known-thread
identity or ACP session. Follow-ups in that thread must receive the unknown-thread
error; the user must start a new top-level conversation.

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
follow-ups in those old threads must receive the unknown-thread error rather
than silently start a fresh conversation. New top-level messages remain supported.
Healthy-transport stale-session errors must retain the existing fresh-session recovery policy,
but apply only to the affected thread. Protocol or transport failures must not
be disguised as successful session recovery.

There must be no automatic expiry or eviction of valid persisted thread/session
mappings based on age, inactivity, or count. Existing removal of mappings for
rooms removed from `allowed_rooms` remains applicable, including all thread
mappings for those rooms. Removing a sender from `allowed_senders` must not
remove mappings; authorization still gates every inbound message.
Reset clears a session mapping while preserving the thread identity and does
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

In thread mode, `max_queued_turns_per_thread` must limit waiting work separately
for each thread. A full thread queue must reject additional work with the existing
busy response inside that thread without affecting admission to other threads.
Room mode must continue using `max_queued_turns_per_room`. The new setting must
use the same default and validation rules as the existing room queue setting.

Thread mode has no aggregate room-wide waiting-work limit; total queued work can
grow with the number of threads. `max_concurrent_prompts` retains its existing
name and semantics: it bounds unresolved ACP prompt requests only. Session
creation and loading do not consume prompt slots and may run concurrently across
threads without a separate limit. Session unloading, a setup-concurrency limit,
and an aggregate backlog cap are outside this feature's scope.

Typing state is room-scoped in Matrix. The bridge must not clear room typing
while another thread still has active work requiring the indicator. Existing
receipt, catch-up, deduplication, cancellation, shutdown, and retry guarantees
remain applicable; they must not cause cross-thread output or state changes.

### Reset

In thread mode, an exact normalized body of `/reset` inside a thread must reset
only that thread's session. It must enter the same ordered queue as prompts,
without cancelling active work. When it reaches the front, atomically remove
the existing session mapping and discard the current session reference, while
retaining the thread's known routing identity. Send
`Agent session reset.` inside that thread only after the state change succeeds.
The next ordinary prompt must lazily create a fresh session; reset must not
reuse the old session. When `session/load` is supported, the known-thread identity
without a session ID must be persisted atomically with removal of the old mapping,
so restarting before the next prompt still permits fresh-session creation.
No agent-owned history is deleted.

An authorized exact top-level `/reset` must send the unthreaded response
`Use /reset inside a thread to reset its agent session.` It must not create a
session or thread mapping, send an ACP prompt, or reset any session. The response
must use the existing validated-room encryption path and deterministic transaction
IDs. Existing authorization, deduplication, and receipt handling still apply.
Other slash-prefixed text remains ordinary prompt text under the existing
exact-match policy.

### State migration and mode changes

The state format must distinguish room mappings from thread mappings. Existing
room-scoped state must remain usable in room mode; enabling thread mode must
not assign an old shared room session to any thread. Disabling thread mode must
not treat a thread session as the room session.

When the agent supports loading, both room and thread mappings, including
sessionless known-thread identities, must remain available across mode changes.
Returning to a mode must resume its retained context without assigning sessions
from the other mode. Removed-room cleanup still applies to both sets of mappings.

Existing state must migrate automatically, preserving account identity, sync
recovery state, completed-event IDs, and room sessions. Users must back up private
bridge state before upgrading; the bridge creates no automatic backup. Migration
uses the normal atomic write/file-fsync/rename/directory-fsync sequence. Failures
stop startup; pre-rename failures retain original state, while post-rename fsync
failures have an indeterminate disk commit.

Rollback to an older binary requires stopping the bridge and restoring the user's
own pre-upgrade backup; post-migration state changes are lost. Document this procedure. Unsupported
or invalid state must fail startup with recovery guidance, never silently reset.
A downgrade/export tool is not required.

## Verification

- Default configuration preserves existing room-mode behavior; invalid modes fail.
- Two top-level messages in one room create different ACP sessions and roots.
- Thread follow-ups reuse the correct session, including fallback replies that
  reference another event within the same thread.
- Same-thread prompts serialize; different threads run concurrently within the
  global prompt limit. Session creation/loading does not consume prompt slots.
  Each thread independently enforces `max_queued_turns_per_thread`;
  filling one thread's queue does not block admission to another thread.
- Room mode retains `max_queued_turns_per_room`; the thread queue setting uses
  the same default and validation rules.
- Unauthorized, malformed, edited, and duplicate events create no extra sessions.
- Agent text, activity, edits, split output, errors, and retries retain correct
  thread placement in plaintext and encrypted end-to-end tests.
- Thread reset affects only subsequent work in that thread. Authorized top-level
  reset returns the specified unthreaded guidance without ACP calls, mapping
  creation, or session changes; unauthorized or duplicate events send no response.
  The guidance follows encryption and retry guarantees.
  Failed state writes cannot produce successful reset acknowledgements.
- Restart loads only requested thread sessions, suppresses history replay, and
  recovers stale mappings without affecting other threads.
- Unknown-thread follow-ups, including `/reset`, return the specified error in
  that thread without ACP calls or historical replay.
- Missing `session/load` support causes old threads to return the unknown-thread
  error after restart; new top-level messages still create sessions.
- Follow-ups after a known thread's reset create a fresh session rather than
  incorrectly returning the unknown-thread error, including after a restart
  between reset and the next prompt when `session/load` is supported.
- Rejected oversized or busy top-level messages create no known-thread identity
  or ACP session; follow-ups in their error threads receive the unknown-thread error.
- No inactivity or age-based cleanup removes persisted mappings. Removing a
  room from `allowed_rooms` prunes its mappings; removing a sender rejects their
  messages without removing mappings.
- State migration preserves existing recovery state and sessions without creating
  a backup. Atomic writes retain original state on pre-rename failure; all write
  failures are fatal. Existing backups are untouched. Restore-based rollback using
  a user-managed pre-upgrade backup is documented and tested; incompatible state
  is never silently erased.
- Mode switching retains both sets of mappings and sessionless thread identities
  when loading is supported, and never cross-associates sessions.
- Concurrent turns preserve room typing state until the last relevant turn ends.
- Verify thread display and follow-ups in the Matrix client used for deployment.

## Open questions

- Decide how future unsolicited MCP messages interact with threaded rooms;
  they remain outside this feature's initial routing scope.

## References

- [Plaintext Matrix bridge](m1-plaintext-matrix.md)
- [Persistence and session reset](m2-persistence.md)
- [Encryption](m3-encryption.md)
- [Verbose ACP output](verbose-acp-output.md)
- [Matrix bridge as MCP server](matrix-bridge-as-mcp-server.md)
