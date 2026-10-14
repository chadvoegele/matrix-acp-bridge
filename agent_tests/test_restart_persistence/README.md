# Restart and recovery runners

Follow the shared [authentication, ownership and recovery contract](../e2e-support/README.md)
and [plaintext environment setup](../unencrypted-e2e/README.md). Shell entry
points hold the shared live lock and attempt cleanup on failure or signals.
Cleanup deletes owned ACP sessions and disposable devices; reusable credentials,
crypto and initialized delivery ledgers remain. Retain private state if remote
cleanup fails.

## Graceful session persistence

```sh
agent_tests/unencrypted-e2e/restart-persistence-test.sh
```

Requires ACP `loadSession`. Complete a memory instruction, stop the bridge/ACP
pair gracefully, and send an input referring to the remembered value while both
are down. Restart with the same configuration and persistent state. Require:

- `session/load` before the recovered prompt, both on the original session;
- no replacement `session/new`, one recovered prompt and one matching plaintext
  top-level response, with the exact remembered value;
- zero replay of the first completed prompt and an unchanged room mapping.

This verifies retained agent context, not just duplicate suppression.

## Interrupted input recovery

```sh
agent_tests/unencrypted-e2e/completed-id-recovery-test.sh
```

Complete one prompt, stop the bridge, and send another input while it is down.
Restart normally, hold that unseen input before ACP, and interrupt the bridge
before completion. Restart again: the first completed input must not be
submitted; the interrupted input must be submitted exactly once and completed
before its Matrix response. Verify session restoration when supported.

This deliberately tests interruption, unlike the graceful memory test. It does
not establish durable recovery of a partially delivered response.

## Shared state assertions

Both runners start from an initialized retained ledger or an owned fresh-device
baseline, use normal initial sync, and inspect bounded schema-v13 completed-ID
state without legacy cursor or pending-batch fields. Sanitized diagnostics and
ACP method counts must show no state, lock or protocol failures. Neither runner
prints prompt bodies, tokens or raw service diagnostics.
