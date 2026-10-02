# SAS and encrypted steering recovery

Recovery agent: `aa-steering-sas-encrypted-recovery-20261002`.
Isolated base: `a5c160d5b31383a6efa4142eac7bf1fb72938585`.
Exact prepared pi-acp PR115 source: `d7f9cb2428c992c62aa759919c799c5619a9b10b`.
This branch is an isolated verification checkpoint; final integrated feature-head
verification remains the coordinator's responsibility.

## Proven retained failures

Private evidence in
`/home/chad/.cache/matrix-steering-verification/sas-20261002T002521`
contains the environment, controller, SAS logs, lifecycle trace and ACP/Matrix
wire evidence. Attempt 1 completed normal matching emoji/decimal SAS. Attempts
2 and 3 displayed SAS and received interactive `yes`, then failed with the
bridge's `database-invalid` category. Attempt 3 records `ENOENT` for the
snapshot staging file on each of the three validation retries. Thus the proven
failure is local database-tree validation racing atomic snapshot publication,
not a SAS mismatch or remote verification rejection. The harness's reason
allowlist obscured the actual category as `unknown`.

Validation now tolerates disappearance of only the exact root snapshot staging
file. It continues validating every remaining entry, including the committed
snapshot. Existing staging files retain owner, permission and symlink checks.
Repeatedly rescanning a busy snapshot writer cannot establish stability; the
bounded old retry could fail on every scan. A deterministic stale-listing
regression exercises that condition, and unsafe committed entries remain
rejected. Trust and manifest attestation still require normal SAS completion.

The retained encrypted-thread run reached six prompts, three successful
injections and two ACP sessions, then failed its idle-notice count assertion.
It observed exactly two explicit-steering idle notices, but the harness
expected three. Default-selected msg1 correctly stays silent. The expected
counts are now one for room mode and two for thread mode, with a regression
that rejects an extra default-selected notice. No selector/coordinator/sync
implementation changes were needed; README removal is preserved.

The fresh run exposed a second harness lifecycle defect during repeat SAS.
Private lifecycle diagnostics show the helper receiving a cancelled request
before the bridge created its new outgoing request. The helper's handler ignored
that terminal request, but its caller resolved the overall attempt on any normal
return and shut down the helper. The bridge then timed out before displaying
SAS. The helper now ends successfully only when its handler explicitly reports
completed SAS verification; ignored terminal requests and aliases leave it
listening. Deterministic regressions cover ignored events followed by valid
completion and fail-closed rejection. This does not relax target or trust checks.

## Live verification

Full `npm run check` passed: formatting, lint, typecheck, and 457 tests. The
new stale-listing regression fails against the old three-retry behavior and
passes with the fix. Previous-run owned identity checks matched all three
temporary devices; cleanup deleted two ACP sessions and revoked the devices,
then removed their active local state. A private copy preserves failure evidence.

Fresh provisioning and normal matching emoji/decimal SAS with interactive yes
passed under the exclusive process-held live lock. Repeat SAS and encrypted
steering are pending at this checkpoint. Prior attempt 1 success is historical evidence, not proof
of this branch or the final integrated feature head. No encrypted pass is claimed
for the earlier failed run.
