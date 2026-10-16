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

Continuous low-volume output must also flush within a configured maximum interval from the first unflushed chunk, so repeatedly resetting the quiet timer cannot postpone delivery indefinitely. Expose only three publication controls: new unpublished UTF-8 bytes, quiet period, and maximum interval. A message-ID transition is an unconditional flush trigger, not another configuration setting. Exact configuration names, defaults, and bounds remain open.

Keep `max_output_bytes` and `max_matrix_message_bytes` as output/event-size limits, not publication triggers. Remove prompt-scoped text draining, including `QUIET_DRAIN_MS` and `STREAMING_DRAIN_CAP_MS`, from the identified-message path. The quiet-period setting replaces the former text-drain timing role; there is no post-prompt drain deadline. Complete prompt bookkeeping when its ACP response arrives, independently of buffered text publication. These changes must not introduce another equivalent drain configuration.

A quiet timer must fire without another incoming update. Flushing does not finalize a block: later chunks with the same ID continue updating it. A message-ID transition starts another block, not an irreversible close of the previous block. Neither mechanism asserts that an unsolicited turn has ended.

Serialize Matrix operations per conversation and coalesce pending updates to their latest accumulated text. A slow send must not cause concurrent edits or stale edits to overwrite newer text. Flush triggers request delivery; they must not bypass existing transport limits or retry ownership.

### Rendering and resource limits

Render accumulated Markdown through the existing safe converter on each publication. Preserve the original text in the plain-text body. Incomplete Markdown may render differently as later chunks arrive; never expose unsafe HTML while waiting for completion.

Apply existing encoded Matrix event-size and output limits. A logical block may span bounded continuation events; retain their association with the same message ID. Already-published parts must not be duplicated during splitting or edits. If content is truncated by an output limit, retain an explicit truncation marker.

Bound accumulated text, timers, and pending Matrix operations. Retain actively received message text in an in-memory cache. Evict clean cached text after an idle window or when a cache-size limit is reached, prioritizing least-recently-used entries. Never evict unpublished text or state needed by an in-flight publication. Cache expiry controls memory, not message completion or publication timing; it is separate from flush configuration.

### Matrix-backed cache recovery

Retain a lightweight index from `(sessionId, messageId)` to the original Matrix event IDs, latest successfully published replacement IDs, and continuation-part ordering. Evicting cached source text must not discard this identity mapping or mark the message permanently closed.

If a later chunk targets an uncached block, fetch its latest successfully published content from Matrix, recover the original Markdown source, append buffered new chunks, and publish an edit to the original block. Use `m.new_content` for replacement events, not their human-readable edit fallback body. Fetching only the original event is insufficient when replacements exist. Matrix has no standard append API: every edit sends complete replacement content.

Use the cache for normal streaming; fetch only on a cache miss, not for each flush. Serialize hydration, append, and publication for a block; chunks arriving during a fetch must be retained exactly once and in arrival order. Restore all required continuation parts without duplicating published text. Fetched encrypted content must pass through existing decryption and authorization handling; never substitute rendered HTML for source Markdown.

If published content is redacted, unavailable, or cannot be decrypted, retain pending text within resource limits and follow the existing delivery-failure policy. Do not silently create a duplicate block or overwrite an unrelated event. Emit bounded structured diagnostics for hydration failures and cache/index capacity exhaustion, without private text or credentials. Cache eviction itself is not a reason to drop a late chunk.

Define cache idle/size limits and index retention bounds before implementation. Once an identity mapping expires, recovery is no longer guaranteed; that boundary must be explicit and must not silently treat a known expired message as new.

### Failure and lifecycle handling

Keep existing Matrix delivery failure and backpressure policy. Diagnostics must not include private text or credentials. A timer or send callback from an obsolete session must not publish into its replacement.

On reset, deletion, disconnect, or shutdown, cancel timers and retire rendering state according to the existing lifecycle policy. Previously sent Matrix messages remain. No cross-restart buffer recovery is promised: persisted room/thread routing remains intact, but a restart must not replay session history as new unsolicited output. Any unrecoverable buffered delivery must be observable rather than reported as successful.

### Compatibility

For messages with IDs, the new path is the sole owner of assistant-text publication. It must not coexist with a second prompt-final renderer that duplicates output.

ACP permits missing message IDs. Preserve the existing prompt-scoped behavior for ID-less chunks during a solicited prompt. ID-less unsolicited text cannot be reliably grouped and is outside this feature's adapter contract; emit a bounded diagnostic instead of guessing an ID or a destination. Do not merge ID-less chunks into an identified block.

Cache recovery within a running bridge requires the message-to-Matrix index, not persistent source-text storage. Cross-restart index recovery is not required by this proposal. If the implementation persists the index, it must define migration, retention, and stale-session invalidation before changing the stored schema.

## Verification

- An unsolicited message received after a prompt completes is displayed in its mapped room/thread without any new prompt request or response.
- Solicited and unsolicited chunks with the same identity follow identical append, buffering, send, and edit behavior.
- Repeated IDs append to one block; distinct IDs create separate blocks. The same ID in two sessions remains isolated.
- A quiet period flushes the last chunk without further input. A later chunk updates that block rather than duplicating it.
- A message-ID transition flushes preceding text before the new block is published; a late chunk for the earlier ID still updates its original block.
- Size and maximum-interval triggers deliver continuously streamed text; deterministic-clock tests verify bounded call counts and timer cleanup.
- Slow Matrix requests coalesce edits, preserve ordering, and cannot overwrite newer content with stale snapshots.
- Prompt completion produces neither duplicate text nor a spurious empty response after streamed publication. It does not wait for text-drain silence or a 30-second cap; later chunks remain displayable.
- Idle and size-based cache eviction remove only clean source text, retaining message-to-event identity. A later chunk hydrates the latest published Markdown from Matrix and edits the original block.
- Cache hits require no Matrix read. Hydration covers prior replacements, encrypted messages, continuation parts, chunks arriving during the fetch, and concurrent flush triggers without lost or duplicated text.
- Redacted, unavailable, and undecryptable history produces bounded diagnostics and explicit delivery failure, not duplicate messages. Cache limits and flush settings control independent resources.
- Markdown split across chunks renders safely throughout; long messages respect encoded size limits and preserve text up to explicit output caps.
- Unknown/stale sessions and loading-history updates publish nothing. Reset, shutdown, retention limits, and delivery failures leave no orphan timers or cross-session sends.
- ID-less prompted output retains existing behavior; ID-less unsolicited output produces bounded diagnostics, not guessed grouping.

## Open questions

- Choose configuration names, defaults, and bounds for size, quiet-period, and maximum-interval flushing.
- Choose cache idle-window and size limits, plus message-index retention bounds. Clean text is evicted by idle age or cache pressure and rehydrated from Matrix; identity-expiration behavior must remain explicit.
- Specify how existing thought/tool activity interleaves with buffered assistant blocks without changing its presentation contract.

## References

- [ACP prompt turns](https://agentclientprotocol.com/protocol/prompt-turn)
- [ACP schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/schema.json): `ContentChunk.messageId`.
- [Thread-scoped agent sessions](thread-scoped-agent-sessions.md)
