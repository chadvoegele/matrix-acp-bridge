# Token-first live harness verification

Implementation preserves PR24's reset refactor (`7aced71`) and integrates the
prior durable completed-ID bound and valid unknown-thread fixture corrections.
Token mode uses supplied device-bound test tokens, authenticated identity/device
checks and persistent per-device state; it makes no `/login` calls. Reusable
credentials/devices/crypto are never revoked or deleted by automatic cleanup.
Owned ACP sessions are deleted and application mappings detached while retaining
the initialized delivery ledger. See [the operational contract](README.md).

## Validation on 2026-10-04

`npm ci` and `npm run check` pass; the final implementation has 511 passing tests,
zero failures/skips, plus formatting, lint, typecheck and build checks. Tests cover
partial/empty auth selection, required credentials, identity/expired-token errors,
store bindings/claims, retained crypto/server keys, cleanup ownership and failures,
and delayed old reset notices versus new scenario events.

Live runs held the shared lock and used the recovered, explicitly test-created
plaintext room device pair with its original initialized delivery state. Every
run removed password variables and installed a private network guard forbidding
login/logout. All completed run summaries report zero login/logout requests and
successful ACP cleanup. Raw evidence, identifiers and credential files remain
private outside disposable worktrees.

| Tested commit | Scenario                                        | Outcome                                                                                                                                                                                                            |
| ------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `90bc307`     | Plaintext room normal/restart, configured ACP   | Pass: exact Markdown response, two exchanges, completed-input suppression.                                                                                                                                         |
| `90bc307`     | Plaintext room `/reset`, configured ACP         | Pass: separate sessions, exact acknowledgements and retained-ID cleanup.                                                                                                                                           |
| `90bc307`     | Persistence, configured ACP                     | First memory exchange completed; fresh-baseline diagnostic assertion was obsolete for initialized token state. Corrected in `5298670`.                                                                             |
| `5298670`     | Corrected persistence, configured ACP           | Failed exact acknowledgement: agent returned a different marker; input was durably completed. Offline-memory assertions were not reached.                                                                          |
| `f6b577a`     | Plaintext room live steering, isolated PR115/Pi | Pass: five tracked prompts, three injections, zero RPC errors and full health audit.                                                                                                                               |
| `f6b577a`     | Initialized send/catch-up/quiet probes          | Pass: controlled unseen input completed, subsequent restart did no ACP work.                                                                                                                                       |
| `f6b577a`     | Initialized steering reset after those probes   | Failed notice count: retained evidence proves an older steering notice was observed again during incremental sync. Scoped reset observations were corrected in `a3e4ecc`; full failure audits remain.              |
| `a3e4ecc`     | Standalone reset retry                          | Invalid fixture: cleanup had detached the initial room mapping, so initial plus replacement creation yielded two sessions. No bridge regression inferred; documented warm-up retains the required initial session. |
| `a3e4ecc`     | Strict persistence, isolated PR115/Pi           | Pass: exact memory acknowledgement, offline input, original-session load before prompt, exact remembered value and completed-input suppression.                                                                    |

The isolated upstream build is pi-acp PR115 revision
`d7f9cb2428c992c62aa759919c799c5619a9b10b`, with entry SHA256
`edf392fd0b93bd9c17f3ca73d26dd72c43ceb99d4163dfefaa7f22ef2aa75d45`, and Pi 0.87.1.
It used separate private agent/session directories and scratch workspaces;
production services/settings were unchanged. Live results validate the listed
commits and scenarios, not every harness mode. Later documentation changes and removal of an unused cleanup option leave
those tested behaviors unchanged.

## Remaining coverage and cleanup

Encrypted room/thread SAS and encrypted-wire scenarios remain unrun on token
mode: approved bridge/helper/sender token-device pairs and their original
bootstrapped stores are unavailable. Plaintext thread validation also requires a
separate profile; the recovered room devices are deliberately bound to room mode.
Do not copy tokens, replace state, or bypass bindings to run another mode. The
historical eight live passes from the prior validator do not validate this change.
Other plaintext activity/completed-ID scenarios were not rerun here.

Per-run environments/configs and new local/remote scratch directories were removed
on successful cleanup. The prior interrupted remote scratch directory was already
absent and its empty local counterpart was removed. The recovered reusable tokens,
original initialized delivery ledger, profile bindings and private recovery evidence
are intentionally retained. No reusable credentials were logged out. Missing live
profiles require operator-supplied paths, not password retries or production tokens.
