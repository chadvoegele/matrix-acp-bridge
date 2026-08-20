# Incident: Matrix history replay after bridge restart

Date: 2026-08-19

Status: Resolved by normal initial-sync completed-ID recovery.

## Summary

After the bridge encountered a fatal Matrix transport error, Docker restarted it. On startup, the bridge loaded its persisted Matrix sync cursor, but the actual matrix-js-sdk request did not use that cursor. The SDK made a new initial `/sync` request without `since` and returned recent room history.

The bridge incorrectly admitted those history events as restart catch-up events. It submitted old Matrix prompts to ACP again, which produced new responses. The messages were not ACP transcript replay, and Synapse did not restart.

The persisted state contained a cursor, but not an unbounded processed-event log. Completed event IDs had already been removed from the pending recovery ledger.

## Impact

Previously handled Matrix events were submitted to fresh, reset, or restored ACP sessions again, producing new agent responses and repeated side effects.

The apparent duplicate user prompts were old Matrix events, not new messages sent by the user at restart time.

## Timeline

All times below are UTC unless noted otherwise.

### Before the incident

1. The bridge processed the original Matrix prompts and advanced its durable cursor.
2. The state file retained the latest opaque `/sync` cursor and room/session mappings.
3. Completed recovery batches had been removed, so the state file did not retain all previously processed event IDs.

### 2026-08-19

1. **23:47:24.754** — The bridge logged a fatal Matrix transport failure and began shutdown.
2. **23:47:25–23:47:27** — Docker Compose restarted the bridge because the service uses `restart: on-failure`. One startup attempt failed; the next continued successfully.
3. **Startup** — The bridge opened `bridge-state.json`, found a saved cursor, and logged that the cursor was loaded.
4. **First Matrix sync after restart** — The bridge/SDK made `/sync` without the saved `since` cursor. Synapse returned an initial sync containing recent room events. The request included a cache-buster rather than the persisted cursor.
5. **Catch-up processing** — The bridge selected seven old control and prompt events. Because the adapter had a saved-cursor value in memory, it classified the returned events as incremental catch-up rather than initial history.
6. **ACP processing** — The old events reached ACP. A replayed reset control created a fresh session, and ACP generated responses as new output.
7. **Afterward** — The SDK began using the new `next_batch` token returned by the no-`since` sync. That token was not the cursor saved before the restart.

Synapse containers were not restarted. They had been running since 2026-07-27 with zero restarts. Synapse logs showed normal sync traffic and client disconnects, but no Synapse process or container restart.

## Five whys

### 1. Why did old prompts produce new ACP responses?

The bridge submitted old Matrix timeline events to ACP during restart catch-up.

### 2. Why were old timeline events returned as catch-up?

The first post-restart `/sync` request was an initial sync without `since`, so Synapse returned recent room history. The bridge admitted those events instead of suppressing them as initial history.

### 3. Why did the first request omit `since` even though a cursor was saved?

The bridge called its wrapper with `startClient({ since: cursor })`, but the default client factory discarded that option before calling the real SDK:

```ts
client.startClient()
```

The bridge also called `store.setSyncToken(cursor)`. In matrix-js-sdk 42, that sets the current loop token but does not populate `getSavedSyncToken()`, which the SDK uses to choose the first request. The default in-memory store returned `null`, so the SDK chose initial sync.

### 4. Why did the adapter accept the initial-sync history?

The adapter treated events as live when `#since` was defined. Its in-memory bridge cursor therefore overrode the SDK’s actual request mode. The global SDK event callback also does not carry the timeline `liveEvent: false` marker used by the timeline callback.

### 5. Why was this shipped?

The tests verified the bridge abstraction with fake clients whose `startClient({ since })` honored the option. The default-factory test covered `whoami`, not a real sync request. The normal restart E2E test checked that the offline event was processed once but did not assert that all previous prompts were absent. The stronger live early-cursor test was a separate manual entry point, not part of the normal check suite.

The underlying failure was an untested contract mismatch between the bridge abstraction and the pinned matrix-js-sdk startup API.

## Room asymmetry: why visible replay appeared only in one room

The cursor failure was account-wide, not room-specific. One Matrix `/sync` request covered both configured rooms. The difference was which room events were returned, admitted, completed by ACP, and sent back to Matrix.

The investigation shows that room A was affected internally:

- At **23:47:28**, the bridge reported four self-authored events from room A as rejected `self-event` events. This confirms that its timeline was present in the no-`since` response.
- Its persisted session was loaded at **23:47:30.033**.
- That session then recorded at **23:47:30.046** the same prompt it had processed originally at **21:47:18.308**. The prompt was therefore replayed into room A's ACP session even though no response was observed in Matrix.
- The session did not record an assistant response. The bridge's ACP transport fatal occurred at **00:18:00.038**, almost exactly 30 minutes and 30 seconds after the replayed prompt. This was a second failure after the original Matrix failure, not a delay before room B's replay: room B produced responses between **23:47:33** and **23:47:49** while room A's turn remained unresolved.

The deployed defaults were `max_turn_seconds = 1800` and `shutdown_grace_seconds = 30`, so the bridge almost certainly hit room A's per-turn deadline, requested ACP cancellation, waited through the cancellation grace period, and then failed closed when the prompt did not settle. The timeout was per ACP turn, not a global Matrix or bridge startup timeout. The default prompt semaphore allowed multiple turns, so room B could complete while room A remained stuck. Room A also restored an existing session with `session/load`; a replayed reset control created a fresh session for room B. The available logs establish the bridge-side timeout, but not why the ACP/model request stopped producing output. Concurrent prompts or a restored-session/ACP interaction may have contributed, but neither is proven.

The room A `self-event` diagnostics do not mean its user prompts were rejected. They refer only to old outbound messages from the bridge account. The configured authorizer intentionally rejects the bridge's own sender before checking `allowed_senders` to prevent response feedback loops. The replayed prompt came from an authorized sender, passed that check, and reached ACP.

Room B produced visible output because its replayed work completed quickly:

- A reset control was processed and created a fresh session.
- Two replayed prompts reached that session at **23:47:33–23:47:36**.
- ACP completed those turns by **23:47:49**, and the bridge sent the resulting Matrix responses.

The rooms also had different recent histories. Room B had a short history, so its old user events were in the SDK's bounded initial-sync timeline. Room A had a much longer history, so only its most recent events could be returned; older prompts were outside that window. One room A prompt was recent enough to be returned, but its ACP turn was interrupted before producing visible output.

Both rooms used the same ACP working directory and transport but had separate persisted ACP session IDs. Room B's reset caused a new session, while room A continued its existing session. Thus, the lack of a visible room A response does not show that it avoided the cursor bug; it shows that replay admission and visible response delivery were separate stages.

## Possible reproduction

This reproduction requires a plaintext Matrix room, a bridge account, a sender account, and an ACP endpoint that exposes `session/prompt` requests.

1. Build and run the bridge version containing the bug with matrix-js-sdk 42.0.0.
2. Start with an empty bridge state directory.
3. Start the bridge and wait for `startup-ready`.
4. Send several unique prompts, including a prompt that is easy to identify, for example:

   ```text
   Reply with exactly REPLAY_TEST_ONE.
   ```

5. Wait for the response and confirm that the bridge state has a committed cursor and no pending recovery batches.
6. Send no further messages.
7. Stop or kill the bridge while leaving Synapse running. A process restart is sufficient; a Synapse restart is not needed.
8. Start the bridge again with the same state directory.
9. Inspect the Synapse access log or a request proxy. The first bridge `/sync` request will have no `since` parameter and will use initial-sync behavior.
10. Inspect ACP traffic. The old prompt may appear again as a new `session/prompt`, and ACP may generate another response.
11. Compare Matrix room history. There should be only the original sender event; the new event at restart time is the bridge/ACP response, not a new sender prompt.
12. Inspect bridge diagnostics. They will show a saved cursor loaded, followed by catch-up processing, despite the first HTTP request not using that cursor.

### Expected behavior after the fix

Every process start uses the SDK's normal initial sync with the configured
timeline limit. On the first run, eligible history is committed as a
completed-ID baseline and is not sent to ACP. On later starts, IDs already in
that ledger are suppressed; unseen eligible IDs are bounded by event age,
per-room admission count, and the ordinary ACP queue capacity. A terminal
completion is persisted before its Matrix response, while an interrupted turn
remains eligible for retry.

## Resolution

The bridge now uses schema-v12 state containing only the initialized marker,
ACP session mappings, and bounded per-room completed event IDs. The SDK's
normal initial-sync timeline is the recovery input, so the adapter cannot
misclassify an initial response as cursor-based catch-up. The restart,
plaintext, encrypted, and required `npm run test:recovery` harnesses assert
that completed IDs are not submitted to ACP again and that state contains no
legacy cursor fields. Older state is intentionally reset by the operator; no
migration code was added.
