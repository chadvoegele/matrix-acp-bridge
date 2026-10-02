+++
name = "Steering fix encrypted live SAS verification"
creation_date = 2026-10-02T00:17:01Z
status = "completed"
+++

# Fix real encrypted test SAS verification failures

User requests fixing all outstanding PR22 errors. Real encrypted-thread normal SAS verification failed twice with crypto-verification-failed, reason unknown, before steering could run. Read live-verification-report.md, existing encrypted harness/SAS lifecycle contracts, crypto verification code and tests. Diagnose actual cause in harness or bridge/SDK verification event ordering; don't bypass device trust or switch encryption off.

Use WAAP developer Codex gpt-6.1-sol reasoning medium. Launch base feature branch feat/message-delivery-steering. Work only own launcher branch, no shared integration or main merges. Read git-repositories/password-secrets/docker-service-management skills as applicable. Use existing private canonical .env documented test accounts/rooms and nopass_pass.sh; no secret stdout/raw published logs. Actual PR115 compatible pi-acp build required for eventual encrypted steering, upstream main insufficient.

ALL live account/room operations must acquire exclusive process-held flock on /tmp/matrix-acp-bridge-steering-live.lock; startup-replay worker uses same lock. Do not overlap provisioning, SAS, tests or cleanup with another agent. Use isolated temporary devices/crypto stores and test room only. No service restarts, hosting session-daemon changes, shared state/deletion, arbitrary room messages. Clean only owned temporary devices/sessions using documented order. Preserve failure causal diagnostics privately outside launcher worktree (0700 directory /home/chad/.cache/matrix-steering-verification; 0600 files) through review, never commit secrets or raw IDs. A safe fixed diagnostic category may be added to expose cause without leaking raw errors.

Reproduce verifier failure with real Matrix SAS, inspect event phases and SDK runtime changes, and fix root cause with deterministic crypto lifecycle/harness tests. Trust must be established by actual SAS match/accept only; do not auto-trust keys, skip signature validation or weaken fail-closed security. Validate full encrypted startup, decrypt/send, and steering probe or hand successful crypto prerequisite to final validation ticket. Avoid modifying shared steering selector/coordinator/sync areas owned by replay ticket unless necessary; report conflicts. Existing CLI verification/interactive confirmation must remain correct.

Acceptance: documented proven cause and targeted fix, normal live SAS succeeds for temporary devices, encrypted steering actual wire uses m.room.encrypted and correct decrypted/thread routing, full npm run check passes, cleanup succeeds or recovery details preserved. No green claim if actual encryption untested. Commit sanitized report/fixes/tests in own agent branch and maintain WAAP log, hand results to coordinator; don't mark ticket complete or merge/push PR yourself. Bounded reproduction/repair attempts before reporting a concrete unavoidable blocker.
