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
two-second baseline observation requires zero recovered prompt requests. Use
fresh isolated state for a different response mode; do not switch a retained
thread suite into room mode without first preserving its session IDs for cleanup.

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
