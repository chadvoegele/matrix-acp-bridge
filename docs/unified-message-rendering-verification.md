# Unified rendering verification

Chad's Agent audited the implementation against
`specifications/unified-message-rendering.md`, the four-phase implementation plan,
and the mandatory CODE.md guidelines. Tested implementation revision:
`5d373630e0c40b922fc1a20204ea51244841253b`. This remediation changes only the
scripted E2E harness
and its regression coverage; production implementation remains that audited at
`aeb7da5f9474e7a98132bb1a20a8b4b7beb08649`. Subsequent report-only commits
do not change tested code. No deployment or merge into main is authorized by
these results.

## Environment and results

Linux, Node 26.11.1, npm 12.2.0, pinned Matrix JS SDK 42.2.0 and ACP SDK 1.3.0.
Local HTTPS fixture state is disposable under a unique private temporary directory.
Live Matrix runs reuse the designated persistent device/crypto cache; generated
run environments and private roots live outside Git and disposable worktrees.
Loopback HTTPS tests use an ephemeral OpenSSL certificate trusted through a
subprocess-only `NODE_EXTRA_CA_CERTS`; TLS verification stays enabled.

| Command / scope                                                                 | Result                                                                 |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `npm ci`                                                                        | Passed                                                                 |
| Baseline `npm run check`                                                        | Passed: 566 tests, 0 failures/skips                                    |
| Final `npm run check`                                                           | Passed: formatting, lint, typecheck/build; 570 tests, 0 failures/skips |
| Slow HTTPS room/thread subprocess scenarios (included in final `npm run check`) | Passed: 2 tests, 0 failures/skips; real bridge/ACP/SDK subprocesses    |
| Post-prompt parallel isolation integration (included in final `npm run check`)  | Passed: 1 test, four mode/transport combinations                       |
| Final actual Matrix: `plaintext room`                                           | PASSED: setup, functional scenario and cleanup                         |
| Final actual Matrix: `plaintext thread`                                         | PASSED: setup, functional scenario and cleanup                         |
| Final actual Matrix: `encrypted room`                                           | PASSED: setup, functional scenario and cleanup                         |
| Final actual Matrix: `encrypted thread`                                         | PASSED: setup, functional scenario and cleanup                         |

Final live totals: **4 functional passes, 0 failed/blocked setups, 4 successful
cleanups** at the tested revision above, completed 2026-10-17T03:42:32+00:00.
A single completed `npm run check`
preceded the final aggregate. Under the shared process-held live lock, it ran the
existing mode-specific `provision.mjs`, encrypted `verify-sas.mjs`, unified wire
runner and ownership-aware `cleanup.mjs` serially for plaintext room/thread and
encrypted room/thread. Thread cases used their existing transport-specific script
names. Trusted configuration came from the repository root `.env` and
`E2E_CACHE_PROFILE=unified-rendering-implementation`; no values were copied to Git.

Each final functional pass includes two identified streams, genuine observed
prefix/suffix/after-tool in-place edits, post-response unsolicited text and parallel
tools, twelve sequential message IDs, terminal completed/failed tool status and
collapsed activity, exact room/thread routing, no extra prompt/fallback output,
stale-session reset rejection, observable buffered shutdown, and raw original/edit
wire-type assertions. Encrypted cases require authenticated decryption. The normal
public-CLI bootstrap and real SAS exchange established the encrypted-room profile
during the intermediate run and the encrypted-thread profile during final setup;
final encrypted-room setup validated and reused its retained verified state.
The HTTPS fixture and hermetic crypto tests remain separate local coverage.

## Live remediation diagnosis

Chad's Agent retrieved the designated configuration from the trusted repository
root `.env`, without changing it or publishing credentials. Earlier implementation
verification had looked in the feature worktree and reported missing configuration;
that historical setup blocker does not describe the runs below.

The coordinator's initial actual plaintext room and thread attempts both failed
the exact suffix-only replacement assertion. Under the normal live lock, private
raw Matrix history captures for both modes showed one prefix original, zero
suffix-only snapshots, and one after-tool continuation replacing that same original.
The final content was delivered correctly. Replaying the original peer and runner
against the HTTPS fixture with a three-second progressive-send delay reproduced
the exact assertion failure and the same sequence of text snapshots. The fixed
1.1-second producer pacing incorrectly required an intermediate publication even
when valid buffering coalesced it during slow Matrix transport.

The scripted peer now waits for sender-observed delivery of the prefix, exact
Markdown suffix edit, both running tools, and same-ID after-tool edit. Harness-only
ACP notifications acknowledge those observations without submitting another prompt
or changing production buffering. Exact content/replacement assertions remain;
an exact initial-prefix assertion strengthens progressive-delivery coverage.
The reset probe emits stale text and a successful terminal tool frame only after
reset completion is observed, and the runner requires both frames on ACP before
asserting neither reaches Matrix.

Both plaintext modes then exposed a separate harness setup error: each observed
one extra prefix from a previously unseen test input in the persistent profile.
Private raw history confirmed that the extra original belonged to an older probe.
The suite now invokes the existing `warmProfile` lifecycle before strict reusable
profile scenarios. The same scripted peer handles recovered streams in `--recover`
mode without waiting for intermediate snapshot acknowledgments. Recovery records
completed inputs normally, deletes its exact ACP sessions and detaches mappings,
preserving the completed-event ledger, tokens, manifests and crypto. A regression
starts with an initialized ledger and an unseen probe and requires both recovered
final output and retained completed ID before the strict scenario passes.

The slow HTTPS room/thread regressions retain
real bridge/ACP/Matrix SDK subprocesses, with no real homeserver/crypto/SAS claim.

An intermediate remediation run at
`3c0f23bff25e1c8f0529899bbd88e2f5f13d0608` passed the full actual encrypted-room
scenario, including real SAS and encrypted-wire checks. Its plaintext modes failed
the newly exposed recovery-boundary assertion. Encrypted thread provisioning hit
HTTP 429; its issued bridge device and blocked helper proposal were retained.
The final run used normal profile recovery, and any credential issuance retry
occurred only after the recorded server window (`2026-10-17T03:29:17.691Z`).
No credential/crypto reset, new profile to evade limits, or uncontrolled retry was
used. Historical failures and partial setup are not counted as final passes.

The coordinator's two initial encrypted attempts stopped before provisioning:
its parent-checkout formatter scanned this nested worktree during a transient
unformatted edit. This was corrected before the independent four-case run and
was not an encrypted functional result.

Cleanup was independently audited under the normal live lock after the aggregate
finished. All four generated run environments/private roots were removed. All four
persistent profiles and ten reusable token/device stores remain; all six encrypted
role stores retain their crypto databases, identity manifests and real SAS flags.
Initialized completed-event ledgers remain and ACP session mappings are detached.
No active store claim or bootstrap lock remains. Exact test/recovery ACP sessions
were deleted, including detached reset sessions. No reusable device was logged out,
no crypto/credential store was reset, and no production service/session was touched.
Matrix rooms/events remain. Private logs, failed-attempt evidence and raw event
captures stay outside Git; no credentials, transcripts or personal identifiers are
included in this report.

Real Pi E2E was not run. Per the prerequisite recorded for this work, installed
pi-acp lacks the required assistant message IDs. Stable IDs per Pi response,
non-interleaving, and IDs on unsolicited text must be validated in the separate
adapter work. The scripted peer proves the bridge's behavior under that contract.
No pi-acp changes, production restarts, production credentials, crypto resets or
trust bypasses were used.

## Specification acceptance audit

Each row maps a Verification criterion in specification order to executable
coverage. Buffer/activity tests use deterministic clocks or gated publications.
The added SDK-isolation test uses production ACP parsing and delivery with
hermetic SDK/crypto boundaries. Only the subprocess scenarios use real SDK HTTP.

| Criterion                                                        | Evidence                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unsolicited output after completion, no extra prompt             | `bridge.test.ts`: identified prompt completion; `integration.test.ts`: identified unsolicited continuations; scripted stream observes ACP response before updates and exact prompt count        |
| Same identified solicited/unsolicited behavior                   | Same tests and subprocess progressive prefix/continuation                                                                                                                                       |
| Repeated/distinct IDs; session isolation                         | Buffer repeated-delta tests; new SDK room/thread isolation with shared text/tool IDs; two scripted thread roots                                                                                 |
| Quiet tail flush and later same-event edit                       | Buffer quiet-flush test; subprocess Markdown prefix, suffix and continuation replacements                                                                                                       |
| Transition ordering and mapping retirement                       | Buffer transition, slow-send and retired-identity tests; twelve sequential scripted IDs                                                                                                         |
| Byte/max-interval triggers, bounded calls/timers                 | Buffer UTF-8 size/pacing, continuous deltas and timer-cleanup tests; config bounds/default tests                                                                                                |
| Slow transport serialization/coalescing                          | Buffer slow-send tests; bridge identified publication in flight; session-activity slow terminal/collapse test                                                                                   |
| Prompt completion independent of draining, no duplicate/fallback | Bridge identified prompt completion test; subprocess exact original count and post-response updates                                                                                             |
| Only current bounded block retained                              | Buffer retired-identity and bounded pending tests; bridge sequential assistant IDs                                                                                                              |
| Early tool announcement then same-ID text                        | Dedicated bridge test, new SDK-isolation test and subprocess same-target edit after tools                                                                                                       |
| Many IDs, bounded backpressure, observable failure               | Buffer retired identities/capacity/failure; bridge sequential IDs/capacity/publication failure; subprocess sequential IDs                                                                       |
| Restart discards mappings/history                                | Bridge restored-session replay test; integration restart/catch-up regressions                                                                                                                   |
| Text/activity ordering; whitespace/tools do not finalize         | Buffer transitions; bridge thought grouping, early tool and unsolicited tool tests; subprocess preceding text and expanded/collapsed activity                                                   |
| Pi ID prerequisite                                               | EXTERNAL BLOCKER: not established by scripted tests; separate pi-acp work required                                                                                                              |
| Unsolicited tool terminal/result updates                         | Bridge unsolicited parallel tools and activity rollover/result tests; subprocess terminal statuses after response                                                                               |
| Parallel tools survive transitions/completion                    | Session-activity independent batches; bridge unsolicited parallel tools; new SDK-isolation test; subprocess                                                                                     |
| Closed batches released after terminal/collapse, no index growth | Session-activity slow terminal, parallel batches and 100 sequential closed batches                                                                                                              |
| Reset/subprocess failure/transport failure clean up activity     | Session-activity transport/lifecycle failure; bridge reset and ACP subprocess failure; subprocess reset deliberately delivers stale text and terminal frames                                    |
| Safe Markdown, encoded limits and explicit truncation            | Buffer safe incremental Markdown, continuation, late truncation and event-budget tests; existing Markdown/packing/output tests; subprocess safe formatted replacements and encoded event budget |
| Unknown/stale/loading sessions; shutdown/failure cleanup         | Bridge reset/replay/unknown/failure tests; buffer reset/capacity timer tests; subprocess stale reset and buffered shutdown with abandonment diagnostic                                          |
| ID-less compatibility and bounded diagnostic                     | Existing solicited ID-less bridge regressions; dedicated ID-less unsolicited diagnostic test                                                                                                    |

No acceptance criterion was relaxed. Live encrypted transport retains the normal
SAS/authenticated-decryption gates and encrypted original/edit wire checks.
Pi adapter validation remains an external prerequisite.

## CODE.md audit

The table below records the original implementation audit. The subsequent
[PR #28 guideline-by-guideline review](pr-28-code-review.md) checks every bullet
and sub-bullet, records remediation, and distinguishes its validation from the
historical live results above.

| Guideline group  | Assessment                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture     | Flow fits eight components: ACP wire, authorized session routing, text buffer, activity model, conversation publication queue, delivery policy, Matrix SDK, durable routing store. Buffer/activity share queue ownership and lifecycle.           |
| Structure        | Existing functional modules retained; new peer, observations and runner have separate roles. Explicit static mode selection; early validation; no metaprogramming or runtime source rewriting.                                                    |
| Debt             | Empty identified-ID transitions now reach the buffer and flush preceding text, with a focused regression. No second prompt-final identified publisher; ID-less compatibility remains scoped. No unrelated refactor or package dependency changes. |
| Abstractions     | Rendering stays behind buffer/activity publication interfaces. Test fixture is a narrow protocol boundary; it does not leak into production.                                                                                                      |
| Scoping          | Per-session state and per-run observation maps; no historical renderer cache or global test state shared between modes.                                                                                                                           |
| Naming           | Existing message/session/tool/batch terminology; named publication settings; bounded test counts and timeout constants describe scenarios.                                                                                                        |
| Responsibilities | ACP peer emits deltas, observations assert content, runner owns clients/processes. Production routing, buffering, transport retry and persistence retain separate contracts.                                                                      |
| Comments         | Comments explain adapter concurrency, deliberate stale frames, fixture limits and SDK handle cleanup. Work history remains in WAAP state.                                                                                                         |
| Dependencies     | No package dependency additions. Test TLS certificate generation uses the system OpenSSL executable, documented as a test prerequisite.                                                                                                           |
| Logging/errors   | Production diagnostics remain bounded and content-safe. Harness writes a concise test result; private operational errors remain subject to existing sanitization. No tokens/transcripts enter reports or commits.                                 |
| Feel/cleanup     | Existing composable components reused. Local subprocess groups, HTTPS server/connections and private files are retired; live wrappers retain exact session/device ownership cleanup and interrupted-run evidence.                                 |
| Testing          | Unit-heavy suite retained; added focused integration plus two actual subprocess/SDK HTTPS scenarios. Crypto doubles and external blockers are distinguished from live E2E.                                                                        |

## Review status

The implementation remains on `feat/unified-message-rendering` for review.
No merge into main or deployment was performed. The live Matrix outcomes above
apply to the exact tested revision; separate Pi adapter validation remains required
before claiming real-Pi identified-message E2E support.
