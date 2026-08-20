+++
status = "final"
created = 2026-08-20
last_update = 2026-08-20
+++

# Cursor-aware Matrix SDK store for restart recovery

## Purpose

Make Matrix restart recovery use the bridge's persisted `/sync` cursor without modifying matrix-js-sdk or patching `node_modules`. This fixes the history replay described in [Incident: Matrix history replay after bridge restart](incident-2026-08-19-matrix-history-replay.md).

The bridge must supply the SDK's supported `IStore` integration through `createClient({ store })`. The store must expose the persisted cursor through `getSavedSyncToken()` for the next SDK startup while returning no cached `/sync` response.

## Context

The bridge persists its recovery cursor in `bridge-state.json`. It currently calls `setSyncToken(cursor)` and `startClient({ since: cursor })` through its local abstraction. matrix-js-sdk 42 does not support `since` in `startClient` options. Its first request instead uses `store.getSavedSyncToken()`:

- a non-null saved token produces `/sync?since=<token>`;
- a null token produces an initial `/sync` request without `since`;
- `getSavedSync()` supplies an optional cached response that the SDK may process before the HTTP response.

The default in-memory store returns no saved sync token. Consequently, the bridge's saved cursor was loaded but not used by the actual HTTP request.

The bridge state remains the recovery authority. The SDK store integration only presents the current bridge cursor to SDK startup and maintains the SDK's in-process sync state. It must not become a second durable recovery ledger.

## Goals

- Make the first SDK `/sync` request after a restart use the bridge cursor.
- Preserve bounded restart catch-up and ACP session recovery.
- Prevent cached or initial room history from reaching ACP as catch-up.
- Use only matrix-js-sdk's supported client-store boundary.
- Avoid persisting Matrix event bodies, ciphertext, ACP content, or access tokens in the SDK store integration.
- Preserve the existing invalid-cursor and state-failure behavior.
- Cover the real SDK startup path with hermetic tests.

## Non-goals

- Modify matrix-js-sdk source or files under `node_modules`.
- Implement a second durable event log in the SDK store.
- Replace the bridge's atomic recovery state or per-event completion ledger.
- Change ACP session, authorization, room, response, or encryption policy.
- Fall back to an unbounded initial sync when a saved cursor is rejected.
- Provide distributed exactly-once delivery between ACP and Matrix.

## Specification

### Store construction

The production Matrix client must be created with a bridge-owned implementation of the SDK's supported `IStore` contract:

```ts
createClient({
  ...clientOptions,
  store: bridgeStore,
});
```

The bridge store must subclass matrix-js-sdk's exported `MemoryStore`. It must inherit ordinary room, event, filter, user, and in-process token behavior, inherit `getSavedSync()` returning `null`, and override `getSavedSyncToken()` to return the current value of `getSyncToken()`. The implementation must use the public store contract rather than changing SDK classes or replacing SDK methods after client construction.

The Matrix client is created before the bridge opens `bridge-state.json`. Immediately before SDK startup, the adapter must seed a checkpoint cursor through the store's ordinary `setSyncToken(cursor)` method. It must then call the real SDK's `startClient()` without a `since` option. With no checkpoint, the adapter must leave the fresh store's token as `null`.

The bridge store must record whether `getSavedSyncToken()` was consulted and the value it returned for the current startup. Before admitting the first batch, the adapter must verify that the method was consulted and returned the expected checkpoint cursor, or `null` when no checkpoint exists. A mismatch is a startup failure.

### Cursor behavior

When a bridge checkpoint exists:

1. The adapter resets the store's startup-observation state.
2. The adapter calls `setSyncToken(cursor)` with the checkpoint cursor.
3. The SDK calls `getSavedSyncToken()` during `startClient()`.
4. `getSavedSyncToken()` returns `getSyncToken()`, which is the checkpoint cursor, and records the lookup and returned value.
5. The SDK issues its first HTTP request with `since=<cursor>`.
6. Before admitting the first batch, the adapter verifies the recorded lookup and value.
7. The SDK updates the ordinary in-process sync token from the response's `next_batch` through `setSyncToken()`.

When no bridge checkpoint exists, the fresh store's `getSyncToken()` and `getSavedSyncToken()` return `null`, and the SDK performs its normal initial sync. Before admitting the first batch, the adapter verifies that the saved-token lookup returned `null`.

The checkpoint must remain available through `getSyncToken()` until a successful response replaces it. If the first request fails transiently, every SDK retry must continue using `since=<cursor>` rather than falling back to an initial sync. Reconnects and later sync requests use the latest token maintained by the SDK through `getSyncToken()` and `setSyncToken()`.

The bridge's `MatrixSyncCoordinator` remains responsible for registering response boundaries, completing event IDs, advancing the recovery cursor, and durably committing state. The SDK store must not commit bridge recovery state independently.

### Cached sync behavior

`getSavedSync()` must return `null` for this integration unless a future design explicitly provides a compatible cached response. The bridge must not ask the SDK to process a locally cached `/sync` response during startup.

This ensures that a restart with a bridge cursor has one source of inbound timeline events: the cursor-based HTTP response. It also prevents cached event bodies from bypassing the bridge's cursor and recovery ledger.

### Startup flows

#### First startup

With no checkpoint:

1. The adapter resets the store's startup-observation state and leaves the sync token unset.
2. The SDK calls `getSavedSyncToken()` and receives `null`.
3. The SDK performs initial `/sync` without `since`.
4. The adapter verifies the recorded saved-token lookup before first-batch admission.
5. The adapter suppresses initial-history events.
6. The bridge validates identity and configured rooms.
7. The coordinator commits the returned `next_batch` as the initial checkpoint.
8. Normal intake begins.

#### Restart startup

With a checkpoint:

1. The bridge loads and validates `bridge-state.json`.
2. The adapter resets startup-observation state and seeds the checkpoint through `setSyncToken()`.
3. The SDK performs `/sync?since=<checkpoint>`.
4. The adapter verifies that the recorded saved-token lookup returned the checkpoint before first-batch admission.
5. Only events returned after the checkpoint enter the first incremental batch.
6. The coordinator applies catch-up age and count limits, registers selected event IDs, and dispatches them.
7. The coordinator advances the durable cursor after terminal completion.
8. Normal live intake begins.

If Synapse rejects the cursor, startup must fail with recovery guidance. The bridge must not perform an initial sync as an automatic fallback.

### Failure handling

A missing or unusable cursor-aware store is a startup failure in production. The bridge must not silently use the SDK's default in-memory store when restart recovery is enabled.

A store failure must not cause the bridge to claim that a cursor was used. The bridge must fail before opening ACP event intake when it cannot install or read the startup cursor contract. It must also fail before admitting the first batch if `getSavedSyncToken()` was not consulted or returned a value other than the expected checkpoint cursor.

A transient failure of the first `/sync` request must retain the checkpoint in `getSyncToken()`. No retry may omit `since` before a successful response supplies a replacement `next_batch`.

State-file failures retain their existing fatal behavior. The store integration must not expose state contents or raw SDK errors in diagnostics.

### Security and privacy

The store integration must retain only the opaque cursor and SDK data required for the current process. It must not persist or log:

- Matrix access tokens;
- event bodies or ciphertext;
- sender or room message content;
- ACP prompts or responses; or
- session transcripts.

The existing private state-file permissions and identity binding remain authoritative for the durable cursor.

## Rationale

The SDK's supported startup path is store-driven, not option-driven. Passing an unsupported `since` field to `startClient()` cannot affect the request. Presenting the bridge cursor through `getSavedSyncToken()` uses the API the SDK actually consults.

Returning `null` from `getSavedSync()` is intentional. The bridge needs the SDK to make one cursor-based HTTP request, not to restore an SDK-owned response cache. This keeps the bridge's cursor and recovery ledger as the only durable recovery boundary.

## Compatibility and migration

Existing schema-v11 bridge state remains valid. No state migration is required.

The production adapter must stop depending on the real SDK accepting `startClient({ since })`. It must seed the cursor through the cursor-aware `MemoryStore` subclass and call `startClient()` without a `since` option. The bridge-facing `MatrixSdkClientLike` type and test fakes must model the supported store-driven startup contract accurately.

A deployment must restart with the same state directory. If an operator intentionally deletes the state file, the bridge performs a normal initial sync and suppresses its history as before.

## Verification

### Unit and integration tests

Tests must verify the real matrix-js-sdk startup behavior with mocked HTTP:

1. With no checkpoint, the first request omits `since` and initial events are suppressed.
2. With checkpoint `S1`, the first request contains `since=S1`.
3. `getSavedSync()` returns no cached response.
4. Before first-batch admission, the adapter verifies that `getSavedSyncToken()` was consulted and returned the expected cursor, or `null` on first startup.
5. After a successful first response, later requests use the SDK's returned `next_batch`.
6. A transient first-request failure retries with `since=S1` on every attempt and never makes an initial request.
7. An invalid saved cursor fails startup and never falls back to initial sync.
8. A missing saved-token lookup or a returned-token mismatch fails before any event reaches ACP.
9. The adapter emits the cursor-based first response as incremental catch-up.
10. Previously completed event IDs do not reach ACP again after restart.

The tests must exercise the production client factory and store implementation, not only an injected fake whose `startClient({ since })` accepts unsupported options.

### End-to-end tests

The restart E2E suite must verify:

- an event sent while the bridge is stopped is processed once after restart;
- a prompt completed before restart is not submitted again;
- the first post-restart Matrix request and every pre-success retry use the saved cursor;
- the saved-token startup lookup is verified before first-batch admission;
- no startup cache response is processed; and
- plaintext and required-encryption modes retain their existing restart behavior.

The early-cursor replay scenario must run in CI or be included in the required recovery test command.

## References

- [Incident: Matrix history replay after bridge restart](incident-2026-08-19-matrix-history-replay.md)
- [Milestone 2 — restart continuity](m2-persistence.md)
- `src/matrix-client.ts`
- `src/bridge-state.ts`
- `src/sync-coordinator.ts`
