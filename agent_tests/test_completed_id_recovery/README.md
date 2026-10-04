# Completed-ID Recovery Matrix E2E Test

Follow the shared [authentication, ownership and recovery contract](../e2e-support/README.md).
Token mode uses designated reusable test devices and their original persistent
state without `/login`; cleanup preserves tokens, devices, crypto and delivery
ledgers while deleting owned ACP sessions. Fresh-device login/bootstrap steps
below apply only to disposable password mode. Hold the shared live lock for
manual operations; shell test entry points hold it automatically.

Run the isolated live test with:

```sh
agent_tests/unencrypted-e2e/completed-id-recovery-test.sh
```

The runner:

1. starts from the retained initialized token ledger or a new owned-device
   initial-sync baseline;
2. completes one plaintext prompt exactly once;
3. stops the bridge and sends a second prompt while it is down;
4. restarts normally, holds the unseen prompt before ACP, and interrupts the
   bridge before that prompt can complete;
5. starts again and verifies that the completed first event is not submitted,
   while the interrupted second event is submitted exactly once;
6. verifies session restoration, completion-before-response persistence,
   bounded ledger compaction, and absence of legacy cursor/pending-batch
   fields; and
7. relies on the shared runner cleanup to delete ACP sessions, revoke only owned disposable
   devices, and preserve reusable credentials, crypto and initialized ledgers.

The test inspects only sanitized ACP method names, event counts, event IDs, and
state shape. It never prints prompt bodies, Matrix access tokens, or raw
service diagnostics.
