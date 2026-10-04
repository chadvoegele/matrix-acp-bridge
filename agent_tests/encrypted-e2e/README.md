# Encrypted Matrix end-to-end test helpers

Read the shared [authentication, ownership and recovery contract](../e2e-support/README.md)
before running. Token mode is preferred for repeated suites: supplied test-device
tokens use their original persistent stores, with no password login. Cleanup
preserves reusable credentials, devices and crypto, and deletes owned ACP sessions.
Legacy password mode creates disposable devices. Shell test entry points hold
the shared live lock; manual sequences must hold it through cleanup.

These test-only programs provision three dedicated devices on two existing Matrix accounts. They exercise normal SDK initial sync and completed-ID suppression across restart:

1. the bridge device;
2. a second device on the bridge account that completes real `m.sas.v1`; and
3. a sender device on the other account.

No account, room, device, token, password, or homeserver identity is committed. Generated configuration, tokens, and crypto stores live under ignored private paths.

The mode-specific sender and crypto checks remain in this directory; shared provisioning, ACP lifecycle, cleanup, and shell orchestration live in [`../e2e-support/`](../e2e-support/). The documented commands below remain the supported entry points.

## Prerequisites

- Node.js in the range accepted by `package.json`;
- util-linux `script` for the bridge CLI's controlling terminal;
- two existing Matrix accounts already joined to one encrypted room;
- either designated device-bound tokens with matching stores or password login enabled for those accounts; and
- an ACP command that exposes one full-duplex ACP process on stdin/stdout.

Export the private environment. Prefer retrieving passwords from a secret manager while sourcing your ignored `.env`, rather than writing passwords into that file:

```sh
export E2E_HOMESERVER='https://matrix.example.org'
export E2E_ROOM_ID='!encrypted-room:matrix.example.org'
export E2E_BRIDGE_USER_ID='@bridge-test:matrix.example.org'
export E2E_SENDER_USER_ID='@sender-test:matrix.example.org'
export E2E_AUTH_MODE=password # legacy disposable-device example
export E2E_BRIDGE_PASSWORD='bridge-account-password'
export E2E_SENDER_PASSWORD='sender-account-password'
export E2E_ACP_CWD='/tmp'
export E2E_ACP_COMMAND='["docker","--host","ssh://server.example.org","exec","-i","pi-acp","socat","UNIX-CONNECT:/run/pi-acp/acp.sock","STDIO"]'
```

Copy [`../.env.example`](../.env.example) to the repository-root ignored `.env`, replace its examples, and source it to configure both harnesses. Never put passwords or tokens in a committed file. Environment variables avoid password files but may remain visible to same-user or privileged processes, depending on the operating system. `E2E_ACP_COMMAND` is a JSON array, not a shell command.

## Run with automatic cleanup

The normal entry point provisions, tests, and cleans up even when setup or the test fails:

```sh
agent_tests/encrypted-e2e/test.sh
```

It deletes the test-created ACP session with `session/delete`, logs out only owned disposable Matrix devices, and removes run files; reusable tokens/stores remain. Matrix room events remain because they cannot be deleted reliably.

## Retained setup for debugging

To keep state while debugging, run setup and the test separately:

```sh
agent_tests/encrypted-e2e/setup.sh
node agent_tests/encrypted-e2e/run.mjs
```

Setup performs the normal checks, validates supplied token devices (or logs in three new owned device IDs in password mode), writes mode-`0600` token/config files, validates existing reusable crypto stores (or bootstraps newly owned stores), and runs the bridge's public `crypto verify` command. `verify-sas.mjs` compares both emoji and decimal SAS representations before confirming either client. It does not mark a device trusted through a local bypass.

Private state is recorded in:

```text
agent_tests/encrypted-e2e/environment.json
agent_tests/encrypted-e2e/private/
```

Keep it for repeat tests. Do not run setup again for the same environment.

## Run

```sh
node agent_tests/encrypted-e2e/run.mjs
```

The runner:

- starts the ACP proxy and bridge with a full-duplex pipe;
- sends and decrypts an encrypted prompt and response with a unique run suffix;
- checks both event types are `m.room.encrypted` through the Matrix API;
- counts exactly one ACP `session/prompt` request per live exchange and zero
  replayed completed prompts during restart;
- stops both clients and checks snapshot persistence;
- restarts with the same state and fingerprints; and
- repeats the exchange after normal initial-sync recovery.

## Manual cleanup

After a retained debugging run, delete the ACP session, revoke all three test devices, and remove private state:

```sh
node agent_tests/encrypted-e2e/cleanup.mjs
```

Cleanup preserves local state if ACP deletion or Matrix device revocation fails. Never delete local state first because that can leave an agent session or unrecoverable live devices behind.

## Scripted verbose activity

With the same encrypted-room credentials, run the opt-in activity check:

```sh
agent_tests/encrypted-e2e/test-activity.sh
```

It substitutes a local deterministic ACP emitter for this invocation, uses
the normal SAS-verified test devices, checks decrypted Matrix edits and raw
`m.room.encrypted` wire types, and invokes the normal cleanup trap. The
plaintext activity test has the detailed HTML, fallback and event-count
assertions. The existing `test.sh` entry point still uses the configured ACP
command.

## Thread-scoped sessions

Thread tests are a separate suite: [thread-sessions](../thread-sessions/README.md).
This suite always uses room mode, including its senders and activity tests.
