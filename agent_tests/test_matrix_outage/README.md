# HTTP outage recovery

Follow [shared live-test ownership](../e2e-support/README.md). Use only designated
test profiles, preserving crypto and completed-event ledgers. Hold the shared
live lock through setup, testing and ownership-aware cleanup.

After `npm ci && npm run check`, provision an existing plaintext or encrypted room/thread
profile using its normal provisioning entry point and trusted private environment.
Set `E2E_ACP_COMMAND` to the JSON array containing Node and the absolute path to
`peer.mjs` in this directory. This deterministic local ACP peer emits live
activity and final responses without real agent/model sessions. Use a private
environment/run root outside the worktree; never reuse a profile with undeleted
real ACP sessions.

Under that same process-held lock, run:

```sh
E2E_LIVE_LOCK_HELD=1 node agent_tests/test_matrix_outage/run.mjs /private/run/environment.json
```

Then run the original suite's cleanup with the same environment and ACP command,
even if the test fails. Reusable tokens and stores are preserved.

The test performs a healthy exchange, drops new HTTP requests from the
**test bridge only** for 60 seconds during its next live response, then verifies
that response and a subsequent same-room exchange. The sender remains connected. Plaintext selects the matching plaintext sender;
encrypted profiles retain normal SAS and authenticated decryption requirements.
The test-only Node preload holds requests before headers until the SDK aborts;
restoring connectivity does not settle old requests. No deployed service, proxy
or network rule is changed. It checks ~30-second rejection, stable transaction
identity on successful retry, no overlapping sends, the selected plaintext/encrypted wire types,
decryption, one response and one ACP submission per prompt. Thread profiles also
use the existing sender's thread-routing assertions.

This exercises a pre-header HTTP blackhole, not every encryption prerequisite or
a response body that stalls after headers. It does not establish the exact cause
of issue #25, and does not add crash-safe outbound delivery.
