# Final integrated live verification

Assigned agent/branch: `aa-steering-final-integrated-live-20261002t015526-2bc5c0`.
Integrated implementation base: `2018351ad2f3d9468cabcb634470a217dbd03e50`.

Verification is in progress. Earlier isolated passes are historical evidence,
not acceptance of this integrated build. This checkpoint preserves the planned
evidence location before long live runs.

Private evidence: `/home/chad/.cache/matrix-steering-verification/final-integrated-20261002T0200`.
Directories are 0700 and files 0600. The controller holds the exclusive
`/tmp/matrix-acp-bridge-steering-live.lock` across provisioning, all live activity,
and cleanup. Each mode uses a new device set and isolated state.

Exact fetched PR115 head: `d7f9cb2428c992c62aa759919c799c5619a9b10b`.
All 21 retained source/build input files were compared with that Git object,
and upstream was rebuilt before testing. No upstream main substitution.
Developer model: Codex `gpt-6.1-sol`, medium. Actual Pi runtime model will be
recorded separately from session configuration returned over ACP.

No merge, push, PR comment, shared branch modification or ticket completion.
The original destroyed msg3 traces cannot establish its exact ACP cause.

## Initial integrated results

Full `npm run check` passed all 464 tests and formatting/lint/typecheck.
Plaintext room and thread passed the final wire/ledger/routing and shutdown
health audits. Room: 8 inputs, 15 replies, 5 prompts, 3 injections, 1 session.
Thread: 9 inputs, 16 replies, 6 prompts, 3 injections, 2 sessions. Each used
a new device set. All 3 owned sessions were deleted and all 4 temporary tokens
returned HTTP 401 after cleanup; scoped adapter registries and session files
were empty. Encrypted results and additional recovery/reset probes are pending.

Actual Pi model reported by ACP: `openai-codex/gpt-5.6-sol`. This is separate
from the required developer model and was not substituted for this test.

## Retained provisioning timeout

The initial encrypted-room provisioning process hit the private controller's
600-second bound before writing its environment and before SAS or steering.
One issued temporary token was retained. Under a new process-held lock, recovery
queried that token's identity, revoked only that owned device, confirmed HTTP 401,
and retained the identity/token metadata privately before removing active state.
This is a failed setup attempt, not encrypted acceptance or a proven bridge bug.
Fresh provisioning retries use a longer 1800-second allowance and private
HTTP status/backoff diagnostics. No trust or encryption setting changed.

## Independent specification and security review

Reviewed the integrated implementation against `specifications/mid-turn-steering.md`,
separately from the earlier implementation agents. No product change was needed.

- Command selection follows normalization, authorization, encryption/relation
  validation and original-body byte limits. Explicit/default provenance is typed
  and retained through startup/setup/reset and fallback conversion.
- The coordinator shares waiting capacity, serializes steering, preserves prompt
  FIFO and reset barriers, and excludes steering from prompt permits/collectors
  and timeout resets. Outstanding decisions and durable callbacks participate
  in idle/shutdown handling.
- The adapter requires boolean advertised capability and sends exact idle opt-in
  parameters. Malformed/detached results and ambiguous transport/timeouts fail
  closed without input redelivery. Healthy method errors remain visible;
  method-not-found disables the connection's steering capability.
- Durable injection completion is independent of the original prompt. Initialized
  catch-up retains existing age/count/ledger rules; no blanket suppression was
  introduced. Fake-agent and actual-SDK regressions cover recovery/setup races.
- The crypto remediation tolerates only ENOENT for the exact root snapshot
  staging file. Existing staging/committed entries retain ownership, permission,
  symlink and type validation. SAS helper completion requires true verification;
  stale requests do not establish trust. Production encryption remains required.

Negative unsupported-agent, malformed-result, authorization/size/unknown-thread,
ambiguous-timeout, forced-shutdown and concurrent-thread cases are deterministic
regression coverage, rather than newly induced failures on the live server.
The four live modes exercise sequential independent thread identities, not a
claim that PR115 supports multiple simultaneously active Pi subprocesses.
Acceptance is the wire acknowledgement and durable/routing behavior, not model
obedience or exactly-once/consumption guarantees. The deleted historical msg3
traces still do not prove its original exact ACP cause.
