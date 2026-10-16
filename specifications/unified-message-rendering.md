+++
status = "draft"
created = 2026-10-16
last_update = 2026-10-16
+++

# Unified solicited and unsolicited message rendering

## Purpose

Display agent messages in Matrix through one session-scoped rendering path, whether a user prompt or an extension initiated the agent's work. Buffer streamed chunks to limit Matrix calls without waiting for a prompt response to deliver text.

## Context

The bridge currently collects output within an active prompt. An extension can trigger an unsolicited turn after that prompt completes; its text still arrives through ACP `session/update`, but no active prompt collector exists to display it.

This specification replaces the agent-text portion of **Eager Message Rendering** in [Verbose ACP output](verbose-acp-output.md): identified messages may be sent incrementally and edited rather than sent only once at inferred completion. Existing thought/tool presentation remains unchanged unless needed to preserve routing and ordering.

## Goals

- Display solicited and unsolicited assistant text through the same renderer.
- Group chunks by message identity rather than prompt lifetime.
- Deliver trailing text without requiring a subsequent message or prompt response.
- Bound buffering and Matrix traffic while preserving conversation isolation.

## Non-goals

- Implement message IDs in pi-acp; that is a separate prerequisite.
- Add ACP message-end or unsolicited-turn lifecycle extensions.
- Infer authoritative message or turn completion from silence.
- Change prompt submission, steering, cancellation, or agent execution scheduling.
- Redesign thought/tool rendering or provide durable, exactly-once stream replay.

## Specification

### Adapter prerequisite

Assume pi-acp supplies ACP's optional `messageId` on every assistant text chunk, including unsolicited output. Implementing and validating that support belongs in a separate pi-acp change.

All chunks of one logical assistant message must share an ID; distinct messages must have distinct IDs within a session. Chunks are ordered text deltas, not replacement snapshots. IDs must remain unambiguous for as long as a session can continue delivering updates, including after restoration.

`session/update` is a JSON-RPC notification: it carries `sessionId`, but no JSON-RPC request ID. The renderer must not require an outstanding `session/prompt` or its response to accept text.

### Session routing

The bridge must resolve each update's session ID to its existing authorized Matrix conversation. Room mode sends into that room; thread mode sends into that conversation's existing thread. An unsolicited message must not be attached to whichever user prompt happens to be active.

Unknown, reset, deleted, or superseded sessions must not create conversations or send output. History replay during session loading must not be mistaken for new live output. Existing authorization, encryption, notification filtering, and safe-rendering rules continue to apply.

### Message blocks

Maintain logical blocks keyed by `(sessionId, messageId)`:

- A new ID creates a block in first-seen order.
- A chunk for an existing ID appends to that block, including after a flush, quiet period, or another message ID.
- The first flush sends a Matrix message. Later flushes update the same block using Matrix replacement events.
- An unchanged block must not produce another Matrix call. Do not send empty placeholder messages.
- Repeated message IDs identify the destination block; they do not make repeated chunks duplicates. No chunk-level replay detection is implied.

Message identity and delivery state belong to the session, not a prompt collector. A prompt response must not discard blocks, resend their text as a final reply, or prevent later chunks from being displayed. Existing prompt error/status reporting remains separate; a successful prompt whose text was already displayed must not generate an empty-response fallback solely because its collector owns no text.

### Buffered delivery

Each dirty block must flush when any of these conditions occurs:

1. Its buffered unsent text reaches the configured UTF-8 byte threshold.
2. Its quiet-period timer expires after the most recent chunk.
3. A different message ID arrives in the same session: schedule the previous block's buffered text before publishing the new block.

Continuous low-volume output must also flush within a configured maximum interval from the first unflushed chunk, so repeatedly resetting the quiet timer cannot postpone delivery indefinitely. Thresholds and intervals must be bounded and configurable; exact names and defaults remain an implementation decision.

A quiet timer must fire without another incoming update. Flushing does not finalize a block: later chunks with the same ID continue updating it. A message-ID transition starts another block, not an irreversible close of the previous block. Neither mechanism asserts that an unsolicited turn has ended.

Serialize Matrix operations per conversation and coalesce pending updates to their latest accumulated text. A slow send must not cause concurrent edits or stale edits to overwrite newer text. Flush triggers request delivery; they must not bypass existing transport limits or retry ownership.

### Rendering and resource limits

Render accumulated Markdown through the existing safe converter on each publication. Preserve the original text in the plain-text body. Incomplete Markdown may render differently as later chunks arrive; never expose unsafe HTML while waiting for completion.

Apply existing encoded Matrix event-size and output limits. A logical block may span bounded continuation events; retain their association with the same message ID. Already-published parts must not be duplicated during splitting or edits. If content is truncated by an output limit, retain an explicit truncation marker.

Bound retained blocks, accumulated text, timers, and pending Matrix operations. A quiet period alone must not evict a block's identity. If a block has been evicted, later chunks must not silently create a duplicate message or overwrite an unrelated block; report the retention limit through bounded diagnostics. Exact limits and the retention policy must be defined before implementation.

### Failure and lifecycle handling

Keep existing Matrix delivery failure and backpressure policy. Diagnostics must not include private text or credentials. A timer or send callback from an obsolete session must not publish into its replacement.

On reset, deletion, disconnect, or shutdown, cancel timers and retire rendering state according to the existing lifecycle policy. Previously sent Matrix messages remain. No cross-restart buffer recovery is promised: persisted room/thread routing remains intact, but a restart must not replay session history as new unsolicited output. Any unrecoverable buffered delivery must be observable rather than reported as successful.

### Compatibility

For messages with IDs, the new path is the sole owner of assistant-text publication. It must not coexist with a second prompt-final renderer that duplicates output.

ACP permits missing message IDs. Preserve the existing prompt-scoped behavior for ID-less chunks during a solicited prompt. ID-less unsolicited text cannot be reliably grouped and is outside this feature's adapter contract; emit a bounded diagnostic instead of guessing an ID or a destination. Do not merge ID-less chunks into an identified block.

No stored conversation schema change is required by this proposal. Any persistence added during implementation requires separate migration requirements.

## Verification

- An unsolicited message received after a prompt completes is displayed in its mapped room/thread without any new prompt request or response.
- Solicited and unsolicited chunks with the same identity follow identical append, buffering, send, and edit behavior.
- Repeated IDs append to one block; distinct IDs create separate blocks. The same ID in two sessions remains isolated.
- A quiet period flushes the last chunk without further input. A later chunk updates that block rather than duplicating it.
- A message-ID transition flushes preceding text before the new block is published; a late chunk for the earlier ID still updates its original block.
- Size and maximum-interval triggers deliver continuously streamed text; deterministic-clock tests verify bounded call counts and timer cleanup.
- Slow Matrix requests coalesce edits, preserve ordering, and cannot overwrite newer content with stale snapshots.
- Prompt completion produces neither duplicate text nor a spurious empty response after streamed publication.
- Markdown split across chunks renders safely throughout; long messages respect encoded size limits and preserve text up to explicit output caps.
- Unknown/stale sessions and loading-history updates publish nothing. Reset, shutdown, retention limits, and delivery failures leave no orphan timers or cross-session sends.
- ID-less prompted output retains existing behavior; ID-less unsolicited output produces bounded diagnostics, not guessed grouping.

## Open questions

- Choose configuration names, defaults, and bounds for size, quiet-period, and maximum-interval flushing.
- Define retained-block limits and eviction policy, including how operators observe late chunks beyond retention.
- Specify how existing thought/tool activity interleaves with buffered assistant blocks without changing its presentation contract.

## References

- [ACP prompt turns](https://agentclientprotocol.com/protocol/prompt-turn)
- [ACP schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/schema.json): `ContentChunk.messageId`.
- [Thread-scoped agent sessions](thread-scoped-agent-sessions.md)
