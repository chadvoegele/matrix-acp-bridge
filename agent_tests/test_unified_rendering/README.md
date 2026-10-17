# Unified rendering runners

Read [authentication, ownership and recovery](../e2e-support/README.md) in full
before live runs. Use designated test rooms/accounts/devices and private state.
The wrapper holds the shared live lock, runs setup/checks, uses the existing
provisioning/SAS path, and installs the existing ownership-aware cleanup trap.
Run serially after sourcing trusted private test configuration:

```sh
agent_tests/e2e-support/test-unified.sh plaintext room
agent_tests/e2e-support/test-unified.sh plaintext thread
agent_tests/e2e-support/test-unified.sh encrypted room
agent_tests/e2e-support/test-unified.sh encrypted thread
```

These substitute a local scripted ACP peer for this invocation. They never run
Pi or connect to a production ACP endpoint. Use an isolated cache profile or
disposable password devices; preserve existing tokens, crypto stores and delivery
ledgers. Existing environment files must be recovered/cleaned with their original
ACP command before starting. The normal mode-specific setup/cleanup scripts and
environment/private-root overrides still apply. Interrupted runs retain the
environment and `e2e-session-ids.json` for exact session cleanup. Room events remain.

Each run checks two identified streams. Room mode reuses its session with
distinct message/tool IDs for each stream; thread mode creates separate roots
and ACP sessions that deliberately share the same IDs. Each
stream sends a prefix before its prompt response, then without another prompt:

- completes Markdown through an in-place replacement after a quiet flush;
- announces two parallel tools, then edits the same text ID after the announcement;
- emits twelve sequential IDs and a final ID, each exactly once;
- publishes completed/failed tool statuses after assistant ID transitions, retaining
  initial expanded activity and final collapsed batches.

The scripted peer advances each stream only after the sender has observed its
exact prefix, Markdown suffix edit, both running tools, and same-ID continuation.
These harness-only ACP notifications do not submit prompts or alter production
buffering. Slow homeserver delivery can therefore coalesce freely without skipping
an intermediate snapshot required by this scenario.

Reusable profiles first run the existing profile-recovery path with the same
scripted peer in `--recover` mode. Recovered streams advance without snapshot
acknowledgments; the strict scenario still gates every intermediate delivery.
Recovery handles old room inputs normally, records their terminal IDs, deletes
its exact ACP sessions, and detaches mappings while preserving the ledger and
crypto. Its sanitized prompt/session counts are included in the live log.

Originals and replacement targets, exact text counts, thread roots/fallbacks,
HTML, event-size bounds and raw wire types are asserted. Observations require
server timestamps at/after the input. Encrypted runs require authenticated
decryption and `m.room.encrypted` originals/edits, with the normal fatal
decryption gate and real SAS setup; there is no plaintext or trust bypass.

A third prompt leaves a tool running. Reset must reject deliberately late text
and terminal updates, gated on observed reset completion, from that retired
session. The ACP monitor requires both stale frames to arrive before checking
that neither was published. A fourth prompt leaves buffered
text; immediate graceful shutdown must diagnose abandonment and cancel its timer.
The ACP monitor verifies prompt responses precede background output and retains
all created session IDs for cleanup. No transcript or token is written by the
runner. Private setup/error logs still require the usual sanitization.

## Isolated automated checks

```sh
npm ci
npm run check
# Or, after building:
node --test agent_tests/e2e-support/unified-wire.test.mjs
node --test --test-name-pattern='post-prompt parallel' dist-test/integration.test.js
```

The first scoped command runs the same plaintext runner in room and thread modes
against a loopback HTTPS Matrix **protocol fixture**, with actual bridge, ACP and
sender subprocesses and the real Matrix SDK. It delays progressive HTTP publications by three
seconds, exceeding the former 1.1-second scripted pacing, to regress intermediate
snapshot coalescing. The room fixture also starts with an initialized ledger and
an unseen prior probe: recovery must publish its final output and preserve its
completed ID before the strict streams begin. It creates an ephemeral one-day
certificate using `openssl`, trusts only that certificate through
`NODE_EXTRA_CA_CERTS`, and removes its temporary config/state/certificate and
process group. TLS validation remains enabled. It has no real accounts/devices,
homeserver, Rust crypto or SAS. OpenSSL is required for these automated tests.

The second command covers two rooms or two threads with identical message/tool
IDs through the production ACP wire parser, coordinator, delivery and SDK adapter,
in plaintext and modeled encrypted modes. Crypto and SDK I/O are hermetic test
doubles here. Deterministic buffer/bridge/activity tests cover pacing, slow and
failed delivery, history/restart, output limits, retention and timer cleanup.

Neither command establishes a live encrypted Matrix pass or Pi adapter support.
The installed Pi adapter lacks required assistant IDs; implementing and validating
that prerequisite remains outside this repository. See the
[verification report](../../docs/unified-message-rendering-verification.md).
