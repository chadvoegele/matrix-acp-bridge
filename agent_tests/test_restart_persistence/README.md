# Restart Persistence Matrix E2E Test

## Run

Configure the live environment described in
[`../unencrypted-e2e/README.md`](../unencrypted-e2e/README.md), then run:

```sh
agent_tests/unencrypted-e2e/restart-persistence-test.sh
```

The entry point runs `npm run check`, provisions fresh Matrix devices and an
empty private bridge state directory, executes the test, deletes the created
ACP session, revokes both devices, and removes local private state. Cleanup is
also attempted after failures and ordinary signals. If remote cleanup fails,
private state is retained so cleanup can be retried safely.

## Flow and assertions

1. Start the ACP proxy and bridge and wait for `startup-ready`.
2. Send a unique value in a memory instruction and require a deterministic
   acknowledgement that does not echo the value.
3. Assert exactly one `session/new`, one prompt, initialized schema-v12 state,
   a bounded completed-ID ledger, and a room mapping to the created session.
   Fail clearly unless ACP advertises `loadSession`.
4. Gracefully stop the bridge and ACP proxy, waiting for state flush and lock
   release.
5. Send a plaintext Matrix prompt while both are stopped. The prompt refers to
   the remembered value without containing it and is correlated by its unique
   event ID and the sender's observation position.
6. Restart with the same configuration and private state. The SDK performs a
   normal initial sync; watch for the exact remembered value.
7. Assert `session/load` precedes the recovered `session/prompt`, both use the
   original session ID, no replacement `session/new` occurs, the offline event
   reaches ACP exactly once, and the completed first event reaches ACP zero
   times during restart.
8. Assert Matrix receives exactly one matching response and both prompt and
   response are top-level plaintext `m.room.message` events.
9. Assert the room mapping remains unchanged, both event IDs are in bounded
   completed-ID state, no legacy cursor or pending-batch fields exist, and
   diagnostics contain normal ledger/startup-recovery events without state,
   lock, or ACP protocol failures.

The test uses graceful shutdown and makes no claim about ambiguous crash
boundaries or durable recovery of an interrupted response.
