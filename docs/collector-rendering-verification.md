# Collector rendering verification

Chad's Agent

Current evidence for the collector refactor in PR #28. The
[earlier report](unified-message-rendering-verification.md) and
[earlier CODE.md review](pr-28-code-review.md) are historical and describe their
named pre-refactor revisions. The developer's original rendering and actual
functional revision:
`9cbf1c70e874211f410e0e43c6d058f0ac1d2c0d`. Cleanup remediation/regression and final
automated revision: `cc708d4019949ecc71e9a4b9417320e7a487c5e8`. That second commit
changes only the encrypted test cleanup entry point and its regression; production
rendering is identical. Subsequent report-only changes do not alter code/tests.
Automated fixtures, actual Matrix outcomes and coordinator follow-up are recorded
separately.

## Fresh itemized CODE.md audit

The [collector item-by-item review](pr-28-collector-code-review.md) checks all
56 evaluative CODE.md items/sub-items against feature revision `e3d6626` and its
full PR base diff, with the four bibliography entries separate. It records tool
ID isolation, rejected-model cleanup, constructor guards, card rollover/cleanup
and cleaned-empty legacy thought fixes, regression evidence and explicit qualifications. Its validation
applies to those audit changes; earlier automated/live results below retain their
original revisions. No new complete live Matrix or real Pi pass is claimed.

## Coordinator review

Independent review reproduced a whitespace-only thought regression: an identified
blank thought reserved a card entry and timer, reducing tool capacity even though
the previous renderer ignored that initial blank thought. Production/test revision
`5559a6dde6b78000767389a9a8c5df791a9c6f99` restores filtering before reservation;
spacing after a meaningful thought still goes through the shared collector.
A regression checks retained entries/cards/timers, two-tool capacity and reset of
the identified-thought flag on the next response.

The coordinator independently repeated the developer's complete 589-test suite
before that correction. Afterward, the scoped session-output/text/card suites
passed **16 tests**, zero failures/skips (77.723291 ms test duration), with a
seven-second per-test and 30-second process timeout.

The final independent `timeout --kill-after=10s 240s npm run check` at `5559a6d`
passed formatting, lint, typecheck/build and **590 tests**, zero failures,
cancellations or skips. It completed in about **104 seconds** wall time
(89.484130229 seconds test duration). Included real-SDK slow HTTPS cases passed
in 59.918441609 seconds (room) and 29.469779043 seconds (thread). Subsequent edits
only record evidence and normalize specification metadata; code/tests stay fixed.

The actual Matrix passes below remain tied to `9cbf1c7`, before this small
production correction; they are not claimed as fresh live results for `5559a6d`.
The correction restores prior whitespace-only filtering, but was not rerun on a
real Matrix homeserver. Four SVGs were independently XML-validated, rendered and
visually reviewed. Specification front matter uses the supported `final` status;
no additional implementation behavior is introduced by those documentation edits.

## Acceptance coverage

| Requirement                                                                                                                   | Executable evidence                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Shared text accumulation, UTF-8 bytes, quiet/maximum interval, pacing, explicit scoped flush/finish, transitions/cancellation | `text-collector.test.ts`, `text-publication.test.ts`; identical deterministic-clock checks for message/thought instances   |
| Repeated deltas append; cumulative card snapshots replace                                                                     | Text collector and activity-card tests                                                                                     |
| Thought/text alternation with the same response ID, pending thought before last tool completes                                | `session-output.test.ts`; SDK-boundary isolation integration covers two rooms/two threads and plaintext/modeled encryption |
| Response transitions finish both text owners; tools do not prove response completion                                          | Session output tests with unrelated tool message metadata                                                                  |
| Parallel tool patches, replacement results, terminal streams/status-only pacing, terminal flush before finish                 | `tool-collector.test.ts`, bounded model/rendering and ACP client tests                                                     |
| Stable old-card destinations, explicit finish, source retention bounds                                                        | Activity-card and session-output rollover/100 sequential card tests                                                        |
| Emitter-local equal IDs, older live IDs, finish during in-flight sends                                                        | `matrix-output-sender.test.ts` with gated sends                                                                            |
| Original targets/continuation growth and shrinkage; unchanged/empty output                                                    | Sender and text publication tests                                                                                          |
| Mandatory initial expanded view before collapse with blocked delivery                                                         | Sender and session-output barrier tests; bridge rapid-rollover tests                                                       |
| Shared safe Markdown in thoughts; markers/heading normalization, escaped raw HTML/tools and wrappers                          | Activity-card/rendering tests; SDK isolation asserts resumed Markdown in the original collapsed thought card               |
| Full output/event/thread/edit budgets and explicit truncation                                                                 | Text publication, activity-card, bridge/Markdown packing tests                                                             |
| Bounded queue, capacity/delivery failure, lifecycle cleanup and stale callbacks                                               | Sender, text publication, session output, conversation queue and bridge tests                                              |
| Prompt-independent lifetime, room/thread routing, load/history/restart/ID-less compatibility, encryption boundary             | Bridge and integration suites; existing SDK HTTPS subprocess regressions remain separate from actual Matrix                |

## CODE.md assessment

The component map has eight directional stages and expands into focused domain
owners. Message/thought text shares one implementation and scheduler; tool patch
semantics and card lifetime stay separate. `OutputSink` has only flush and finish;
`renderOutput` transforms payloads without timers or publication identity.

Private state retains only live content, bounded pending snapshots and in-flight
sender mappings. Structured snapshots replace entries; tool patches create fresh
bounded field values. Renderer functions are pure. The sender owns original event
IDs and queue barriers, and `MatrixDelivery` retains retry ownership. No new
configuration, dependencies, history caches, persistence schemas or Pi modifications.

Superseded `AgentTextBuffer`, `SessionActivity`, `AcpActivityBatches` and mixed
thought/tool model paths are removed. Existing tests were moved to the new owners;
assertions for content, safety, targets, bounds and barriers remain. Tests expecting
cross-type eager flushes now explicitly advance the shared publication clock. One
fixture previously emitted a second result after a terminal update; it now streams
the first result while running and ends with the final result, matching the explicit
terminal contract.

Guard clauses, functional modules, local settings/helpers and content-free failure
diagnostics follow CODE.md. Private mutation in accumulators, schedulers and queues
is deliberate bounded streaming state; publication records are readonly. This
original refactor assessment is superseded by the [fresh 56-item audit](pr-28-collector-code-review.md),
including its fixes and qualifications. Existing bridge prompt/ID-less compatibility
remains outside the identified collector path.

## Developer automated evidence

Linux, Node 26.11.1, npm 12.2.1, pinned Matrix SDK 42.2.0 and ACP SDK 1.3.0.
The bounded complete command was:

```sh
timeout --kill-after=10s 240s npm run check
```

Formatting, lint, typecheck/build and **589 tests passed**, with zero failures,
cancellations or skips. Wall time was **103.387 seconds**; test duration was
89.451615 seconds. The included real bridge/ACP/Matrix-SDK slow loopback HTTPS
cases passed in 59.876385 seconds (room) and 29.478519 seconds (thread). They
use an isolated protocol fixture and ephemeral trusted TLS certificate, with TLS
validation enabled. They do not establish actual homeserver/crypto/SAS coverage.

Changed-owner verification uses per-test and process timeouts:

```sh
timeout --kill-after=5s 60s node --test --test-timeout=7000 \
  dist-test/text-collector.test.js dist-test/text-publication.test.js \
  dist-test/activity-card-collector.test.js dist-test/session-output.test.js \
  dist-test/matrix-output-sender.test.js dist-test/tool-collector.test.js \
  dist-test/acp-activity.test.js dist-test/acp-client.test.js \
  dist-test/bridge.test.js dist-test/integration.test.js
```

**224 tests passed**, with zero failures/cancellations/skips. The final pinned-code
confirmation took 1.327329 seconds of test time and 1.352 seconds wall time.

The focused rendering result applies to `9cbf1c7`. After the live cleanup audit,
the cleanup/ownership owners also passed at `cc708d4`:

```sh
timeout --kill-after=5s 30s node --test --test-timeout=15000 \
  agent_tests/e2e-support/cleanup.test.mjs agent_tests/e2e-support/auth.test.mjs
```

**14 tests passed**, zero failures/skips; 0.285998 seconds test time and 0.310 seconds
wall time. The final 589-test full check above includes this regression.

Production rendering stayed fixed throughout actual Matrix execution.
Each initial live wrapper independently repeated the full 588-test suite, including
both HTTPS cases, successfully before provisioning. The later encrypted resumes
use the same already-checked code and documented manual provisioning/SAS phases.

All four changed SVGs parse as XML and have no external references. They were
rendered with `rsvg-convert` and visually inspected; labels and connectors fit.
Changed Markdown local links and `git diff --check` pass.

## Actual scripted-ACP Matrix evidence

The existing scenario commands are:

```sh
agent_tests/e2e-support/test-unified.sh plaintext room
agent_tests/e2e-support/test-unified.sh plaintext thread
agent_tests/e2e-support/test-unified.sh encrypted room
agent_tests/e2e-support/test-unified.sh encrypted thread
```

The initial sequence holds the normal process-owned shared live lock across all
four serial wrappers, each bounded by `timeout --kill-after=10s 420s`. It sources
the canonical repository root `.env` through trusted setup without printing values
and selects the designated `unified-rendering-implementation` cache name.

These named profiles were absent in this environment. Normal setup therefore
issued reusable designated test devices. This is explicitly distinguished from
reusing preexisting tokens/verified stores. No alternate cache name was used to
evade a limit. Both initial encrypted setups stopped before functionality with
HTTP 429, retaining their issued roles and blocked device proposals. The recorded
server boundaries were 20:46:18.406Z (room) and 20:51:51.740Z (thread), on
2026-10-17. Later resumes honor the later boundary across both profiles.

Each bounded manual resume uses the existing mode-specific `provision.mjs`, normal
`verify-sas.mjs`, `unified-wire.mjs` and ownership-aware `cleanup.mjs` programs under
the shared lock. The 600-second resume bound includes legitimate rate-window
waiting as well as setup/function/cleanup. There is one resume per encrypted case;
retained identities/stores are never deleted or replaced to force setup.

| Case / attempt                  | Setup                               | Function | Run cleanup                                     | Wall seconds |
| ------------------------------- | ----------------------------------- | -------- | ----------------------------------------------- | -----------: |
| Plaintext room                  | Passed                              | Passed   | Passed                                          |          311 |
| Plaintext thread                | Passed                              | Passed   | Passed                                          |          310 |
| Encrypted room, initial         | HTTP 429                            | Not run  | No generated environment; cache retained        |          107 |
| Encrypted thread, initial       | HTTP 429                            | Not run  | No generated environment; cache retained        |          105 |
| Encrypted room, normal resume   | Passed, fresh crypto/public-CLI SAS | Passed   | Passed; detached-list remediation audited below |          405 |
| Encrypted thread, normal resume | HTTP 429 at helper provisioning     | Not run  | No generated environment; cache retained        |            1 |

Final functional totals: **3 passes, 0 functional failures, 1 setup-blocked case**.
Encrypted-room resume completed on 2026-10-17 at 20:55:21Z; its wall time includes
waiting for the server boundary. Encrypted-thread resume stopped at 20:55:22Z with
recorded retry boundary **20:57:25.073Z**. This records the last attempt, not a claim
that the server remains rate limited indefinitely. No further credential retry was
made. Encrypted-thread functionality remains unverified in this run.

The scripted live cases exercise two identified streams, progressive safe Markdown
text edits to original events, post-prompt/after-tool continuation, sequential IDs,
parallel tool terminal statuses and collapse, room/thread routing, raw wire types,
stale-session reset rejection and observable buffered shutdown. The new alternating
thought/text response case is covered by deterministic collectors and SDK-boundary
integration; it is not claimed as a fresh live thought scenario.

The audit found that encrypted-room cleanup omitted its separate reset-detached
session list. `cc708d4` adds that list to the existing ownership-aware cleanup entry
point, matching the other mode wrappers. Its subprocess regression verifies actual
ACP deletion requests for detached sessions, list clearing, retained tokens/crypto
and completed ledger, and removed run files/claim.

Under the shared lock, the existing cleanup helpers then deleted the **two exact
retained encrypted-room scripted ACP sessions** and cleared their list, after
validating successful-run and ready-cache provenance. This targeted remediation
used only the original local scripted ACP command; no production ACP session or
Matrix credential was involved.

Final independent locked audit: all four generated environments/private run roots
are absent; **zero active store claims or bootstrap locks** remain. Eight reusable
token stores are retained, all normally issued during this run because these
profiles were absent. Three encrypted-role crypto stores/manifests and three real
SAS flags are preserved. Three completed-case initialized ledgers remain, with
routes detached and all three session lists empty. Matrix room events remain.

Seven roles are ready. The incomplete encrypted-thread profile retains its issued
bridge token and blocked helper proposal, with the sender unissued and bridge
state intentionally not yet initialized. Preserve those exact identities for any
future normal setup; do not remove stores or switch profiles to evade rate limits.
No reusable device was logged out, no crypto store or delivery ledger was reset,
and no private credentials, account/room identifiers or raw events enter this report.

Real Pi was not run by this agent. Adapter support for stable, sequential response
IDs shared by thoughts/text, including unsolicited output, remains a separate
prerequisite. Scripted ACP, hermetic SDK/crypto integration and loopback HTTPS
fixtures cannot establish that prerequisite. No production service restart,
crypto reset, trust bypass, deployment, push or branch integration was performed.
