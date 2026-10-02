# Live Matrix steering verification

`live-matrix.mjs` is an opt-in live homeserver test. It launches the built bridge
CLI and the environment's real ACP command through unchanged NDJSON taps. Use
only the two documented test accounts and designated test rooms from the ignored
root `.env`. Check that configuration privately before evaluating any credential
lookups; retrieve passwords with `nopass_pass.sh`. Never commit or print tokens,
private Matrix identifiers, or raw wire traces.

Build with `npm ci && npm run build`. Supply an exact pi-acp PR115 build through
`E2E_ACP_COMMAND`, and an isolated scratch directory through `E2E_ACP_CWD`.
Record the upstream revision and build digest. A production bridge build is used;
the hosted bridge, Pi session daemon, and pi-web need no restart.

Provision through the existing documented harnesses. Set a distinct ignored
`STEERING_EVIDENCE_FILE` under `node_modules/` for each invocation. The runner
sets the temporary bridge config to default steering and the selected response
mode. Existing startup-ready and sender initial-sync gates run before any input. A
two-second baseline observation requires zero session creation/loading, prompts, or steering requests. Use
new temporary devices and fresh isolated state for each response mode. Replacing
state on an already used device can replay inputs through incremental sync after
an older initial snapshot. The runner records a private device baseline next to
the bridge token and rejects a different mode or state before live operations.
Preserve all session IDs, clean up the old device set, then provision the next
mode. Intentional initialized recovery uses the separate startup probe below.

```sh
node agent_tests/unencrypted-e2e/provision.mjs
STEERING_EVIDENCE_FILE=node_modules/room-wire.json \
  node agent_tests/steering/live-matrix.mjs \
  agent_tests/unencrypted-e2e/environment.json plaintext room
node agent_tests/unencrypted-e2e/cleanup.mjs

node agent_tests/thread-sessions/plaintext-provision.mjs
STEERING_EVIDENCE_FILE=node_modules/thread-wire.json \
  node agent_tests/steering/live-matrix.mjs \
  agent_tests/thread-sessions/plaintext-environment.json plaintext thread
node agent_tests/thread-sessions/plaintext-cleanup.mjs

node agent_tests/thread-sessions/encrypted-provision.mjs
node agent_tests/thread-sessions/encrypted-verify-sas.mjs
STEERING_EVIDENCE_FILE=node_modules/encrypted-thread-wire.json \
  node agent_tests/steering/live-matrix.mjs \
  agent_tests/thread-sessions/encrypted-environment.json encrypted thread
node agent_tests/thread-sessions/encrypted-cleanup.mjs
```

For encrypted room mode, use `encrypted-e2e/provision.mjs`,
`encrypted-e2e/verify-sas.mjs`, its `environment.json`, `encrypted room`, and
`encrypted-e2e/cleanup.mjs`. Normal SAS must succeed before running encrypted
steering. No trust bypass is supported.

Always run cleanup even after a failed test. Cleanup deletes ACP sessions,
revokes temporary devices, and then removes local state. If cleanup fails,
preserve environment/token/state files privately for recovery before allowing a
launcher to remove the worktree. Room events remain. Do not reprovision over an
existing environment. The examples show explicit cleanup so an operator can
inspect private evidence first; they do not install an exit trap.

Each live run checks an explicit Matrix prompt, injection while that turn is
pending, two queued `/prompt` overrides in FIFO order, tracked idle fallback,
and default steering with msg1 starting a prompt and msg2/msg3 injected serially.
The injected event must become durable while the original prompt is pending;
converted inputs must reach the completed-event ledger. Thread mode additionally
checks a new top-level steering conversation gets a
separate session. Replies retain their thread roots, including separate text groups around thought
or tool activity. Identical replies from different turns are counted per
conversation, without requiring a particular model response. Encrypted mode checks raw
`m.room.encrypted` event types and authenticated decryption. RPC outcomes are
asserted independently of whether the model follows a correction. Tool use is
required to establish a reproducible pending turn; each phase has a bounded
wait. A model that declines the requested sleep produces an incomplete run.

The script writes private event IDs, timestamps and full ACP frames to the
ignored evidence path. Console summaries contain only structural counts and
method/outcome names. Redirect SDK output privately, since upstream diagnostics
can contain identifiers. Publish a sanitized report; raw traces are for private
inspection. Unsupported-agent and unauthorized/unknown-thread cases remain
hermetic regression coverage unless separately exercised with controlled live
fixtures.

Success is emitted only after awaited teardown and a health audit of all observed
RPC errors and Matrix failure markers, including startup and shutdown. Private
evidence includes phase labels and child diagnostics. Preserve failed-run evidence
securely outside disposable launcher worktrees before cleanup removes them. See
[msg3 investigation](msg3-investigation-report.md) for the historical replay error.

`startup-matrix.mjs` provides a bounded plaintext startup probe using the same
production CLI and real ACP transport. Hold the process-held exclusive
`/tmp/matrix-acp-bridge-steering-live.lock` through provisioning, probes, resource
inspection and cleanup. Keep evidence outside disposable worktrees (directories
0700, files 0600). Each command takes an environment, operation and evidence path:

```sh
node agent_tests/steering/startup-matrix.mjs environment.json fresh fresh-wire.json
node agent_tests/steering/startup-matrix.mjs environment.json send send-wire.json input.json
node agent_tests/steering/startup-matrix.mjs environment.json catchup catchup-wire.json input.json
node agent_tests/steering/startup-matrix.mjs environment.json quiet quiet-wire.json
node agent_tests/steering/startup-matrix.mjs environment.json reset reset-wire.json
```

`fresh` requires an absent state file and verifies zero startup ACP work. `send`
sends one controlled input while the bridge is stopped. `catchup` requires
initialized state and verifies exactly that input becomes a completed prompt;
`quiet` verifies a subsequent initialized restart does no work. For a room to
thread transition, keep the controlled state's identity and ledger and change
only the response mode in a separate config before `catchup`. A separate fresh
thread probe must use a distinct state directory. Preserve all created session
IDs from wire evidence and every state's session mappings for ordered cleanup.
These probes retain startup/shutdown frames and child diagnostics and audit
Matrix failures and RPC errors after awaited teardown.

The optional `reset` probe requires initialized plaintext room state and a config
with `default_message_delivery = "steer"`. It starts a real tool turn, confirms
an injected steering acknowledgement and independent durable completion, then
queues `/reset` and default-selected input while the original prompt is pending.
It verifies that later input becomes one tracked prompt on a replacement session,
never steers the old session, and emits no implicit idle notice. Keep earlier
session IDs for cleanup, because resetting the bridge mapping does not delete
the old ACP session. Baseline and final health audits remain enabled.
