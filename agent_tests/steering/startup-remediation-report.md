# Startup/history remediation, 2026-10-02

Live diagnosis is blocked by the required private evidence directory. This
change adds two offline regression tests; it does not claim to fix or reproduce
the historical agent errors.

## Prerequisite blocker

The required directory `/home/chad/.local/state/matrix-steering-verification`
does not exist. The executing user is `chad` (uid/gid 1000). Its parent
`/home/chad/.local/state` is owned by root:root, mode 0755, with only the
ordinary owner/group/other ACL entries. Creating the child with `mkdir -m 700`
returned `Permission denied`; `sudo -n true` returned `a password is required`.
No authorized provisioning mechanism was available in this session. Parent
permissions were not changed, and no alternate evidence directory was used.

An administrator must provision that exact directory owned by chad:chad with
mode 0700 before a live retry. Verify its ownership and mode, and retain trace
files with mode 0600. The agent instructions prohibit live operations when this
prerequisite cannot be met. There were **zero live scenarios, Matrix inputs,
account logins, temporary devices, ACP sessions, or live cleanup operations** in
this attempt. No live lock was acquired because no such operations were run.
Future provisioning, runs, account/room operations, and cleanup must all hold
the process-held exclusive flock `/tmp/matrix-acp-bridge-steering-live.lock`.

## Offline findings and scope

Starting revision: `45e9370ef6140faab5dbcb484ff9524f566fbe40`.
Own launcher branch: `aa-startup-history-remediation`. Reviewed the authoritative
steering spec, existing live and msg3 investigation reports, live harness and
health guards, Matrix event classification, sync coordinator, and durable ledger.

The coordinator uses the persisted `initialized` bit to distinguish first
baseline establishment from restart catch-up. A truly fresh first initial
response is recorded as completed history, including events already marked live
while crossing PREPARED. An initialized first response intentionally selects
unseen authorized events subject to age/count limits and promotes them to live
catch-up input. The completed ledger is scoped by room/event, while state
identity includes homeserver/user/device, not response mode. Changing response
mode alone therefore does not establish a fresh baseline or erase completion.

Two added deterministic tests use actual private state persistence and a fake
bridge intake boundary:

- A room-to-thread restart suppresses completed room inputs and intentionally
  recovers an unseen historical top-level input with catch-up metadata.
- Isolated fresh thread state suppresses both non-live history and a live-marked
  first-response event, persists their completion, suppresses its incremental
  duplicate, and admits a genuinely new incremental input.

These tests establish coordinator/ledger policy, not real SDK scheduling or ACP
session/prompt success. Existing adapter tests cover initial classification and
late decryption; existing harness tests reject startup sessions, untracked RPC
errors, and historical-thread Matrix failure markers. Existing late teardown
health auditing and fail gates are preserved. No product or harness behavior
was changed. Silent default steering and the README section removal remain.

The original replay and Matrix error markers remain established observations
from the prior reports. Initialized catch-up, incorrect state selection, and SDK
phase ordering cannot be distinguished for that run after its causal traces
were deleted. No specific ACP error, deleted-session race, authentication/tool
failure, or Pi defect is asserted. A future retry must capture startup before
input, record state initialization and completed-ledger baselines privately,
compare fresh and initialized state, and inspect actual RPC error frames through
awaited teardown before claiming remediation.

Read-only `git ls-remote https://github.com/svkozak/pi-acp.git refs/pull/115/head`
returned `d7f9cb2428c992c62aa759919c799c5619a9b10b`, matching the prior verified
PR115 revision. No upstream build was run and no build digest is claimed here.

## Validation and retained evidence

Full `npm run check` passed formatting, ESLint, TypeScript, and **454/454 tests**
(452 existing plus two new coordinator regressions), with zero failures,
skips, or cancellations. `git diff --check` also passed. No raw
failure traces or secrets were generated. This report and the committed work
log survive launcher removal in the own branch; the WAAP agent work log also
survives in central state. The existing private launcher log directory is
`/home/chad/.local/state/waap/startup-remediation-W96eFsVn`.

All local test processes were awaited and hermetic temporary state removed by
the tests. No external workers were started, remote resources require cleanup,
or production services were restarted. No merge, push, PR comment, or ticket
completion was performed. Coordinator integration and live causal diagnosis
remain outstanding.
