# Outbound overflow harness

Read the entire [shared setup, authentication and cleanup contract](../e2e-support/README.md)
first. Use only designated test accounts/rooms and the trusted canonical ignored
environment, not a worktree environment. After sourcing it without printing secrets:

```sh
npm ci
npm run check
# Explicit private, isolated scripted profile; reuse its original state on reruns.
export E2E_AUTH_MODE=cache
export E2E_CACHE_DIR=/private/overflow-cache
export E2E_CACHE_PROFILE=scripted-overflow
export E2E_LIVE_REPORT_DIR=/private/new-overflow-report
node agent_tests/e2e-support/live-all.mjs --list
node agent_tests/e2e-support/live-all.mjs plaintext-thread-overflow encrypted-thread-overflow
```

Use absolute private paths outside the checkout; report directories must be new.
Cached devices require the designated passwords only on first issuance, then reuse
their original tokens/crypto/ledgers. Preserve the existing overflow profile when
rerunning; do not move or copy credentials. Token/password modes follow the shared
contract, with separate scripted thread profiles. Cache mode refuses an unset or
default profile name; an explicit name does not by itself prove safe ownership.
Never select a profile with unfinished real, activity or other fake-peer sessions.

Equivalent single-case entry points:

```sh
sh agent_tests/test_outbound_overflow/test.sh plaintext
sh agent_tests/test_outbound_overflow/test.sh encrypted
```

Both delegate to the serial controller, not a second orchestration path. It holds
the nonblocking shared live lock through provisioning, recovery, function and
ownership-aware cleanup. Existing thread provisioning and encrypted verification
paths are reused. Run checks/build first: unlike profile setup shell scripts, the
serial controller does not install/build. No full real-Pi aggregate is required
or authorized by these commands.

## Dispatch and evidence

The two named cases are discoverable with `--list`, but **explicit-selection only**.
The default aggregate uses real/activity profiles and cannot safely switch a
cached active session to this different fake peer. Selection installs the absolute
local `peer.mjs` command before provisioning; recovery and cleanup use that same
command recorded in the private environment. No configured Pi command is invoked
by these cases. Cases remain transport/mode ordered and recovery is keyed by peer
as well as profile. Recovery failure means setup failed, function skipped.

Each case directory contains `suite.log`, `result.json`, `profile-recovery.json`,
`overflow.json` and `overflow.json.diagnostics`; controller totals are in
`results.json`. Setup, function and cleanup are independent. Exit 0 means all
selected gates passed, 2 means blocked setup, 1 means failure or retained resources.
Logs/reports may contain identifiers; publish only sanitized summaries.
`E2E_OVERFLOW_REPORT` is set by the controller, not needed from the caller.

## Method and boundaries

```text
named case / shell wrapper -> serial controller -> thread provisioning / SAS
                                              -> same-peer profile recovery
                                              -> finite scripted ACP
                                                   -> production bridge / SDK
                                                   -> real Matrix -> observer
                                              -> ownership-aware cleanup / results
```

Only the generated private test config changes: activity-event and queued-turn
limits are each 1 (shared pending capacity 2, plus an active publication). Two
finite bursts each emit 24 distinct complete message IDs plus a sentinel to flush
the last identity. There is no artificial send delay, proxy or production hook.

Assertions retain accepted output, require some distinct IDs to be absent, and
recheck absence after bounded 2.5-second observations. The first burst waits for
recovery diagnostics; inside cooldown the next burst waits for its first accepted
output, not the sentinel (which may legitimately be dropped). Subsequent fresh
output assertions establish recovered admission, not sentinel delivery. The exact capacity notice
appears once in the congested thread across two bursts inside cooldown. Fresh
outputs in both that thread and a second thread must route to their own roots;
two prompts/sessions, one initialization and zero cancellations establish no
restart/reset/resubmission escape. Diagnostics must show dropping and recovery.
All observed events have raw wire checks: plaintext messages or authenticated
encrypted events with the fatal decryption gate. Initial encrypted cache setup
uses public-CLI bootstrap and real decimal/emoji SAS; retained verified cache
reuse validates original crypto, not a fresh SAS exchange on every run.

This uses a deterministic scripted ACP, not the real Pi adapter. It does not
certify Pi provenance/message/thought IDs, mixed activity pressure, cooldown
expiry/new notices, indefinite non-delivery or the historical incident's cause.

## Cleanup and interrupted runs

Cleanup deletes exact tracked ACP session IDs, detaches mappings through the
production state store and preserves initialized ledgers, reusable devices and
crypto. Only owned disposable devices are revoked. Matrix events remain.

On interruption or retained cleanup, keep the environment, claims, session lists,
cache and evidence. Confirm owned clients stopped; under the same shared lock,
recover using the environment's **original** local peer command and the matching
`test_thread_sessions/plaintext-cleanup.mjs` or `encrypted-cleanup.mjs` with that
environment path. Do not clear claims/ledgers, replace devices, switch peers, or
bypass login retry boundaries to force a pass. Follow shared recovery instructions
if original state is missing.

## Automated checks

```sh
node --test agent_tests/e2e-support/suite-layout.test.mjs agent_tests/test_outbound_overflow/*.test.mjs
```

The colocated producer and dispatch tests are also discovered by `npm test`.
Controller subprocess fixtures test both transports, SAS dispatch, original fake
recovery/cleanup, failed recovery classification and wrapper selection without
real credentials, Matrix or Pi. They are not live encrypted/SAS evidence.
