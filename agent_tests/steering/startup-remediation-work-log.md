# Startup remediation work log

Agent: `aa-startup-history-remediation`.
Ticket: `tt-steering-fix-live-startup-history-replay-errors`.
Branch: `aa-startup-history-remediation`.
Base: `45e9370ef6140faab5dbcb484ff9524f566fbe40`.

## 2026-10-02

- Read agent/ticket instructions, mandatory waap/repository/secrets skills,
  steering specification, prior live and msg3 reports, harness health guards,
  Matrix classification, coordinator, ledger, and related tests. No repository
  AGENTS.md was found in the workspace or checked ancestor locations.
- Validated central state with `waap check`. Worked only on the launcher branch.
- Checked the required persistent trace path before live operations: absent
  child, root:root 0755 parent, no write ACL for uid 1000. Exact-path
  `mkdir -m 700` failed with permission denied. `sudo -n true` failed with a
  password requirement. No authorized mechanism could provision the directory.
  No alternate directory or permission weakening was attempted.
- Rechecked PR115 with read-only
  `git ls-remote https://github.com/svkozak/pi-acp.git refs/pull/115/head`:
  `d7f9cb2428c992c62aa759919c799c5619a9b10b`. No build or live runtime launched.
- Confirmed offline policy: persisted initialized state recovers unseen eligible
  history intentionally; fresh first response establishes suppression baseline.
  Added two deterministic coordinator/real-ledger tests for room-to-thread
  retained-state recovery and isolated fresh-state suppression, including a
  live-marked first-response event and duplicate/new incremental inputs.
  These establish policy only, not a cause for the deleted-trace live errors.
- Ran `npm ci`. Initial `npm run check` caught TypeScript assertion narrowing
  of a mutable received-event array; corrected the test's empty-array assertion
  to a length assertion. Final full `npm run check` passed formatting, ESLint,
  typecheck, build, and **454/454 tests**, no failures/skips/cancellations.
  `git diff --check` passed. No product/harness behavioral fix was justified.
- Live commands/scenarios: **none**. Inputs/devices/sessions/logins/cleanup
  operations: **0 each**. No lock acquired, external workers started, credentials
  retrieved, canonical environment modified, or production services restarted.
  All local check processes were awaited; hermetic test temporary state cleaned.
- Added sanitized startup remediation report. Existing silent steering, README
  removal, initialized catch-up, first-baseline suppression, harness fail gates,
  and late teardown auditing are preserved. No merge/push/PR comment/ticket
  completion or unrelated-agent mutation.

## Handoff and survival

Commit contains this log, `startup-remediation-report.md`, and the two tests.
Exact commit SHA is recorded in the central WAAP agent work log after committing.
Both repository documents survive worktree removal on the own branch. Central
log is under the assigned agent's `work_log.md`; existing private launcher logs
are at `/home/chad/.local/state/waap/startup-remediation-W96eFsVn`. No private
live failure traces were generated and no remote resources need cleanup.

Concrete remaining prerequisite: administrator provisions
`/home/chad/.local/state/matrix-steering-verification`, chad:chad, mode 0700.
Then perform causal live reproduction under the exclusive process-held flock,
with mode-0600 traces and owned-session/device cleanup. The historical replay
and agent errors remain unresolved; passing offline checks are not a live pass.
Coordinator reviews and integrates this branch; ticket status remains unchanged.

## Resumed worker handoff, 2026-10-02

Agent/branch `aa-startup-history-live-resume`, base `a5c160d`. Reimplemented
actual SDK/coordinator/persisted-ledger coverage and added a forced PREPARED /
incremental response race while initial baseline persistence is awaited. Added a
controlled startup probe, private before/after snapshots and assertion details,
startup activity auditing, device/mode/state isolation preflight and unconditional
awaited ACP teardown after failed bridge exit. Fixed idle-notice assertions to
preserve silent default steering.

Actually reproduced absent-state startup replay on reused devices; HTTP traces
show older initial snapshots followed by pre-existing incremental inputs. Full
thread on new devices passed (six prompts, three injections, two sessions, 16
replies); final full room on new devices passed (five prompts, three injections,
one session, 14 replies). Both had zero RPC errors and zero Matrix failure
markers through teardown. Fresh suppression, initialized mode-transition catch-up
exactly once and quiet initialized restart passed controlled probes. Original msg3
cause remains uncertain; a new startup failure retained upstream EPIPE, whose
specific child-close sequence is not established. Product suppression/catch-up
policy was not weakened.

All live operations held the shared flock. Eighteen reported sessions deleted,
eight temporary devices revoked; scoped locked session listing found zero
remaining Pi sessions. A follow-up locked registry inspection found four owned
entries from unanswered startup requests; their metadata was retained and they
were removed through ACP session/delete. Total 22 owned session IDs cleaned,
zero remaining owned registry entries and listed sessions. Failed/successful
evidence and recovery metadata are
external, 0700 directories / 0600 files. All live children awaited. Full check
passed 459/459 tests plus formatting/lint/typecheck. See the updated remediation
report for exact SHAs, build digest and evidence locations. No shared AGENTS edit,
merge, push, public comment, daemon restart or ticket completion. Coordinator
integration and final combined live verification remain separate.
