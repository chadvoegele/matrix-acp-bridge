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

Continuous low-volume output must also flush within a configured maximum interval from the first unflushed chunk, so repeatedly resetting the quiet timer cannot postpone delivery indefinitely. Expose three publication controls under `[matrix]`:

| Setting                      | Default | Inclusive bounds |
| ---------------------------- | ------: | ---------------: |
| `agent_text_flush_bytes`     |   2,048 |       256–16,384 |
| `agent_text_quiet_ms`        |     750 |        100–5,000 |
| `agent_text_max_interval_ms` |   2,000 |       250–10,000 |

Require integer values and `agent_text_quiet_ms <= agent_text_max_interval_ms`. Count new unpublished UTF-8 bytes, not total block size. A message-ID transition is an unconditional flush trigger, not another configuration setting. Interval pacing and coalescing must prevent repeated size-threshold crossings from bypassing Matrix rate control.

Keep `max_output_bytes` and `max_matrix_message_bytes` as output/event-size limits, not publication triggers. Remove prompt-scoped text draining, including `QUIET_DRAIN_MS` and `STREAMING_DRAIN_CAP_MS`, from the identified-message path. The quiet-period setting replaces the former text-drain timing role; there is no post-prompt drain deadline. Complete prompt bookkeeping when its ACP response arrives, independently of buffered text publication. These changes must not introduce another equivalent drain configuration.

A quiet timer must fire without another incoming update. Flushing does not finalize a block: later chunks with the same ID continue updating it. A message-ID transition starts another block, not an irreversible close of the previous block. Neither mechanism asserts that an unsolicited turn has ended.

Serialize Matrix operations per conversation and coalesce pending updates to their latest accumulated text. A slow send must not cause concurrent edits or stale edits to overwrite newer text. Flush triggers request delivery; they must not bypass existing transport limits or retry ownership.

### Thought and tool interleaving

Use one ordered outbound queue per conversation for text and activity. Preserve the existing activity presentation contract:

- A new `tool_call` or nonempty thought schedules preceding buffered assistant text before publishing the activity.
- A whitespace-only thought does not trigger a text flush.
- A `tool_call_update` updates its existing activity block without creating a text boundary.
- The first nonempty assistant chunk collapses live activity batches as before.
- A different assistant message ID schedules preceding buffered text before the new block is published.

These are publication boundaries, not permanent message closure. A later chunk for an earlier ID edits its original block without moving it or creating another activity boundary. Existing activity batching, initial expanded publication, disclosure, and tool-status rules remain unchanged. Preserve ordering through the outbound queue rather than blocking ACP intake on a Matrix request.

### Rendering and resource limits

Render accumulated Markdown through the existing safe converter on each publication. Preserve the original text in the plain-text body. Incomplete Markdown may render differently as later chunks arrive; never expose unsafe HTML while waiting for completion.

Apply existing encoded Matrix event-size and output limits. A logical block may span bounded continuation events; retain their association with the same message ID. Already-published parts must not be duplicated during splitting or edits. If content is truncated by an output limit, retain an explicit truncation marker.

Bound accumulated text, timers, and pending Matrix operations. Retain actively received message text in an in-memory cache with these limits:

- 128 cached blocks per session.
- 30 minutes without chunks before idle eviction.
- 4 MiB of cached source text per session and 32 MiB globally, measured in UTF-8 bytes.

Evict clean cached text after the idle window or when any cache limit is reached, prioritizing least-recently-used entries. Never evict unpublished text or state needed by an in-flight publication. Cache expiry controls memory, not message completion or publication timing; it is separate from flush configuration.

### Matrix-backed cache recovery

Retain a lightweight index from `(sessionId, messageId)` to the original Matrix event IDs, latest successfully published replacement IDs, and continuation-part ordering. Evicting cached source text must not discard this identity mapping or mark the message permanently closed.

If a later chunk targets an uncached block, fetch its latest successfully published content from Matrix, recover the original Markdown source, append buffered new chunks, and publish an edit to the original block. Use `m.new_content` for replacement events, not their human-readable edit fallback body. Fetching only the original event is insufficient when replacements exist. Matrix has no standard append API: every edit sends complete replacement content.

Use the cache for normal streaming; fetch only on a cache miss, not for each flush. Serialize hydration, append, and publication for a block; chunks arriving during a fetch must be retained exactly once and in arrival order. Restore all required continuation parts without duplicating published text. Fetched encrypted content must pass through existing decryption and authorization handling; never substitute rendered HTML for source Markdown.

If published content is redacted, unavailable, or cannot be decrypted, retain pending text within resource limits and follow the existing delivery-failure policy. Do not silently create a duplicate block or overwrite an unrelated event. Emit bounded structured diagnostics for hydration failures and cache/index capacity exhaustion, without private text or credentials. Cache eviction itself is not a reason to drop a late chunk.

Keep the identity index in memory for each loaded session, independently of source-text eviction. Cap it at 10,000 logical message mappings per session and 100,000 globally. At capacity, do not evict existing mappings to admit new IDs: reject new blocks through the existing delivery-failure policy with a rate-limited capacity diagnostic. Existing indexed blocks remain recoverable. Reset, deletion, session retirement, and bridge restart release the corresponding mappings.

Operators must receive structured, rate-limited diagnostics for hydration failures, index capacity exhaustion, and updates to retired sessions, with suppressed-occurrence counts. Expose counters for text-cache evictions, hydration failures, and capacity rejections. Diagnostics may identify the session/message but must not include message text. Cache eviction alone must not warn or drop chunks.

### Failure and lifecycle handling

Keep existing Matrix delivery failure and backpressure policy. Diagnostics must not include private text or credentials. A timer or send callback from an obsolete session must not publish into its replacement.

On reset, deletion, disconnect, or shutdown, cancel timers and retire rendering state according to the existing lifecycle policy. Previously sent Matrix messages remain. Persist neither cached source text nor message mappings across restart; persisted room/thread routing remains intact. If live chunks for a previously published agent message arrive after restart, create a new Matrix block from the newly received text. This continuation may use a new Matrix event even though the ACP message ID is unchanged; reconstructing its pre-restart prefix is not required. A restart must not replay session history as new unsolicited output. Any unrecoverable buffered delivery must be observable rather than reported as successful.

### Compatibility

For messages with IDs, the new path is the sole owner of assistant-text publication. It must not coexist with a second prompt-final renderer that duplicates output.

ACP permits missing message IDs. Preserve the existing prompt-scoped behavior for ID-less chunks during a solicited prompt. ID-less unsolicited text cannot be reliably grouped and is outside this feature's adapter contract; emit a bounded diagnostic instead of guessing an ID or a destination. Do not merge ID-less chunks into an identified block.

Cache recovery within a running bridge requires only the in-memory message-to-Matrix index. Do not persist that index or change the stored conversation schema. A new Matrix block for a continuing agent message after restart is accepted behavior.

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
- Cache eviction respects the block, idle, per-session byte, and global byte limits. Index capacity rejects new blocks observably without losing existing mappings; reset/retirement releases their capacity.
- Restart discards mappings. New live chunks for an earlier ACP message create a new Matrix block from those chunks, without history replay or reconstruction of the previous prefix.
- Text is queued before new tool/thought activity; whitespace-only thoughts and tool updates do not flush text. Existing activity expansion/collapse rules remain intact, including when chunks resume an earlier assistant block.
- Redacted, unavailable, and undecryptable history produces bounded diagnostics and explicit delivery failure, not duplicate messages. Cache limits and flush settings control independent resources.
- Markdown split across chunks renders safely throughout; long messages respect encoded size limits and preserve text up to explicit output caps.
- Unknown/stale sessions and loading-history updates publish nothing. Reset, shutdown, retention limits, and delivery failures leave no orphan timers or cross-session sends.
- ID-less prompted output retains existing behavior; ID-less unsolicited output produces bounded diagnostics, not guessed grouping.

## References

- [ACP prompt turns](https://agentclientprotocol.com/protocol/prompt-turn)
- [ACP schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/schema.json): `ContentChunk.messageId`.
- [Thread-scoped agent sessions](thread-scoped-agent-sessions.md)
