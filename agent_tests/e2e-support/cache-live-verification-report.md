# Persistent-cache final live verification

Chad's Agent completed validation for PR24 without merging. Functional code
tested: `5a82d0cc077811cbcb7d1817006e8d63e68b03c1`. A later report-only commit does not change tested code.

`npm ci` and full `npm run check` passed: formatting, lint, typecheck/build,
525 automated tests, zero failures/skips. The final production source remains
exactly the inherited PR24 refactor; this follow-up changes test lifecycle and
harnesses.

## Setup and functional results

Fresh persistent encrypted room and thread profiles ran the public crypto
bootstrap CLI and real decimal/emoji SAS comparison and confirmation on
`f48985d` and `0e288fb`, respectively, before functional validation.
All functional cases below reran on the final revision with those original
verified snapshots and tokens, including corrected production-format preflight.
No local trust bypass or established-store reset occurred.

A separate final-revision disposable fresh crypto/SAS setup test passed using
three genuinely new owned devices and original fresh stores; all three devices
were revoked. Partial issuance was retained across legitimate retry windows
without repeating password login for any already-issued role.

| Case                                                              | Setup  | Function       | Cleanup |
| ----------------------------------------------------------------- | ------ | -------------- | ------- |
| Fresh disposable public-CLI crypto/SAS setup                      | PASSED | NOT_APPLICABLE | PASSED  |
| encrypted-room-activity                                           | REUSED | PASSED         | PASSED  |
| encrypted-room-normal                                             | REUSED | PASSED         | PASSED  |
| encrypted-room-steering                                           | REUSED | PASSED         | PASSED  |
| encrypted-thread-activity                                         | REUSED | PASSED         | PASSED  |
| encrypted-thread-normal                                           | REUSED | PASSED         | PASSED  |
| encrypted-thread-steering                                         | REUSED | PASSED         | PASSED  |
| plaintext-room-activity                                           | REUSED | PASSED         | PASSED  |
| plaintext-room-completed-id-recovery                              | REUSED | PASSED         | PASSED  |
| plaintext-room-normal                                             | REUSED | PASSED         | PASSED  |
| plaintext-room-persistence                                        | REUSED | PASSED         | PASSED  |
| plaintext-room-reset                                              | REUSED | PASSED         | PASSED  |
| plaintext-room-startup                                            | REUSED | PASSED         | PASSED  |
| plaintext-room-steering                                           | REUSED | PASSED         | PASSED  |
| plaintext-thread-activity                                         | REUSED | PASSED         | PASSED  |
| plaintext-thread-normal                                           | REUSED | PASSED         | PASSED  |
| plaintext-thread-steering                                         | REUSED | PASSED         | PASSED  |
| Fresh plaintext startup and room-to-thread initialized transition | PASSED | PASSED         | PASSED  |
| Configured real ACP activity metadata                             | REUSED | PASSED         | PASSED  |

Normal thread cases retain their documented transport-specific scope: plaintext
checks concurrent roots, lazy restart/load, reset/sessionless restart and unknown
thread rejection; encrypted checks authenticated root/follow-up relations and
same-session reuse. Activity requires original/edit routing and wire types.
Steering covers all four transport/mode combinations, actual injection while
a prompt is pending, FIFO overrides, idle fallback, durable completion, and
startup/shutdown RPC/Matrix health audits. Encrypted steering additionally audits
raw room history for plaintext leakage.

The initialized startup case contains send/catchup/quiet/reset with retained
session preconditions. The separate fresh profile proves zero startup ACP work
and recovery of one controlled input after changing room mode to thread mode.
Real activity uses the configured test endpoint and an owned remote scratch
directory; it checks write/read/edit/bash and full required ACP metadata.

Pinned isolated steering/persistence runtime: upstream PR115
`d7f9cb2428c992c62aa759919c799c5619a9b10b`, build SHA256
`edf392fd0b93bd9c17f3ca73d26dd72c43ceb99d4163dfefaa7f22ef2aa75d45`,
isolated Pi 0.87.1 agent/settings/session directory. Production services,
settings, devices and sessions were not changed.

## Earlier failures and recovery

HTTP429 blocked one-time credential issuance at several legitimate windows.
Each issued role was retained and never logged in again; blocked roles retried
the same proposed device only after the recorded server boundary. Final setup
and function results replace those earlier BLOCKED/SKIPPED attempts; no blocked
attempt is counted passed.

Initial activity included delayed older room events; observations now require
finite server timestamps and scope to the current input while preserving exact
counts and routing assertions. Initial steering awaited only the last injected
input; it now waits for every tracked/injected terminal completion and actual
reply before exact assertions. Dormant profiles legitimately recovered inputs
sent by another mode: grouped tests warm through actual production recovery,
track/delete warm-up sessions and preserve the ledger. The unknown-root fixture
now honors bounded HTTP429 timing using the identical transaction ID.

The inherited crypto preflight expected JSON despite the production V8 binary
snapshot. It now uses V8 deserialization, requires a bound database with nonempty
core records, permits absent optional passphrase metadata, and reports
content-safe corruption errors; real stores were preserved. The isolated local agent's first real-activity
attempt lacked terminal metadata; the configured test endpoint provided the
required complete coverage in the final supplementary run.

## Retention and cleanup

All run-owned ACP sessions and local/remote scratch were cleaned. Disposable
fresh devices were revoked; reusable Matrix devices were never logged out.
The private persistent cache is outside Git/worktrees at
`$HOME/.local/state/matrix-acp-bridge/test-cache`, with separate profile identity,
room/transport/mode/role bindings, authenticated device checks, atomic private
files, bootstrap locks and per-run store leases.

Final read-only audit: 12 retained tokens authenticate with matching
users/devices, token/state permissions are 0600/0700, no active leases or ACP
session mappings remain, and token bytes do not appear in current private logs
or traces. Original crypto manifests/snapshots and completed-event ledgers stay
paired with their devices. Private evidence/recovery records remain outside
disposable worktrees; public reports contain no Matrix identifiers or traces.

No verification blockers remain. PR24 is open and unmerged for Chad's review.
