+++
status = "draft"
created = 2026-10-01
last_update = 2026-10-01
+++

# Message delivery: prompts and steering

## Purpose

Let Matrix users steer a running agent turn without waiting for the next prompt.
Keep the bridge's existing prompt FIFO and tracked turn completion, while adding
a separate bounded path for steering requests.

## Context

[pi-acp PR #115](https://github.com/svkozak/pi-acp/pull/115) proposes the optional
ACP extension `_session/steering`, advertised in the initialize response at
`_meta.steering.supported = true`.

The response timings differ:

- `session/prompt` resolves when its requested turn finishes. Assistant text and
  activity arrive separately through `session/update` notifications.
- `_session/steering` returns `injected` after pi-acp awaits Pi's native `steer`
  RPC successfully. This is an agent-server acknowledgement delivered by the SDK,
  not a result synthesized by the SDK. It acknowledges acceptance, not consumption.
- With `_meta.steering.idleBehavior = "promptRequired"`, idle steering returns
  `promptRequired` with reason `noRunningTurn`, without starting a turn. The bridge
  can automatically submit a tracked prompt; the user need not resend anything.

Pi owns its steering queue and consumption policy. Steering is delivered after
current tool execution and before a subsequent LLM call. It is not cancellation,
immediate tool interruption, or pi's `/steering` queue-mode command.

The bridge currently keeps one unresolved prompt per conversation, followed by
output drain and Matrix delivery. Retaining that behavior avoids the need to
correlate updates from multiple outstanding prompts in one session. Only steering
bypasses the running prompt's completion barrier.

The upstream PR remains open and must be rechecked before implementation. This
proposal extends the plaintext, persistence, thread-session, and verbose-output
specifications.

## Goals

- Support `/prompt <message>` and `/steer <message>` overrides.
- Configure delivery of unprefixed messages globally.
- Send steering during an active prompt without replacing its collector or timer.
- Automatically convert idle steering to a tracked prompt.
- Preserve bounded intake, conversation isolation, and durable completion.

## Non-goals

- Concurrent `session/prompt` requests within one conversation or delegating the
  existing prompt FIFO to pi-acp.
- Reimplementing Pi's steering queue or consumption policy.
- Cancelling or restarting a turn to approximate steering.
- Images, attachments, edits, reactions, or new Matrix event types.
- Detached turns, exactly-once ACP input, or consumption acknowledgements.
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
byte limits must precede admission. Byte limits include the original normalized
body, not only the stripped payload. Diagnostics must not log payloads or raw
ACP errors.

### Conversation routing

Both delivery modes target the existing conversation identity: room in room mode,
or `(room ID, thread root event ID)` in thread mode. Thread follow-ups must never
select another session by sender, room activity, or fallback reply target.
Unknown threads retain the existing error without an ACP call.

In thread mode, a top-level message, including `/prompt` or `/steer`, starts a
new independent conversation. Since that conversation has no running prompt,
steering-selected input automatically becomes a tracked prompt. When steering is
available, explicit `/steer` receives `No running turn; message queued as a prompt.`; default-selected steering
converts silently. It must not steer an unrelated active thread. Applicable output
belongs in the new message's thread.
Reset retains its existing thread-mode guidance and scope.

### Prompt FIFO and steering admission

Prompt-selected input must keep the existing per-conversation FIFO. Its active
entry remains active through prompt completion, output drain, and Matrix delivery.
There must still be at most one unresolved `session/prompt` per conversation.

Steering-selected input is eligible for a steering RPC only when dispatch is
open, support is advertised, the target session has an unresolved prompt, and
the run has not entered cancellation, timeout, shutdown, or fatal handling.
Record typed explicit/default selection provenance at admission and preserve it
through setup, dispatch gates, reset barriers, and prompt conversion. Do not infer
it from stripped payloads or reparse original text when rendering notices.
Choose the delivery mode at admission, but evaluate running-turn eligibility at
dispatch. Preserve steering selection while dispatch is closed or an earlier
prompt is starting (session setup/loading or permit waiting); do not eagerly
convert a whole admitted batch to prompts merely because setup has not finished.
Once the earlier prompt is submitted, waiting steering may target that turn.

If the conversation has no active or starting prompt, the first steering-selected
entry automatically becomes a tracked prompt. Later steering-selected entries
wait for that prompt to start, then are reevaluated. During post-prompt output
drain, input may wait for drain to finish before applying the same rule. Do not
require a second user command. These rules apply to live and catch-up input alike.

Maintain a bounded steering lane separate from the prompt FIFO. It may send input
to the running turn while ordinary prompts wait for future turns. An earlier
queued ordinary prompt does not block steering: choosing steering explicitly,
or configuring it as the default, selects the running turn rather than a future
turn. This cross-lane behavior must be documented.

Pending steering entries, including an unresolved steering RPC, plus waiting
prompt entries must share `max_queued_turns_per_conversation`. The active prompt
remains excluded. A full queue retains the existing busy response without ACP
input. Serialize steering requests within a conversation in admission order,
with at most one unresolved steering RPC per conversation.

Steering must not acquire a global prompt permit, increase `unresolvedPrompts`,
replace a text/activity collector, or restart the active turn's timeout. Bound
steering RPC lifetime by `startup_timeout_seconds`. A timeout has an ambiguous
outcome and must not trigger automatic prompt redelivery.

### Capability and wire contract

Enable steering only when initialize metadata contains boolean
`_meta.steering.supported = true`. Absent, false, or malformed optional metadata
means unsupported, not a startup failure. Preserve other capabilities, including
`loadSession`.

Issue `_session/steering` as a JSON-RPC request on the shared connection, with
these params:

```json
{
  "sessionId": "<conversation-session-id>",
  "prompt": [{ "type": "text", "text": "<payload>" }],
  "_meta": { "steering": { "idleBehavior": "promptRequired" } }
}
```

Every request must include the idle opt-in. The local unresolved prompt is an
eligibility check, not proof that the agent is still running when it receives
the request. The agent response resolves this boundary race.

For validated `injected`, remove the entry from the steering lane and durably
complete its Matrix event. Successful injection must be silent: send no Matrix
acknowledgement message. Pi owns subsequent delivery. Do not submit the payload
through `session/prompt` or wait for model consumption. The original prompt's
completion remains independent. Errors and unsupported-agent fallback notices
remain visible for explicit and default selection. Idle fallback notices are
visible only for explicit `/steer`.

For `promptRequired` with reason `noRunningTurn`, convert that same entry to a
tracked prompt with the same payload and event identity exactly once. Transfer
its waiting capacity rather than allocating a second slot. Place converted input
in the prompt FIFO according to original admission order relative to other
waiting prompts; do not overtake the active entry. For explicit `/steer`, send
`No running turn; message queued as a prompt.` Default-selected steering converts
silently, both for local idle dispatch and ACP `promptRequired`. The event remains
incomplete until that prompt reaches its normal terminal boundary.

The coordinator must settle outstanding steering decisions before starting the
next prompt or reset in the conversation, even if the original prompt resolves
first. Unsent steering entries must be reevaluated at dispatch: if no prompt is
active or starting, convert the first eligible entry to a prompt and let later
steering wait for it to start. Late responses must not attach to a replacement
session or a later turn's collector.

Unknown/malformed outcomes and `startedNewTurn` despite the idle opt-in must be
fatal protocol failures: detached turns cannot be safely tracked. Additional
unrelated result metadata may be ignored.

### Compatibility and reset

If steering is unsupported, steering-selected input must use the existing prompt
FIFO. Send `Steering unavailable; message queued as a prompt.` for both explicit
and default selection. No startup failure or concurrent-prompt assumption is
introduced.

`/reset` remains an ordered local control command. Earlier admitted steering may
settle before reset, but later steering must not bypass a queued reset: it becomes
prompt input behind that barrier and uses the replacement session. Reset must
wait for the active entry and outstanding steering decisions before changing the
mapping. Normal queued prompts do not form this steering barrier.

### Output, failures, and lifecycle

Assistant text, activity, typing, and final output continue to belong to the
original running prompt. Steering does not create another response turn. Its
acknowledgements and errors use its own validated conversation routing. All
output retains existing encryption, full-payload byte accounting, deterministic
transaction IDs, and retries. No plaintext fallback is permitted.

A healthy-transport steering method error must not cancel the original prompt.
Complete the steering event and send
`Steering failed; message was not resubmitted.` Do not automatically retry or
forward the payload: an error can follow a side effect. Method-not-found must
also disable steering for that connection; subsequent messages use FIFO fallback.

Protocol/transport failures retain existing fail-closed behavior. Timeout or a
lost response is not proof that injection failed. Failed durable completion is a
fatal state failure, not grounds to retry ACP input.

Removing a steering entry after `injected` is distinct from finishing its durable
callback. `waitForIdle`, run finalization, cancellation,
and shutdown must account for all such work. No new steering RPC may be sent
after dispatch closes or cancellation begins. Outstanding calls must settle or
be interrupted within existing bounded shutdown handling; late results must not
revive closed collectors.

Selected startup catch-up messages must use the same delivery rules as live input,
with existing age/count limits. `/prompt` selects prompt, `/steer` selects steering,
and unprefixed text uses the default. In a recovered conversation with no running
turn, the first steering-selected message starts a tracked prompt; later selected
messages may steer it once it starts. Admission while the startup dispatch gate is
closed must preserve these choices. No special catch-up conversion policy applies.

Catch-up targets current session state, not a reconstructed pre-crash turn.
Completed injected event IDs must be suppressed by the durable ledger. Converted
prompts remain incomplete until normal terminal handling. No state schema
migration is required.

Existing crash gaps remain: an ACP side effect before durable completion can cause
replay, and steering acceptance does not prove consumption before a crash. Neither
agent queues nor in-flight bridge work are promised recoverable. Do not claim
exactly-once input delivery or that bridge backlog limits bound Pi's accepted queue.

## Delivery scope

Implementation requires coordinated changes to:

- Configuration, example configuration, and tests: the delivery default.
- `src/acp-client.ts`: optional capability parsing, typed steering results/errors,
  concurrent extension requests, and result validation. Verify the extension API
  in pinned SDK 1.3.0; upgrade only if necessary.
- `src/bridge.ts`: command selection, bounded steering admission, shared backlog
  accounting, idle conversion, reset barriers, and boundary/lifecycle handling.
- Response rendering and sync integration: acknowledgements and independent
  terminal callbacks without treating queued fallback as completed work.
- Fake-agent tests and `README.md`: command precedence, lane ordering, unsupported
  fallback, acceptance versus consumption, and restart limitations.

The existing prompt FIFO, single-turn collectors, inbound encryption path,
conversation identities, session mappings, and nonblocking sync admission remain
reusable. No prompt-acceptance extension, concurrent-prompt correlation contract,
Matrix protocol extension, or agent spawning is required.

## Verification

Tests must establish:

- Configuration defaults/validation, explicit override precedence, preserved
  payloads, empty commands, and reset recognition independent of default.
- Capability true/false/absent/malformed cases, preservation of `loadSession`,
  exact wire params, and a steering response while the prompt Promise is pending.
- Prompt messages retain serial FIFO behavior; steering bypasses ordinary waiting
  prompts but not a reset barrier. Steering ordering and shared bounds hold.
- Injected input is sent once with no extra prompt, collector, permit, or timer
  reset. Its durable callback is independent of the original prompt's callback.
- Explicit idle and `promptRequired` fallback sends the idle notice; default-selected
  steering silently converts in both cases. Mixed setup/gated batches preserve
  provenance; unsupported fallback and actual errors stay visible for both.
- Idle, unsupported-agent, and `promptRequired` fallback produces exactly one
  tracked prompt with the same payload/event identity, without requiring another
  user command or marking queued input complete. Dispatch gates, setup, permit
  waiting, and drain must preserve later entries' steering selection.
- Prompt resolution before the steering response cannot start the next prompt or
  reset prematurely, misroute late output, or lose terminal callbacks.
- Unauthorized, duplicate, oversized, queue-full, and unknown-thread input sends
  no unintended RPC. Separate rooms/threads cannot steer each other.
- Top-level thread-mode steering starts an independent tracked prompt. Successful
  injection sends no acknowledgement; encrypted fallback notices and threaded
  output retain routing and size limits.
- Method errors preserve the active prompt; method-not-found disables support;
  malformed outcomes, ambiguous timeouts, and transport/state failures fail closed
  without automatic input retry.
- Cancellation, shutdown, late results, durable completion, and idle waiting
  account for pending steering work without reviving old sessions.
- Restart suppresses completed injected events, while converted prompts retain
  existing recovery behavior. Live and catch-up batches both permit the first
  steering-selected message to start a prompt and later messages to steer it,
  including when the batch is admitted before dispatch or session setup completes.

Implementation must pass `npm run check`. Manual integration against the finalized
pi-acp extension must verify server acknowledgement during a running turn and
idle automatic prompt fallback. RPC behavior, not whether a model happens to
follow the correction, is the acceptance criterion.

## Open questions

- Which finalized pi-acp revision supplies the steering contract?
- Should a later feature add Pi queue-capacity or consumption visibility? PR #115
  does not provide either; this feature must not assume they exist.

## References

- [pi-acp PR #115](https://github.com/svkozak/pi-acp/pull/115), reviewed while open.
- [Thread-scoped agent sessions](thread-scoped-agent-sessions.md).
- [Persistence milestone](m2-persistence.md).
- [Verbose ACP output](verbose-acp-output.md).
