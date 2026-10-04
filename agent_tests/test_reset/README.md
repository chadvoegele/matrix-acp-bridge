# `/reset` Message Test

Follow the shared [authentication, ownership and recovery contract](../e2e-support/README.md).
Token mode uses designated reusable test devices and their original persistent
state without `/login`; cleanup preserves tokens, devices, crypto and delivery
ledgers while deleting owned ACP sessions. Fresh-device login/bootstrap steps
below apply only to disposable password mode. Hold the shared live lock for
manual operations; shell test entry points hold it automatically.

## Conditions

1. The configured room is unencrypted and begins without active ACP mappings; reusable token profiles retain their initialized delivery ledger.
2. The allowed Matrix sender sends all three top-level plaintext messages.
3. The ACP endpoint supports `session/delete` so both test-created sessions can be cleaned up.

## Automated test

The harness in [`../unencrypted-e2e/`](../unencrypted-e2e/README.md) prepares reusable token devices or new owned password devices, taps the ACP protocol in both directions, runs the exchanges, and cleans up. Generated credentials, bridge state, and the retained session-ID list stay in ignored private paths.

```sh
agent_tests/unencrypted-e2e/test-reset.sh
```

The test performs this sequence:

1. Send a unique ordinary prompt and require its exact response.
2. Record the resulting ACP session ID.
3. Send exact `/reset` and require exactly `Agent session reset.`.
4. Send a second unique ordinary prompt and require its exact response.
5. Confirm the follow-up uses a different newly created ACP session.
6. Stop cleanly and delete both ACP sessions; revoke only owned disposable Matrix devices.

## Assertions

- Each ordinary prompt reaches ACP exactly once, and `/reset` never reaches `session/prompt`.
- Exactly two `session/new` requests occur; no `session/load` or bridge-issued `session/delete` occurs.
- The prompt session IDs match their respective `session/new` results and differ from each other.
- When ACP advertises `loadSession`, `bridge-state.json` maps the room to the second session after the follow-up.
- All three prompts and their responses are top-level plaintext `m.room.message` events.
- Cleanup reads the ignored retained-ID list as well as the final bridge mapping, ensuring reset cannot hide the first session from deletion.

Cleanup preserves private local state if ACP deletion or Matrix device revocation fails, allowing safe diagnosis and retry.
