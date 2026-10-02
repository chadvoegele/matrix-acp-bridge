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

## Final isolated-branch verification

Verified bridge/harness revision:
`c3166e11ece92e936da9671b527ff4ff572fadd4`.
Exact pi-acp PR115 revision:
`d7f9cb2428c992c62aa759919c799c5619a9b10b`.
The bridge uses pinned `matrix-js-sdk` 42.2.0. Prepared upstream source/build
was retained outside the deleted launcher; no upstream main substitution was
used. Build entry-point SHA-256 digests:

- Bridge `dist/main.js`:
  `cfba191a984dc9bf2cdededac5adf12dbdbc119e51d17e396fcadf4e0a967112`.
- pi-acp `dist/index.js`:
  `edf392fd0b93bd9c17f3ca73d26dd72c43ceb99d4163dfefaa7f22ef2aa75d45`.

Full final `npm run check` passed: formatting, lint, typecheck and all 459 tests.
The snapshot stale-listing regression failed with the old three-retry behavior
and passed with the fix. The helper regressions reject success from ignored
terminal requests or aliases, while preserving rejection as failure.

Fresh temporary-device provisioning and normal SAS passed. After diagnosing and
fixing stale-request helper shutdown, a new real normal SAS exchange also passed
on the already-verified pair: both emoji and decimal matched, helper confirmed,
CLI received interactive `yes`, and both protocol completions succeeded.
No trust override, signature bypass, plaintext downgrade or model change was used.

Actual encrypted thread steering passed on the revision above. It sent nine
inputs and observed sixteen bridge replies, six prompts, three successful
injections and two separate ACP sessions. All **25** checked sent/reply wire
events were `m.room.encrypted`; authenticated decryption and thread-root routing
assertions passed. Explicit prompt FIFO, pending-turn injection durability,
serial steering, idle fallback, independent thread sessions, baseline silence
and default-selected idle silence passed. Exactly two explicit-steering idle
notices were observed. The final health audit saw zero ACP errors or Matrix
failure markers. Success was emitted only after awaited bridge/ACP and sender
teardown. Historical initial-sync decryption failures for earlier devices are
preserved privately and do not constitute plaintext fallback or a successful
assertion on undecrypted content.

## Owned cleanup and evidence

All recovery, provisioning, SAS, encrypted testing and cleanup ran under the
exclusive process-held `/tmp/matrix-acp-bridge-steering-live.lock`. It has been
released. No production service or session daemon was restarted.

Previous-run identity checks matched exactly the three owned temporary devices.
Recovery deleted two owned ACP sessions, revoked all three devices, and removed
active local state. Its original evidence and a private device-state copy were
preserved for review. Final cleanup likewise deleted two owned ACP sessions and
revoked three temporary device tokens. Post-logout identity requests confirmed
HTTP 401 for all three tokens. Active role state, environment and empty device
root were removed; no owned live subprocess remained. Cleanup exited zero.
Only owned temporary resources were touched; room events remain as documented.

Final private evidence:
`/home/chad/.cache/matrix-steering-verification/sas-recovery-20261002`.
Directories are mode 0700 and files 0600. Key files are `sas-fresh.log`,
`sas-final.log`, `sas-lifecycle-private.log`, `sas-repeat-private.log`,
`encrypted-thread-final.log`, `wire.json`, `owned-recovery.log`,
`cleanup-final.log`, `check-final.log` and `regression-before-fix.log`.
Preserved environment, session lists and device-state copies are private,
including revoked tokens; they are intentionally retained through review.

There is no blocker for this assignment. This report verifies the isolated
recovery branch, not a later integrated feature head. The coordinator must
integrate these commits and perform final integrated-head verification. This
agent did not merge shared branches or main, push, comment on a PR, or complete
the ticket.
