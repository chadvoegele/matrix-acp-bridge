# Observed msg3 agent error investigation

Ticket: `tt-steering-investigate-observed-live-msg3-agent-error`.
Agent and branch: `aa-investigate-observed-live-msg3-agent-error`.

The observed error is real. It belongs to a later thread-mode replay of the
historical msg3 input, rather than the room-mode turn that first received msg3.
The exact underlying ACP error remains unknown because the original private
wire traces, diagnostics, and session state were deleted with the live tester's
launcher worktree. Passing scenario snapshots do not explain away this error.

## Retained timeline evidence

Read-only authenticated pagination of the canonical designated plaintext test
room found the exact `msg3-ca0e9d690a3f` input. Only the documented dedicated test
accounts and room were queried. The table uses local aliases instead of private
Matrix event IDs; all timestamps are UTC on 2026-10-01.

| Time         | Event | Observation                                                                                           |
| ------------ | ----- | ----------------------------------------------------------------------------------------------------- |
| 23:04:23.832 | A     | Top-level msg1 with the same run suffix asks for the slow tool turn.                                  |
| 23:04:30.100 | B     | Top-level msg2 input.                                                                                 |
| 23:04:30.315 | C     | Exact user-reported top-level msg3 input.                                                             |
| 23:04:55.697 | D     | Bridge room reply contains both msg2 and msg3 tokens. No thread relation.                             |
| 23:05:17.364 | E     | Idle notice in a thread rooted at the earlier explicit injected input.                                |
| 23:05:17.488 | F     | Idle notice rooted at the earlier explicit idle input.                                                |
| 23:05:17.596 | G     | Idle notice rooted at A.                                                                              |
| 23:05:17.739 | H     | Idle notice rooted at B.                                                                              |
| 23:05:17.871 | I     | `No running turn; message queued as a prompt.` with `m.thread` and both root/reply target equal to C. |
| 23:05:21.896 | J     | `[agent error]` in the thread rooted at B.                                                            |
| 23:05:21.981 | K     | `[agent error]` with `m.thread` rooted at C.                                                          |

Thus C was not sent again to trigger I/K: those outputs explicitly refer back to
C, approximately 47/52 seconds after its original submission, following the
room reply D. Multiple historical top-level inputs acquired new independent
threads together. This is direct evidence of mode-switch/history replay, not a
failure of msg3's initial live injection. D establishes token output, not Pi
consumption guarantees or the original wire outcome by itself.

The previous tester's preserved work log/report records an isolated room rerun
followed by a fresh-state thread attempt with seven `session/new` requests and
one prompt before any new test input. This fits the retained timeline. No
original per-frame timestamps survive to prove which exact process emitted
I/K, or whether it was still starting or stopping when K was sent. The likely
association is that final baseline-aborted thread attempt; it is an inference,
not a surviving process trace.

## What the error does and does not establish

On the recorded bridge candidate `adb01b2`, idle notices precede automatic tracked
prompt conversion. A top-level message in thread mode is an independent
conversation. Startup intake can recover unseen historical events from an
initialized durable state; the initial-sync selector uses the completed-event
ledger and configured age/count limits. Mode changes and isolated state therefore
require a trustworthy baseline. The code also establishes a baseline for a truly
uninitialized first response. The timeline cannot prove why the tester's claimed
fresh baseline admitted these events: initialized state, SDK phase ordering, or
an environment/state mismatch cannot be distinguished after deletion.

`[agent error]` is not the healthy steering-method-error notice (that notice is
`Steering failed; message was not resubmitted.`). In the production bridge,
nonfatal prompt method errors render `[agent error]`; thread session creation
method failure can also render it before a prompt is submitted. The renderer can
also map an unknown turn stop reason to this marker. Fatal transport/protocol
failures close dispatch rather than taking the normal prompt error path.
Accordingly, the retained marker narrows the output path but cannot identify an
ACP error code/message, missing/deleted session, tool/auth problem, or upstream
Pi failure. No specific bridge lifecycle or upstream defect is proven.

The old work log records session cleanup after process shutdown and successful
remote deletion. It does not provide timestamped evidence that cleanup raced
this prompt. No deleted-session race is asserted. Likewise there is no retained
authentication/tool diagnostic supporting those hypotheses.

## Harness changes and checks

The previous runner checked only prompt count at baseline and reported success
before teardown. Its final output comparison excluded events older than its
first new input; frames and events outside scenario snapshots lacked a global
health assertion. These boundaries are insufficient for this observation.

The runner now rejects startup session creation/loading as well as prompts and
steering. It audits every observed incoming RPC error and bridge failure marker
across startup, scenarios, and awaited teardown, and emits `passed` only after
that audit. Private evidence includes frame phase labels and bridge/ACP stderr
for subsequent causal investigations. Existing scenario reply/routing checks
remain. Three focused regressions cover startup sessions without a prompt,
shutdown/untracked RPC errors, and historical-thread Matrix errors outside the
scenario reply snapshot. This is a harness fix; no product files were changed.

These gates are bounded observations, not proof that no later server event can
arrive after the sender is stopped. Initial historical room events remain
excluded by the existing observer; direct retained timeline examination was
necessary here. Private evidence must be retained securely outside disposable
launcher state when a live attempt fails. Logs may contain secrets and private
identifiers and must never be published raw.

The upstream PR115 head was rechecked read-only with `git ls-remote` and remains
`d7f9cb2428c992c62aa759919c799c5619a9b10b`. No new live steering messages or ACP
sessions were created: reconstructing a different isolated run would not recover
the destroyed causal trace for this event. Full `npm run check` passed formatting, ESLint, TypeScript, and all 450 tests
(447 existing plus three focused regressions).

## Cleanup and integration

Three temporary read-only login devices were created and revoked with their own
`/logout` calls. Two preliminary requests returned HTTP 403 because the initial
literal parser retained the canonical room setting's shell escape; using shlex
for those literals corrected the parser and authorized pagination succeeded.
No credentials, raw timeline, private room/event IDs, or decrypted secrets were
printed. All local private query material was removed; no production services,
shared devices/state, room messages, or room history were changed.

Prerequisite only: cherry-pick `5cf0c8fd42bcf87eb0d5d64f93cc46f3716a6ddd` became
local commit `930c77b`. Parent should integrate only the subsequent investigation
commit if it has already integrated the tester's original commit. README section
removal is preserved, and concurrent idle-notice selector/provenance files are
untouched. This child does not merge, push, comment on PRs, or complete the ticket.
