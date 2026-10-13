# Live Matrix steering verification, 2026-10-01

The live **plaintext room** path passed: actual Matrix homeserver → built bridge
CLI → real pi-acp PR115 → Pi → Matrix. This is partial live coverage. Encrypted
coverage is blocked by normal SAS verification failures; plaintext thread coverage also passed, as recorded below. No production services were restarted.

## Revisions and runtime

- Launcher branch: `aa-fef64b71`; committed result is recorded in the WAAP work log.
- Bridge source: `adb01b26f195b6c90149255046b49d7378744208`, the PR22 feature
  candidate with the README section removal preserved.
- pi-acp PR115: `d7f9cb2428c992c62aa759919c799c5619a9b10b`, fetched with
  `git fetch https://github.com/svkozak/pi-acp.git refs/pull/115/head`.
  All 75 tracked upstream files matched the existing private build's source.
- Reused `dist/index.js` SHA256:
  `edf392fd0b93bd9c17f3ca73d26dd72c43ceb99d4163dfefaa7f22ef2aa75d45`.
- Node `v26.9.0`; Pi `0.87.1`. Actual ACP session model:
  `openai-codex/gpt-5.6-sol`, with 10 models advertised. Real tool execution and
  completed replies established availability; no model substitution was made.
  This Pi runtime model is separate from the developer agent's launch settings.

The canonical mode-0600 `.env` was inspected privately. Literal settings were
parsed without sourcing its shell code. Both documented test account passwords
were retrieved directly with `nopass_pass.sh`. An isolated scratch directory
and the verified PR115 stdio build replaced the configured hosted ACP transport
for these test processes. Test accounts and designated rooms were reused;
bridge and sender devices were newly provisioned. The bridge used its production
`dist/main.js` CLI, normal Matrix sync, and the existing unchanged duplex taps.

## Live plaintext room observations

The bridge reached `startup-ready` and the sender established initial sync before
new Matrix events. Initial history was excluded from live observations.

| Scenario                                           | Live observation                                                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit `/prompt` starts a real turn              | One `session/new`, then pending `session/prompt`; real Pi tool execution observed                                                        |
| `/steer` during that turn                          | `_session/steering` returned `injected` while the original prompt remained pending; no second prompt or success notice                   |
| Two `/prompt` overrides queued during turn         | Neither started before injected steering resolved; both later ran in FIFO payload order                                                  |
| Idle `/steer`                                      | Original Matrix input became one tracked prompt; expected visible idle notice                                                            |
| Default steering msg1/msg2/msg3, same conversation | msg1 started one tracked prompt; msg2 and msg3 were delivered as serial steering RPCs with `injected` outcomes                           |
| Matrix output                                      | Five completed real prompt outputs each matched exactly one Matrix reply; other outputs were tool activity and expected fallback notices |

Totals: **8 live Matrix input events, 1 ACP session, 5 tracked prompt requests,
3 steering requests, 3 injected outcomes, 0 ACP error responses, 15 bridge
Matrix text events**. These comprise five final agent replies, eight tool
activity originals/edits, and two idle-fallback notices. Every steering request
contained `_meta.steering.idleBehavior = "promptRequired"`. Real tool calls were
observed in both intentionally slow turns. Acceptance was determined from wire
responses, independently of model obedience.

Session-setup text notifications outside pending prompt intervals were excluded
from turn-output checks. This report does not claim Pi consumption
acknowledgements or immediate interruption; `injected` acknowledges native
steering acceptance.

## Thread and encrypted coverage

Plaintext thread provisioning completed after a several-minute second-account
login delay. A preliminary live run completed six prompts and three injections,
but its output assertion incorrectly treated multiple text groups and thought
activity as one final reply. Private trace inspection found seven correctly
routed text groups and no product defect. The runner was corrected, then rerun
live with the same isolated test devices and fresh thread roots.

The rerun **passed**: **9 input events, 6 tracked prompts, 3 steering requests,
3 injected outcomes, 2 new independent sessions, 17 Matrix replies** (six text
replies, eight tool activity events, three idle notices). All original-thread
follow-ups used the original session; the independent top-level `/steer` created
a different session and its own output thread. Wire outcomes, serial ordering,
FIFO overrides, fallback notice counts, and exact text-group routing passed.
The independent thread was created after the earlier turn completed; this run
does not claim concurrent active-thread isolation beyond session/root routing.

Three temporary devices were provisioned for the encrypted thread suite and
crypto stores bootstrapped. The normal documented SAS verifier was run twice:

1. bridge verification failed with `crypto-verification-failed` during
   `bridge-verification`; bridge exited 1, diagnostic reason `unknown`;
2. bounded retry failed with the same diagnostic during `bridge-started`.

No trust bypass or encrypted steering test followed those failures. Therefore
**encrypted room and encrypted thread steering have no live pass**. The concrete
missing prerequisite is successful normal SAS verification for the temporary
bridge device. The existing verifier exposes only the sanitized diagnostic
above, so no narrower cause is asserted.

Unsupported-agent fallback, unknown threads, and unauthorized senders were not
sent as live fixtures. Their existing hermetic regression coverage remains
separate from the live room results.

## Reproduction and validation

See [README.md](README.md) for runnable provisioning, SAS, runner, and cleanup
commands. This run used a private environment loader to parse the canonical
settings and retrieve passwords without exposing them. Principal commands:

```sh
npm ci
npm run build
node agent_tests/unencrypted-e2e/provision.mjs
STEERING_EVIDENCE_FILE=node_modules/.live-steering/plaintext-room.json \
  node agent_tests/steering/live-matrix.mjs \
  agent_tests/unencrypted-e2e/environment.json plaintext room
node agent_tests/unencrypted-e2e/cleanup.mjs
node agent_tests/thread-sessions/encrypted-provision.mjs
node agent_tests/thread-sessions/encrypted-verify-sas.mjs
node agent_tests/thread-sessions/encrypted-cleanup.mjs
npm run check
```

The first room live run preceded stricter text-group, serial-order, and durable
completion assertions added to the reusable runner. Initial trace inspection
confirmed exact output counts and steering ordering. The corrected harness's
thread run passed live. A room rerun using retained thread state was invalidated by startup recovery:
one previous independent-thread event was recovered into room mode before the
current prompt. Its counts were therefore not used as a scenario pass. The
runner now checks for recovered prompts before sending new events and consults
the completed-event ledger directly, rather than accepting a matching ID in a
thread mapping.

The corrected **isolated room rerun passed**: 8 inputs, 5 prompts, 3 injected
steering outcomes, 1 new session, 15 Matrix replies. It additionally verified that
the injected event was durably complete while the original prompt was still
incomplete. The same temporary devices were reused with fresh private state.
Every prior session ID was preserved in the documented additional-session list
for ordered cleanup. A final fresh-state thread attempt was stopped by the new baseline guard **before
sending any new Matrix input**: startup produced seven `session/new` requests
and one `session/prompt`. Those are startup observations, not live scenario
coverage. The earlier corrected thread scenario run passed, but the final
runner's stricter zero-recovery baseline prerequisite was not satisfied. This
requires further diagnosis of SDK/history/recovery behavior; no narrower
steering defect or fix is asserted from this attempt. All startup-created
session mappings were retained for cleanup. Further retries were stopped after
this concrete baseline blocker.

The initial full project check passed **447/447 tests**, including hermetic
Matrix, wire-contract, cleanup, thread, and encryption regressions. A concurrent
check during live testing stopped at Prettier because generated private bridge
state is not formatted. The post-cleanup full check passed **447/447 tests**, along with formatting,
ESLint, and TypeScript checks.

## Cleanup and retained artifacts

Plaintext room cleanup deleted its ACP session, revoked both temporary Matrix
devices, and removed the suite environment and device state. Encrypted cleanup
revoked all three temporary devices and removed environment and crypto state;
no encrypted ACP session was created. Final plaintext cleanup deleted **11
retained ACP sessions**, including all retained sessions created during the
baseline-aborted attempt, revoked the remaining two devices, and removed the
suite environment/device state. Together with the original room session, **12
retained sessions were deleted**. Two startup thread records had no session ID;
these are not counted as created/deleted sessions. Extra isolated local state
was removed only after remote cleanup succeeded. All seven temporary devices
across these suites were revoked. No recovery metadata requiring another cleanup
attempt remains. The first room runner's bridge/ACP
processes exited and the runner was awaited; SDK background timers delayed its
natural exit. The final runner explicitly ends only after child exits and sender
shutdown have been awaited.

Raw event IDs, ACP frames, SDK diagnostics, and provisioning logs remain only in
ignored private `node_modules/.live-steering/` files while this worktree exists;
they will disappear when the launcher removes the worktree. No private
identifiers or credentials are included here. Observed room events remain in the designated Matrix room. Per-attempt
observations were: initial room 8 inputs/15 outputs; preliminary thread 9/22;
corrected thread 9/17; mode-switch room attempt 4 inputs/4 recent bridge events (plus 17 older
history events observed after sync); isolated
room 8/15; final baseline-only thread attempt 0 new inputs, with 27 historical events
observed during the baseline. These are
observation counts, not a claim that cancellation/recovery emitted no additional
room events during shutdown. Startup-created sessions and recovery input are
separate from new scenario input. Crypto
bootstrap/SAS can also leave account-level key/device messages; those were not
counted as room steering events. No shared history or room was deleted.

No bridge steering defect was found in the passing room and thread scenarios. The added
runner and documentation make this evidence reproducible; they do not mark the
WAAP ticket complete. Coordinator review, integration, and remaining blocked
live coverage are still required.

## Startup/history follow-up, 2026-10-02

The resumed [startup remediation](startup-remediation-report.md) supersedes the
fresh-state-only baseline prerequisite above. Reused devices can deliver an older
initial snapshot followed by pre-existing inputs in incremental sync. A truly
isolated mode now requires new temporary devices and fresh state; the runner
records and checks that device baseline before live operations. Intentional
initialized catch-up remains covered separately and is not suppressed.

The full isolated thread suite passed against bridge
`d86ae487a5706c897572ad86ca6e669d1e8430fb`: nine inputs, six prompts, three
injections, two sessions, 16 replies, zero RPC errors and zero Matrix failure
markers. The final isolated room suite passed against bridge
`91ebdb32cb863dc18f6f558ae326984946dcec90`: eight inputs, five prompts, three
injections, one session, 14 replies, zero RPC errors and zero Matrix failure
markers. Both used exact upstream PR115
`d7f9cb2428c992c62aa759919c799c5619a9b10b`. Notice counts now correctly include
only explicit idle steering: one in room mode and two in thread mode. Default
steering remains silent when idle. These supersede the earlier extra-notice
expectations, not the historical observations recorded above.

Fresh room/thread suppression, initialized room-to-thread catch-up exactly once,
and a quiet completed-input restart also passed controlled live probes. A
positive replay reproducer using absent state on reused devices is retained as a
failed run. New private evidence lives outside disposable worktrees. All resumed
controllers completed owned-resource cleanup, and a locked scope-specific session
inspection found no remaining listed sessions. A further adapter-registry check
found four owned orphan entries from unanswered startup requests and deleted them
through ACP; their recovery metadata remains private. Both scoped inventories
are now empty. Full check passed 459 tests. See the
remediation report for exact revisions, timing limitations, original msg3
uncertainty, retained evidence and coordinator handoff. This worker adds no
independent encrypted live result.
