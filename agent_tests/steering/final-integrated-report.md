# Final integrated live verification

Latest status: the additional restart-after-reset probe exposed a completed-ID
compaction defect. A bounded product fix and regressions now pass all 470 tests.
All four primary modes and the controlled probes must be repeated on the fixed
build before final acceptance; earlier results below remain historical evidence.

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

## Integrated encrypted room checkpoint

Fresh retry normal SAS passed: matching emoji and decimal, helper confirmation,
interactive bridge `yes`, and both protocol completions. Encrypted room live
verification passed on HEAD `870eaa0ad05741568c8d192ea218b53d693336d6`,
with unchanged integrated product source/build. It sent 8 inputs, observed 15
replies, 5 prompts, 3 successful injected acknowledgements and 1 session. All
23 fetched raw sent/reply events were `m.room.encrypted`, with authenticated
decryption. All 10 ACP requests had responses and all 8 new inputs were durably
complete. Strict startup and final post-teardown health audits passed with zero
RPC errors or Matrix failure markers. Actual Pi model remained
`openai-codex/gpt-5.6-sol`.

Cleanup deleted that session, revoked all 3 temporary devices and confirmed
HTTP 401 for each saved token. Scoped adapter registry and Pi session files were
empty; active environment/device state was removed only after remote cleanup.
The earlier failed provisioning attempt and its one-device cleanup remain
separate retained evidence. Encrypted thread and extra initialized/reset probes
remain in progress.

## Raw encryption audit strengthening

Security review found that SDK required-encryption normalization filters out
plaintext timeline events. The older per-observed-event ciphertext check could
therefore miss an additional plaintext startup/shutdown event. No such product
failure has been observed; this was an audit gap. The harness now captures a raw
room boundary before startup and, after all teardown, paginates all newer raw
room events. It rejects plaintext test-account messages and unobserved encrypted
test-account messages. Existing decryption, wire, baseline and global RPC/Matrix
health checks remain enabled. Three deterministic regressions establish hidden
startup/shutdown rejection, fail-closed pagination and retained-window coverage.

Encrypted thread will use the strengthened harness. The earlier encrypted-room
result additionally requires read-only raw pagination of its retained complete
startup/teardown window before final acceptance. That audit will use a fresh
active owned token, never the revoked room-suite tokens.

## Four steering scenarios completed

| Mode             | Inputs | Replies | Prompts | Injected RPCs | Sessions | Raw encryption audit                                                |
| ---------------- | -----: | ------: | ------: | ------------: | -------: | ------------------------------------------------------------------- |
| Plaintext room   |      8 |      15 |       5 |             3 |        1 | plaintext mode                                                      |
| Plaintext thread |      9 |      16 |       6 |             3 |        2 | plaintext mode                                                      |
| Encrypted room   |      8 |      15 |       5 |             3 |        1 | 23 selected events encrypted; complete-window recheck pending       |
| Encrypted thread |      9 |      16 |       6 |             3 |        2 | all 25 complete-boundary events encrypted; exact observed event set |

Encrypted thread tested HEAD: `f804b5076f85094adef30ccdfc639491738d78e0`.
Both encrypted modes completed normal matching SAS and interactive `yes`.
Each mode had zero unexpected baseline session/prompt/steering activity, zero
ACP errors or Matrix failure markers through awaited teardown, durable injected
completion while the original prompt was pending, serial msg2/msg3 injection,
FIFO overrides, and the required explicit/default idle behavior. Native Pi
response counts were 13/19/13/19 respectively, with zero failures and the same
actual model `openai-codex/gpt-5.6-sol`. All six primary-suite ACP sessions and
ten device tokens were cleaned; each token returned HTTP 401 and each scoped
registry/session-file inventory was empty. The partial-provision device is a
separate additional revoked token.

Initialized recovery and live reset probes are still running/queued. Earlier
encrypted-room complete-window pagination and the final full check remain
acceptance gates. Primary scenario success alone does not finish this assignment.

## Proven completed-ID compaction replay and remediation

The reset barrier itself passed (4 inputs, 2 prompts, 1 injection, 1 replacement
session). Its next initialized restart failed the strict quiet baseline with
1 load, 1 prompt and 1 steering request before new input. The before-state
contained all four reset-scenario completions. The older initial snapshot selected
zero catch-up inputs, but compaction intersected the ledger with that snapshot
and removed the completed active/reset/post-reset IDs. Subsequent incremental
sync replayed the completed active input and its injection. Private before/after
state, SDK/Pi/ACP traces and the failed assertion are retained in `reset-barrier`.
This proves a product compaction defect; it does not establish the original
destroyed msg3 trace's exact ACP cause.

Completion metadata now retains the latest 10,000 IDs per room across older
snapshots, merges newly terminal IDs, and remains bounded during terminal writes
and baseline creation. Only event IDs are persisted. The existing schema 13,
authorization, unseen catch-up age/count limits, steering behavior and encryption
policy remain intact. Completion eviction beyond the bound and existing crash
gaps still preclude an exactly-once guarantee. Two coordinator/actual-SDK
regressions fail against the old implementation and pass with this fix; another
regression covers bounded baseline/completion/compaction and unseen eligibility.
Full check passes 470 tests. All resources from the failed scope were cleaned:
2 sessions deleted, 2 tokens revoked and HTTP 401 confirmed, scoped inventories
empty. Retrospective raw checks of both earlier encrypted scopes passed: exact
23/25 event sets, all encrypted, with startup/teardown windows padded 60 seconds.

Post-fix integrated live revalidation is pending.
