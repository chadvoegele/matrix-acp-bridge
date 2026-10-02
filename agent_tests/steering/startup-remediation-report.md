# Startup/history remediation, 2026-10-02

Agent/branch: `aa-startup-history-live-resume`. Base bridge:
`a5c160d5b31383a6efa4142eac7bf1fb72938585`. Work is committed only on the
launcher branch for coordinator integration.

The former exact-directory blocker is resolved: authorized private evidence is
retained under `/home/chad/.cache/matrix-steering-verification/`, outside the
disposable worktree. Directories are 0700 and files are 0600. The prior attempt's
permission failure was real, but administrator provisioning of its original path
is no longer a prerequisite for this ticket.

## Reproduced cause and bounded remediation

Fresh state on previously used Matrix devices is not a clean live-test baseline.
The resumed run reproduced startup replay with an absent state file: after a room
suite, thread startup issued seven session creation requests and two prompt requests before new test
input. Private SDK and wire traces retain the historical payloads, first-sync
classification, absent before-state, resulting state and child diagnostics.
This was not intentional initialized catch-up.

The subsequent isolated-device run established the distinction directly. A full
thread suite passed on newly provisioned devices. Immediately afterward, separate
absent-state room and thread probes using those same devices each created one
session and issued one historical prompt request before input. HTTP traces show an older initial
snapshot followed by pre-existing inputs in incremental responses; SDK requests
correctly chain the preceding `next_batch` into `since`. The adapter/coordinator
suppresses the initial response and admits later incremental input according to
its existing policy. The server's precise caching mechanism is not established
by these traces, and no production server or daemon was changed.

The full scenario runner now records a private device/mode/state baseline beside
the bridge token and rejects changes to its state directory or response mode
before live account operations. Each independent mode requires new temporary
devices and isolated state. Intentional initialized recovery remains supported by
the separate startup probe; no timestamp-based or blanket history suppression was
added to the bridge.

Two other demonstrated harness defects were fixed: idle-notice assertions counted
an extra notice for implicit default steering, and failed bridge startup/exit
could strand ACP. The runner now expects only explicit idle notices, retains
private assertion details and before/after ledger snapshots, captures child
handles before awaiting startup, and stops/awaits ACP even after bridge failure.
The startup audit additionally rejects untracked `session/update` activity.

The first replay failure retained an upstream unhandled `write EPIPE` during
teardown, alongside Matrix agent-error activity. Exact PR115
[source](https://github.com/svkozak/pi-acp/blob/d7f9cb2428c992c62aa759919c799c5619a9b10b/src/acp/agent.ts)
closes other live Pi subprocesses when creating a new session. Its single-live-Pi
policy is relevant to the historical multi-session startup burst; attributing the
specific EPIPE to a particular closed child remains an inference because the
first instrumentation did not capture that child's complete RPC stream. Later
runs capture Pi RPC/stderr as well. No upstream patch or concurrent active-thread
compatibility claim is made.

The original deleted msg3 causal traces remain unavailable. New reproduction
establishes this harness isolation problem, not the original error's exact Pi
cause. The earlier claim that fresh _state_ alone proved a clean baseline is
superseded.

## Actual live outcomes and revisions

Every provisioning, run, mode transition, inspection and cleanup held the shared
process-held exclusive `/tmp/matrix-acp-bridge-steering-live.lock`.

All runs used upstream PR115 `d7f9cb2428c992c62aa759919c799c5619a9b10b`.
The retained 21 source/build-input files match that exact Git object. Build
SHA256: `edf392fd0b93bd9c17f3ca73d26dd72c43ceb99d4163dfefaa7f22ef2aa75d45`.
The normal configured Pi model was used without model substitution.

| Run                                                       | Bridge revision                            | Actual outcome                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial room/reused-device thread attempt                 | `f8e1e148a76b3d28282320692813142db51d8347` | Room reached five prompts/three injections but failed obsolete notice assertion; fresh-state thread startup replayed history and failed. These are retained failed runs.                                                                                                                                              |
| HTTP-instrumented controlled probes                       | `f8e1e148a76b3d28282320692813142db51d8347` | Fresh room suppressed history; stopped-bridge input recovered once after initialized room-to-thread transition; next initialized restart stayed quiet; distinct fresh thread state suppressed history. Wire/Matrix audits passed through teardown. Instrumentation perturbs timing, so this alone is not a fix claim. |
| Full thread on new devices                                | `d86ae487a5706c897572ad86ca6e669d1e8430fb` | Passed: nine inputs, six prompts, three injected steering outcomes, two sessions, 16 replies, zero RPC errors and zero Matrix failure markers. Passive HTTP/Pi traces retained.                                                                                                                                       |
| Final isolated room on new devices                        | `91ebdb32cb863dc18f6f558ae326984946dcec90` | Passed: eight inputs, five prompts, three injected steering outcomes, one session, 14 replies, zero RPC errors and zero Matrix failure markers. Original timing instrumentation; no awaited HTTP tap.                                                                                                                 |
| Reused-device absent-state probes after that thread suite | `d86ae487a5706c897572ad86ca6e669d1e8430fb` | Both room and thread baseline assertions failed with one historical prompt/session; zero RPC errors. This is the positive isolation reproducer.                                                                                                                                                                       |

Every passing result was confirmed from wire outcomes, durable completion and
Matrix output, including the final health audit after awaited teardown, rather
than from runner exit status alone. The isolated thread run preceded the new
device-baseline preflight guard; the final isolated room run includes it. No
encrypted live coverage is claimed by this worker; the parallel SAS worker owns
that work.

## Regression coverage and validation

Full `npm run check` passed formatting, ESLint, TypeScript and **459/459 tests**,
with zero failures, skips or cancellations. `git diff --check` passed.
New coverage exercises the real pinned SDK, coordinator and disk ledger for fresh
room/thread suppression, initialized unseen catch-up, completed-input restart
suppression and a room-to-thread transition. A forced SDK race delivers the next
response while baseline persistence is awaited: initial history stays suppressed
and new incremental input is admitted once and completed durably. Harness
regressions cover device/mode/state isolation, startup session activity and
awaited ACP teardown after failed bridge exit. Existing FIFO, explicit/default
idle distinction, reset, durable completion, encryption and authorization tests
remain passing. The removed root README section and shared AGENTS guidance were
not changed.

Private failed and successful evidence remains in `startup-resume`,
`startup-resume-http`, `startup-resume-isolated`, `startup-resume-final-room`,
`startup-resume-recovery` and `startup-resume-recovery-map` beneath the evidence
root. Failed traces are retained for causal review. All four controllers completed
cleanup with exit 0: **18 reported owned ACP sessions were deleted and eight
temporary Matrix devices revoked**.

Four initial session-creation requests lacked successful responses; a subsequent
lock-protected `session/list` inspection scoped exactly to the four private
scratch directories found **zero remaining listed Pi sessions**, including zero
listed orphans. A second locked inspection of the adapter registry found **four
additional owned entries** for the unanswered startup requests, with no remaining
Pi session files. Their scoped registry metadata was retained privately, and all
four were removed through supported ACP `session/delete`: **22 owned session IDs
cleaned in total**, zero remaining listed sessions and zero remaining owned
registry entries. Recovery would archive owned session files before deletion;
none were present.

Owned-session/device lists, per-mode ledger snapshots and failed wire/SDK/child
evidence remain private. Local live children and cleanup processes were awaited,
and no active owned recovery resources remain. Original room history remains; no
room or shared device/history
was deleted. No merge, push, PR comment, service restart or ticket completion was
performed. Coordinator integration and final combined live validation remain
separate work.
