# `/reset` Message Test

## Conditions

1. The configured room is unencrypted and begins with empty bridge state.
2. The allowed Matrix sender sends all three top-level plaintext messages.
3. The ACP endpoint supports `session/delete` so both test-created sessions can be cleaned up.

## Automated test

The harness in [`../unencrypted-e2e/`](../unencrypted-e2e/README.md) provisions temporary devices, taps the ACP protocol in both directions, runs the exchanges, and cleans up. Generated credentials, bridge state, and the retained session-ID list stay in ignored private paths.

```sh
agent_tests/unencrypted-e2e/test-reset.sh
```

The test performs this sequence:

1. Send a unique ordinary prompt and require its exact response.
2. Record the resulting ACP session ID.
3. Send exact `/reset` and require exactly `Agent session reset.`.
4. Send a second unique ordinary prompt and require its exact response.
5. Confirm the follow-up uses a different newly created ACP session.
6. Stop cleanly and delete both ACP sessions and both Matrix test devices.

## Assertions

- Each ordinary prompt reaches ACP exactly once, and `/reset` never reaches `session/prompt`.
- Exactly two `session/new` requests occur; no `session/load` or bridge-issued `session/delete` occurs.
- The prompt session IDs match their respective `session/new` results and differ from each other.
- When ACP advertises `loadSession`, `bridge-state.json` maps the room to the second session after the follow-up.
- All three prompts and their responses are top-level plaintext `m.room.message` events.
- Cleanup reads the ignored retained-ID list as well as the final bridge mapping, ensuring reset cannot hide the first session from deletion.

Cleanup preserves private local state if ACP deletion or Matrix device revocation fails, allowing safe diagnosis and retry.
