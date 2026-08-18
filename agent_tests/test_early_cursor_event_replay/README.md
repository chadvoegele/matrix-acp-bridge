# Early-Cursor Event Replay Matrix E2E Test

## Run

Configure the live plaintext environment described in
[`../unencrypted-e2e/README.md`](../unencrypted-e2e/README.md), then run:

```sh
agent_tests/unencrypted-e2e/early-cursor-event-replay-test.sh
```

The entry point runs `npm run check`, provisions fresh Matrix devices and an
empty private bridge state directory, executes the test, deletes the created
ACP session, revokes both devices, and removes private local state. Cleanup is
attempted after failures and signals.

## Flow

1. Start and gracefully stop the bridge to establish global processed cursor
   X.
2. Send two ordered plaintext events in one room while the bridge is stopped.
3. Restart from X through a test ACP gate. Allow the first prompt to reach ACP
   and complete, but hold the second prompt before it reaches ACP.
4. Verify the first event reached ACP exactly once and persisted recovery state
   identifies the second event as the room's next pending event.
5. Kill the bridge, then read the Matrix timeline with the bridge token from
   the original bridge cursor X. Reconstruct the full current eligible sender
   sequence and use the held event as its completion boundary: every ID before
   it is in one ordered room ledger's completed-ID prefix, while it and all
   later IDs remain pending after cursor X. This normalization makes the test
   deterministic when the homeserver splits sends across sync responses or
   shared-room traffic appears before the generated IDs.
6. Restart from X without the gate. Matrix returns the early events again.
7. Send a live probe and require its exact response. Because the probe follows
   recovered room work in FIFO order, its completion proves any replay of the
   first event would already have reached ACP.
8. Assert the completed first event never reaches ACP again and the unfinished
   event reaches ACP at most once. It may instead be resolved by the existing
   catch-up omission policy if the homeserver returns additional newer work.
9. Verify the persisted ACP session is loaded, the global processed cursor
   advances, and the covered per-room ledger is removed.

## Required semantics

- ACP must advertise `loadSession`.
- The gate drops the second `session/prompt` frame before the agent receives it;
  it never modifies a protocol frame that is forwarded.
- The first event receives exactly one response before the crash.
- Fixture normalization occurs only while the bridge process is stopped and
  rewrites IDs, cursors, completed IDs, and the checkpoint timestamp; the
  read-only Matrix query uses the bridge's original cursor, retains only event
  IDs, and never writes or prints Matrix bodies, ACP content, or credentials.
- Credentials remain in ignored private files.
