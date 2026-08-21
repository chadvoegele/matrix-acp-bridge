# Completed-ID Recovery Matrix E2E Test

Run the isolated live test with:

```sh
npm run test:recovery
```

The runner:

1. starts from fresh bridge state and establishes the normal initial-sync
   completed-ID baseline;
2. completes one plaintext prompt exactly once;
3. stops the bridge and sends a second prompt while it is down;
4. restarts normally, holds the unseen prompt before ACP, and interrupts the
   bridge before that prompt can complete;
5. starts again and verifies that the completed first event is not submitted,
   while the interrupted second event is submitted exactly once;
6. verifies session restoration, completion-before-response persistence,
   bounded ledger compaction, and absence of legacy cursor/pending-batch
   fields; and
7. relies on the shared runner cleanup to delete ACP sessions, revoke Matrix
   devices, and remove private local state.

The test inspects only sanitized ACP method names, event counts, event IDs, and
state shape. It never prints prompt bodies, Matrix access tokens, or raw
service diagnostics.
