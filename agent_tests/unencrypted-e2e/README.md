# Unencrypted Matrix end-to-end test helpers

These test-only programs provision bridge and sender devices on two existing Matrix accounts. They send two plaintext exchanges across a bridge restart, verify both wire events are `m.room.message`, and assert that the completed first prompt is suppressed by normal initial-sync recovery.

Generated configuration and tokens live under ignored private paths.

The raw Matrix sender and plaintext wire assertions remain in this directory; shared provisioning, ACP lifecycle, cleanup, and shell orchestration live in [`../e2e-support/`](../e2e-support/). The documented commands below remain the supported entry points.

## Prerequisites

- Node.js in the range accepted by `package.json`;
- two existing Matrix accounts joined to one **unencrypted** room;
- password login enabled for both accounts; and
- an ACP command exposing one full-duplex ACP process on stdin/stdout.

The harness shares the encrypted test's account, password, homeserver, ACP, and working-directory variables. Only the room normally differs:

```sh
export E2E_HOMESERVER='https://matrix.example.org'
export UNENCRYPTED_E2E_ROOM_ID='!plaintext-room:matrix.example.org'
export E2E_BRIDGE_USER_ID='@bridge-test:matrix.example.org'
export E2E_SENDER_USER_ID='@sender-test:matrix.example.org'
export E2E_BRIDGE_PASSWORD='bridge-account-password'
export E2E_SENDER_PASSWORD='sender-account-password'
export E2E_ACP_CWD='/tmp'
export E2E_ACP_COMMAND='["docker","--host","ssh://server.example.org","exec","-i","pi-acp","socat","UNIX-CONNECT:/run/pi-acp/acp.sock","STDIO"]'
```

`E2E_ROOM_ID` is accepted when `UNENCRYPTED_E2E_ROOM_ID` is unset. This allows the same environment file used for the encrypted harness to be sourced, with only a room override. `E2E_ACP_COMMAND` is a JSON array, not a shell command.

Copy [`../.env.example`](../.env.example) to the repository-root ignored `.env`, replace its examples, and source it to configure both harnesses. Prefer retrieving passwords from a secret manager while sourcing `.env`, rather than writing passwords into it. Never commit passwords or tokens. Environment variables avoid password files but may remain visible to same-user or privileged processes, depending on the operating system.

## Run with automatic cleanup

Run the plaintext restart test:

```sh
agent_tests/unencrypted-e2e/test.sh
```

Run the exact `/reset` control test:

```sh
agent_tests/unencrypted-e2e/test-reset.sh
```

Run the required completed-ID recovery test:

```sh
npm run test:recovery
```

This command invokes `agent_tests/unencrypted-e2e/completed-id-recovery-test.sh`.

Each entry point installs dependencies, runs checks, provisions two devices, runs its exchanges, deletes test-created ACP sessions, revokes both devices, and removes local private state. Matrix room events remain.

The `/reset` test records both observed ACP session IDs in ignored private state. This lets cleanup delete the initial session even though reset removes its room mapping from `bridge-state.json`.

## Restart-persistence test

The stronger persistence entry point sends a memory turn, stops both bridge and
ACP proxy, sends a second Matrix event while they are down, and verifies that
normal initial-sync recovery loads the original ACP session and returns the
remembered value exactly:

```sh
agent_tests/unencrypted-e2e/restart-persistence-test.sh
```

The real ACP endpoint must advertise `loadSession`. The test observes the ACP
NDJSON stream to assert `session/new`, `session/load`, and `session/prompt`
counts and ordering without changing protocol frames. It checks that the
completed-ID ledger suppresses the prior prompt, that the offline prompt is
admitted once, and that state remains bounded and free of legacy fields. See
[`../test_restart_persistence/README.md`](../test_restart_persistence/README.md)
for the full contract.

## Completed-ID recovery test

The recovery test establishes a normal initial-sync baseline, completes one
prompt, sends another while the bridge is stopped, and holds that unseen event
before ACP. It then interrupts the process and restarts normally. The
completed ID is suppressed, while the incomplete ID is retried once and
completed before its Matrix response. The final state is bounded and contains
only structural event IDs:

```sh
agent_tests/unencrypted-e2e/completed-id-recovery-test.sh
```

See [`../test_completed_id_recovery/README.md`](../test_completed_id_recovery/README.md)
for the full contract.

## Retained setup for debugging

```sh
agent_tests/unencrypted-e2e/setup.sh
node agent_tests/unencrypted-e2e/run.mjs
```

Private state is recorded in:

```text
agent_tests/unencrypted-e2e/environment.json
agent_tests/unencrypted-e2e/private/
```

Do not run setup again while that environment exists.

## Manual cleanup

```sh
node agent_tests/unencrypted-e2e/cleanup.mjs
```

Cleanup preserves local state if ACP deletion or Matrix device revocation fails.
