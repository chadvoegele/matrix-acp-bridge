+++
status = "draft"
created = 2026-10-01
last_update = 2026-10-01
+++

# Message delivery: prompts and steering

## Purpose

Let Matrix users choose between a new agent turn and steering a running turn.
Delegate agent-side queueing to pi-acp and Pi rather than holding every Matrix
message until the current turn finishes. Retain bounded dispatch, tracked
completion, conversation isolation, and restart safety.

## Context

[pi-acp PR #115](https://github.com/svkozak/pi-acp/pull/115) proposes the optional
ACP extension `_session/steering`. Support is advertised in the initialize
response at `_meta.steering.supported = true`.

The relevant queues serve different purposes:

| Interface               | Queue owner and behavior                                                                                    | Response timing                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| ACP `session/prompt`    | pi-acp queues concurrent requests as separate future turns in the same session.                             | After that request's turn completes.    |
| ACP `_session/steering` | pi-acp forwards input to Pi's native steering queue. Pi decides when to deliver it within the running turn. | After Pi acknowledges the steering RPC. |
| Pi native follow-up     | Pi waits until the agent has no more tool calls or steering messages.                                       | Not separately exposed by PR #115.      |

Pi steering is delivered after current tool execution and before a subsequent
LLM call. Pi controls delivery mode (all messages or one at a time). The bridge
must not reimplement these agent queues. Steering is not cancellation, immediate
tool interruption, or pi's `/steering` command for configuring delivery mode.

The bridge currently holds a per-conversation FIFO through prompt completion,
output drain, and Matrix delivery. The ACP adapter has one text collector per
session; the coordinator likewise has one turn collector per session. Both
assume only one unresolved prompt per session. Delegating prompt queueing therefore
requires more than replacing the dispatch call.

Two protocol constraints matter:

- `session/prompt` has no separate acceptance acknowledgement. Successful local
  submission is not proof of server acceptance; its response is turn completion.
- ACP updates identify a session, not the originating prompt request. With
  multiple outstanding prompts, the bridge needs reliable turn boundaries to
  attribute streaming output, activity, timeouts, and Matrix replies.

The upstream PR remains open and must be rechecked before implementation. This
proposal extends the plaintext, persistence, thread-session, and verbose-output
specifications.

## Goals

- Support `/prompt <message>` and `/steer <message>` overrides.
- Configure delivery of unprefixed messages globally.
- Dispatch ready input without waiting for the previous turn to finish when the
  agent contract supports it; let pi-acp/Pi own accepted input queues.
- Separate local dispatch backlog from outstanding requests and durable completion.
- Preserve compatibility with agents that do not advertise steering.

## Non-goals

- Reimplementing Pi's steering/follow-up queues or their consumption policy.
- Cancelling or restarting a turn to approximate steering.
- Images, attachments, edits, reactions, or new Matrix event types.
- Detached, untracked ACP turns or exactly-once ACP input.
- Claiming a local backlog limit bounds input already accepted by Pi.
- Implementing the feature in this documentation PR.

## Specification

### Configuration and commands

Add global `[matrix]` configuration:

```toml
[matrix]
default_message_delivery = "prompt" # "prompt" | "steer"
```

Omission must select `"prompt"`. Unknown values must fail validation. No per-room
or per-sender override is introduced.

After existing normalization and authorization:

- `/prompt` followed by whitespace and a nonempty payload selects prompt delivery.
- `/steer` followed by whitespace and a nonempty payload selects steering delivery.
- Other ordinary text selects `default_message_delivery`.
- Exact `/reset` remains a bridge control command, regardless of the default.

Explicit commands must override configuration. Strip the delivery command and
separating whitespace, preserving the remaining payload. Bare commands or
whitespace-only payloads must receive `Usage: /prompt <message>` or
`Usage: /steer <message>` without ACP input. A `/reset` inside a delivery-command
payload is agent text, not a bridge reset. Other slash commands remain agent text
and use the configured default; the bridge does not configure Pi's queue modes.

Authorization, encryption policy, relation validation, deduplication, and input
byte limits must precede dispatch. Byte limits include the original normalized
body, not only the stripped payload. Diagnostics must not log message payloads
or raw ACP errors.

### Conversation routing

Both delivery modes target the existing conversation identity: room in room mode,
or `(room ID, thread root event ID)` in thread mode. A valid thread follow-up must
never select another session by sender, room activity, or fallback reply target.
Unknown threads retain the existing error without an ACP call.

In thread mode, a top-level message, including `/prompt` or `/steer`, starts a
new independent conversation. Since that conversation is idle, steering delivery
must become a tracked prompt as described below. It must not steer an unrelated
active thread. Applicable responses and acknowledgements belong in the new
message's thread. Reset retains its existing thread-mode guidance and scope.

### Prompt delivery and local dispatch

Prompt delivery must issue a tracked `session/prompt` request with the selected
payload. For an agent with a verified concurrent-prompt/turn-boundary contract,
the bridge must not wait for the previous prompt to resolve before submitting
another prompt in the same session. pi-acp owns the future-turn FIFO.

The local queue holds only work awaiting session setup, dispatch readiness,
transport capacity, or an outstanding-request limit. Once submitted, remove a
prompt from that queue and retain a separate outstanding-request record until
terminal handling. Do not label submission as confirmed server acceptance.

Dispatch must preserve admission order within a conversation. Waiting for a
request's response must not block dispatch of later eligible input. Streaming
output drain and Matrix delivery must not unnecessarily block input submission.

`max_queued_turns_per_conversation` must bound local waiting input, not the
agent's queue or all submitted requests. Existing `max_concurrent_prompts` must
continue bounding unresolved `session/prompt` requests globally, including those
queued at pi-acp. A prompt can consequently wait for a permit; this is capacity
backpressure, not a mandatory turn-completion barrier. Steering must not require
a prompt permit. Queue-full behavior retains the existing busy response.

### Steering contract

Enable steering only when initialize metadata contains boolean
`_meta.steering.supported = true`. Absent, false, or malformed optional metadata
means unsupported, not a startup failure. Preserve other capabilities, including
`loadSession`.

Issue `_session/steering` as a JSON-RPC request on the shared connection:

```json
{
  "sessionId": "<conversation-session-id>",
  "prompt": [{ "type": "text", "text": "<payload>" }],
  "_meta": { "steering": { "idleBehavior": "promptRequired" } }
}
```

Every call must include the idle opt-in. Let the agent determine whether it is
running; a bridge active entry is not authoritative during setup, turn transitions,
or output drain. Steering requests must not replace prompt collectors, acquire
prompt permits, or restart any active turn's timeout.

After validated `injected`, remove the entry from local dispatch tracking, durably
complete its Matrix event, then acknowledge
`Steering accepted.` This means RPC acceptance, not model consumption or completion.
Pi owns subsequent delivery of that input. Do not resend it as a prompt.

For `promptRequired` with reason `noRunningTurn`, convert the same entry to a
tracked prompt with the same payload and event identity exactly once. Preserve
its position ahead of later unsent input; do not allocate a second local queue
slot. No detached turn may be started by the bridge.

Serialize steering submission per conversation, with at most one unresolved
steering RPC per conversation. Bound waiting steering input through the same
local backlog limit as prompts. Use `startup_timeout_seconds` to bound a steering
RPC; timeout means ambiguous delivery, not safe prompt fallback.

Unknown/malformed outcomes and `startedNewTurn` despite the idle opt-in must be
fatal protocol failures. Additional unrelated result metadata may be ignored.

### Compatibility fallback

If steering is unsupported, steering-selected input must use ordinary prompt
delivery. Tell the user `Steering unavailable; message submitted as a prompt.`
only once the prompt is actually submitted. Unsupported agents must retain the
existing client-side FIFO unless their concurrent prompt and output-attribution
contract has been verified. Do not assume that generic ACP agents implement
pi-acp's prompt queue merely because they accept `session/prompt`.

A method-not-found response must disable steering for that connection. The failed
entry must receive an error without automatic redelivery; subsequent messages
use the compatibility fallback. Other healthy-transport method errors likewise
must not retry input or cancel unrelated outstanding prompts. Complete the failed
steering event and send `Steering failed; message was not resubmitted.` An error
can follow a side effect, so successful fallback must not be inferred from it.

### Outstanding turns and output attribution

Submitted prompts must retain independent event identities, request outcomes,
terminal-completion callbacks, timeout state, and output routing. Do not overwrite
a session-keyed collector when another prompt is submitted.

Before enabling concurrent prompt submission for pi-acp, establish a reliable
way to identify when each queued request's turn starts and which request owns
its updates. The existing queue-depth metadata and human-readable queue notices
are not sufficient as a stable correlation contract. Choose and verify an
upstream turn-start/request-identity extension, or a documented ordering contract
that covers updates and response boundaries. Do not guess attribution from text,
message IDs, timing, or arrival of the previous prompt response alone.

This is a delivery prerequisite, not a reason to silently drop output or claim
server-side queue delegation is complete. Without that contract, retain serial
prompt fallback and document the limitation. Steering of the single running
prompt can be supported independently.

Each prompt's assistant text, activity, final output, and applicable errors must
route to its originating Matrix event/conversation. Steering itself does not
create a new response turn. Its acknowledgement uses the steering event's
routing. All output retains existing encryption, full-payload byte accounting,
deterministic transaction IDs, and retries.

Prompt timeout must distinguish waiting at the agent from executing an active
turn once reliable turn-start metadata exists. Cancellation is session-scoped:
pi-acp cancels the running turn and clears queued prompts. The bridge must not
claim to cancel only one queued request. This lifecycle must be reflected in the
outcomes and terminal handling of every affected outstanding request.

### Reset, completion, and restart

`/reset` is a local control barrier, not input for Pi. Previously submitted work
and earlier local input must finish terminal handling before the session mapping
is reset. Later input must wait behind reset and then use the replacement session.
Ordinary messages have no equivalent mandatory completion barrier.

Removing input from the dispatch queue must not mark its Matrix event complete.
Prompts, including idle-steering conversions, reach durable completion only at
the existing terminal boundary. Injected steering reaches that boundary after
its validated acknowledgement. State failure remains fatal. Submitted input must
never be retried solely because its local queue entry has been removed.

Cancellation, shutdown, fatal handling, and `waitForIdle` must account for both
local backlog and outstanding requests. No new RPC may be sent after dispatch
closes. Late results must not revive closed collectors or attach to replacement
sessions. Shutdown remains bounded by existing grace handling; session cancellation
must account for pi-acp's queued requests as well as its running turn.

Selected startup catch-up messages must honor explicit commands and the configured
default, with existing age/count limits. Completed event IDs remain suppressed.
Catch-up steering is delivered to the agent's current session state, not a
reconstructed pre-crash turn; if idle, it becomes a tracked prompt. This must be
documented so historical corrections are not mistaken for guaranteed replay into
their original turn.

No persistent schema migration is required merely to distinguish dispatch from
completion. Existing crash gaps remain: server acceptance before durable completion
can cause replay, and steering acceptance does not prove consumption before a
crash. Neither agent queues nor bridge outstanding requests are promised to be
recoverable across restart. Do not claim exactly-once input delivery.

## Delivery scope and prerequisites

Implementation requires coordinated changes to:

- `src/config.ts`, example configuration, and configuration tests: delivery default.
- `src/acp-client.ts`: capability parsing, a typed steering API, concurrent request
  tracking, result validation, and per-request output attribution. Verify the
  extension API in pinned SDK 1.3.0; upgrade only if necessary.
- `src/bridge.ts`: command selection, dispatch/outstanding separation, bounded
  admission, reset barriers, and multi-request lifecycle handling.
- Response rendering and sync integration: acknowledgements and independent
  durable terminal callbacks without confusing submission with completion.
- Fake-agent integration tests and `README.md`: commands, defaults, fallback,
  capacity limits, cancellation scope, and restart limitations.

The inbound encryption path, conversation identities, session mappings, and
nonblocking sync admission are reusable. No Matrix protocol extension or agent
spawning is required. The substantial work is multi-request attribution and
lifecycle handling, not the steering RPC.

The steering extension alone does not provide prompt-acceptance acknowledgements,
turn correlation, or server queue-capacity signals. If confirmed prompt acceptance
is required before removing dispatch entries, an upstream acknowledgement extension
is also needed. Local submission and outstanding tracking are sufficient for this
proposal, provided they are described honestly.

## Verification

Tests must establish:

- Configuration defaults/validation, explicit override precedence, preserved
  payloads, empty commands, and `/reset` recognition independent of default.
- Capability true/false/absent/malformed cases, preservation of `loadSession`,
  exact steering wire payload, and concurrent RPCs on an open prompt connection.
- Ordinary steer-default input reaches steering without waiting for the turn;
  prompt-default and `/prompt` reach server queueing without a completion barrier
  when the required agent contract is available.
- Injected input is sent once with no extra prompt, permit, or timer reset;
  idle steering becomes exactly one tracked prompt with the same event identity.
- Local waiting input is bounded and ordered; dispatched prompts are tracked
  separately. Global prompt limits still hold and do not block eligible steering.
- Multiple submitted prompts retain correct text/activity/output attribution,
  including next-turn updates arriving before the preceding response. Missing
  correlation support selects serial fallback rather than misrouting output.
- Unsupported-agent fallback, reset barriers, session-scoped cancellation,
  per-request terminal callbacks, late results, shutdown, and idle waiting.
- Unauthorized, duplicate, oversized, queue-full, and unknown-thread input sends
  no unintended RPC. Separate rooms/threads cannot steer or reply into each other.
- Top-level thread-mode steering starts an independent tracked prompt; encrypted
  and threaded acknowledgements retain routing and size limits.
- Method errors preserve other requests; method-not-found disables support;
  malformed outcomes, ambiguous timeouts, and transport/state failures fail closed
  without automatic input retry.
- Restart suppresses completed injected events; submitted but incomplete prompts
  retain existing recovery behavior. Catch-up honors delivery selection.

Implementation must pass `npm run check`. Manual integration against the finalized
pi-acp extension must verify both queued prompt submission and steering during a
running turn, idle fallback, and output correlation. RPC behavior—not whether a
model happens to follow a correction—is the acceptance criterion.

## Open questions

- Which finalized pi-acp revision supplies the steering contract?
- What upstream turn-start/request-correlation contract will make concurrent
  prompt submission safe? Is a separate prompt-acceptance acknowledgement useful?
- Does pi-acp expose sufficient queue capacity or queued-request cancellation
  control for future server-side backpressure? PR #115 does not provide these.

## References

- [pi-acp PR #115](https://github.com/svkozak/pi-acp/pull/115), reviewed while open.
- [pi-acp session queue implementation](https://github.com/svkozak/pi-acp/blob/main/src/acp/session.ts).
- [Pi steering and follow-up implementation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/agent-session.ts).
- [Thread-scoped agent sessions](thread-scoped-agent-sessions.md).
- [Persistence milestone](m2-persistence.md).
- [Verbose ACP output](verbose-acp-output.md).
