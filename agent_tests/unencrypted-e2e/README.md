# Unencrypted Matrix end-to-end test helpers

Read the shared [authentication, ownership and recovery contract](../e2e-support/README.md)
before running. Token mode is preferred for repeated suites: supplied test-device
tokens use their original persistent stores, with no password login. Cleanup
preserves reusable credentials, devices and crypto, and deletes owned ACP sessions.
Legacy password mode creates disposable devices. Shell test entry points hold
the shared live lock; manual sequences must hold it through cleanup.

These test-only programs provision bridge and sender devices on two existing Matrix accounts. They send two plaintext exchanges across a bridge restart, verify both wire events are `m.room.message`, check the first response's Matrix Markdown formatting, and assert that the completed first prompt is suppressed by normal initial-sync recovery.

Generated configuration and tokens live under ignored private paths.

The raw Matrix sender and plaintext wire assertions remain in this directory; shared provisioning, ACP lifecycle, cleanup, and shell orchestration live in [`../e2e-support/`](../e2e-support/). The documented commands below remain the supported entry points.

## Prerequisites

- Node.js in the range accepted by `package.json`;
- two existing Matrix accounts joined to one **unencrypted** room;
- either designated device-bound tokens with matching stores or password login enabled for both accounts; and
- an ACP command exposing one full-duplex ACP process on stdin/stdout.

The harness shares the encrypted test's account, password, homeserver, ACP, and working-directory variables. Only the room normally differs:

```sh
export E2E_HOMESERVER='https://matrix.example.org'
export UNENCRYPTED_E2E_ROOM_ID='!plaintext-room:matrix.example.org'
export E2E_BRIDGE_USER_ID='@bridge-test:matrix.example.org'
export E2E_SENDER_USER_ID='@sender-test:matrix.example.org'
export E2E_AUTH_MODE=password # legacy disposable-device example
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
agent_tests/unencrypted-e2e/completed-id-recovery-test.sh
```

Each entry point installs dependencies, runs checks, provisions two devices, runs its exchanges, deletes test-created ACP sessions, revokes only owned disposable devices, and removes run files; reusable stores remain. Matrix room events remain.

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

## Verbose ACP activity over plaintext Matrix

The opt-in scripted test uses the same two test accounts and plaintext room. It
replaces `E2E_ACP_COMMAND` for this invocation with a deterministic local ACP
peer, while preserving the existing `test.sh` entry point and its configured
real-agent command. It checks raw Matrix events, edits and `m.new_content`,
fallback text, HTML details, colors, output truncation, a ten-event rollover,
the agent-message boundary, and a late update to an archived batch:

```sh
agent_tests/unencrypted-e2e/test-activity.sh
```

Source an ignored environment file first, as above. The command provisions
fresh devices and deletes the scripted ACP session and local private state on
exit. Room events remain. It does not require a real ACP server.

For an optional real `pi-acp` metadata check, keep `E2E_ACP_COMMAND` set to
the real ACP endpoint. Set an ACP-visible scratch directory and a JSON command
that removes one file path passed as its final argument. For a local agent:

```sh
export E2E_REAL_SCRATCH_DIR=/tmp
export E2E_REAL_SCRATCH_CLEANUP_COMMAND='["rm","-f","--"]'
agent_tests/unencrypted-e2e/test-real-activity.sh
```

For a remote agent, supply a cleanup command that runs on that agent's host.
The runner generates a unique scratch filename, requests write, read, edit,
and bash activity, checks exact ACP fields and Matrix activity/edit events,
then runs the cleanup command even on failure. Agent tool choices vary, so it
prints `INCOMPLETE` with missing field names when a turn did not provide full
coverage. Device and session cleanup still run through the usual harness.

## Thread-scoped sessions

Thread tests are a separate suite: [thread-sessions](../thread-sessions/README.md).
This suite always uses room mode, including its senders and activity tests.
