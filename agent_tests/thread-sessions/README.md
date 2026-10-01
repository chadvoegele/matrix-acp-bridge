# Thread sessions

Separate live agent tests for `matrix.response_mode = "thread"`. The
`encrypted-e2e` and `unencrypted-e2e` suites remain room-mode tests.

## Run

Use dedicated test accounts and rooms. Source the settings in
[`../.env.example`](../.env.example): plaintext uses
`UNENCRYPTED_E2E_ROOM_ID` (or `E2E_ROOM_ID`); encrypted uses `E2E_ROOM_ID`.
The encrypted room must have encryption enabled. Both accounts must be joined.
`E2E_ACP_COMMAND` must connect to an ACP agent supporting session deletion.
Never use production accounts, device state, or room-suite environment files.

```sh
agent_tests/thread-sessions/plaintext-test.sh
agent_tests/thread-sessions/encrypted-test.sh
```

The plaintext scenario creates two independent roots concurrently, verifies
separate ACP sessions, restarts the bridge, and checks lazy loading of only the
requested thread. With `loadSession`, it resets one thread, restarts again,
checks the other thread retains its session, and checks the reset thread gets a
fresh session. Without `loadSession`, old follow-ups receive the unknown-session
response. Unknown roots must never create, load, or prompt an ACP session.

The encrypted scenario checks authenticated decrypted prompt/response relations,
`m.room.encrypted` wire types, and reuse of the same ACP session for a follow-up.
It does not exercise the plaintext scenario's restart/reset cases.

## Scripted activity

```sh
agent_tests/thread-sessions/plaintext-test-activity.sh
agent_tests/thread-sessions/encrypted-test-activity.sh
```

These replace `E2E_ACP_COMMAND` with the shared deterministic ACP peer. Shared
transport harnesses check thought/tool batches, eager text, archived updates,
and `m.replace` edits. Thread wrappers additionally require the prompt's root
and fallback target on originals and replacement `m.new_content`. Encrypted
checks use authenticated decrypted content and encrypted wire events; delayed
old history is excluded by the test prompt's server timestamp, not its root.

## Setup and cleanup

Each test wrapper runs shared setup (dependency installation and project
checks), provisions fresh devices with dedicated configs, and installs an exit
trap before setup. Encrypted setup reuses the SAS verifier/helper with the
thread environment explicitly supplied; helper and sender configs stay in room
mode, while the bridge config uses thread mode. No room harness is copied.

Independent defaults:

| Transport | Environment                  | Private device state |
| --------- | ---------------------------- | -------------------- |
| Plaintext | `plaintext-environment.json` | `private/plaintext/` |
| Encrypted | `encrypted-environment.json` | `private/encrypted/` |

Overrides are `THREAD_PLAINTEXT_ENVIRONMENT_FILE`,
`THREAD_PLAINTEXT_PRIVATE_ROOT`, `THREAD_ENCRYPTED_ENVIRONMENT_FILE`, and
`THREAD_ENCRYPTED_PRIVATE_ROOT`. Do not point these at another suite's files.
Test wrappers normalize relative environment paths before setup so the runner
and cleanup use the same file. Private-root overrides resolve from the
repository root during setup.

For manual operation, run `<transport>-setup.sh`, then `<transport>-run.mjs`
with an optional environment-file argument. Setup alone does not install a
cleanup trap. Always finish with:

```sh
node agent_tests/thread-sessions/plaintext-cleanup.mjs
node agent_tests/thread-sessions/encrypted-cleanup.mjs
```

Cleanup deletes retained ACP sessions (including detached reset sessions in
`e2e-session-ids.json`), logs out the suite's devices, and removes private state
and its environment file. Failures preserve state for retry. Encrypted cleanup
covers bridge, helper, and sender; plaintext covers bridge and sender.

## Local regressions

```sh
node --test agent_tests/e2e-support/*.test.mjs agent_tests/encrypted-e2e/*.test.mjs
```

Some support tests require an existing `dist/` build. These tests do not log in,
run live E2E, or require credentials. Suite-routing/config regressions live in
`../e2e-support/thread-suite.test.mjs` so the existing scoped test glob includes
them.
