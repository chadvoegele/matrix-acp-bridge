+++
name = "Steering final full live remediation verification"
creation_date = 2026-10-02T00:17:06Z
status = "pending"
depends_on = ["tt-steering-fix-live-startup-history-replay-errors", "tt-steering-fix-encrypted-live-sas-verification"]
+++

# Revalidate all steering live scenarios after remediation

Depends on startup/history replay and encrypted SAS remediation. User requests all errors fixed in PR22. Use integrated latest feature feat/message-delivery-steering including implicit steering idle silence, strict startup/teardown audits, and remediation commits. Read spec, live reports/investigation, preceding tickets and work logs.

Execute WAAP Codex gpt-6.1-sol medium. Full npm run check, git diff --check, independent spec/security review. Run actual documented private Matrix -> built bridge -> real pi-acp PR115 -> Matrix live tests in plaintext room and thread plus encrypted room/thread as configuration permits. Exact upstream/build/bridge revision must be recorded. Acquire exclusive flock /tmp/matrix-acp-bridge-steering-live.lock through provisioning/run/cleanup to prevent live interference. Credentials safely from documented root .env and nopass_pass.sh; no secrets printed/published. Retain failure traces securely outside disposable agent worktree until reviewed. No production services/restarts or unrelated rooms/history/state removal.

Verify no unexpected baseline session/prompt/steering creation, no RPC or Matrix [agent error] during startup/scenarios/awaited shutdown, correct controlled catch-up behavior, default steer msg1 prompt then msg2/3 serial steering, silent implicit idle and injected, explicit idle notice, prompt FIFO, reset barriers, correct thread identity and encrypted m.room.encrypted actual wire. Strong audits must remain enabled; never narrow observation window to conceal errors. Prevent cleanup/history replay from polluting later modes. Each scenario needs independently controlled startup/state and proper tracking/deletion of all created sessions/devices. Real model compliance not acceptance criterion, wire server acknowledgements are.

If failures remain, fix them with regression tests and rerun, or create bounded further remediation for proven cross-ticket issue. Update sanitized reproducible reports with latest actual successes and unresolved limitations, not just append confusing historical claims. Preserve earlier user-observed error diagnosis honestly; don't retroactively claim destroyed traces prove cause. Include exact session/device cleanup status, safe retained failure evidence location if needed, and command results.

Commit report/harness/fixes only own launcher branch, keep work log; coordinator integrates and rechecks, updates PR22 and tickets after accepted evidence. Don't merge main/PR or mark ticket complete yourself. Ready-for-review recommendation only after actual live coverage passes or explicit unavoidable blockers are stated. No new GitHub PR needed.
