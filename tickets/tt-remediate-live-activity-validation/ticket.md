+++
name = "Remediate live activity validation"
creation_date = 2026-09-27T13:28:00Z
status = "in-progress"
depends_on = ["tt-agent-tests-and-live-matrix-validation"]
+++

# Fix and rerun live ACP activity tests with available credentials

PR #11 already exists on `feat/verbose-acp-output`; DO NOT create another PR or merge it. A real scripted plaintext E2E run has now been attempted using the ignored `.env` at the canonical repository root (parent of `main` and feature worktrees). Prerequisites were present and provisioning succeeded, but `agent_tests/unencrypted-e2e/activity-wire.mjs` failed at `scripted ACP final message did not arrive` after its wait. The private run log is `/tmp/verbose-plaintext.E2jTHV` (0600); do not copy its contents into commits/PR and avoid exposing IDs/secrets.

Work:
1. Reproduce safely in `feature-verbose-acp-output` by sourcing the canonical root `.env` with `set -a` and no trace/echo; never print credentials. Confirm no prior environment.json remains. The test wrapper cleans up devices/sessions/state. Diagnose whether the final message was emitted but missed by Matrix sync, the scripted ACP peer hung, the bridge dropped a boundary, or another product bug. Fix product behavior or test harness as evidence requires; add regression tests.
2. Run `npm run check`, plaintext scripted activity, encrypted scripted activity (same root env), and, if safe and configured, optional real-agent activity using its ACP-visible scratch path and correct remote cleanup command. The real test must clean its scratch file and provisioned devices even on failure. Keep precise sanitized results in work log. If one live test is externally blocked, state exact reason; do not claim pass.
3. Push fixes to EXISTING feature branch and update the body of PR #11 with verified live results or remaining limitations, marked "Chad's Agent" in any human-facing PR comment. No merge. Sign commits if available.

Acceptance: the scripted plaintext test passes or a justified external blocker is demonstrated; same for encrypted and real tests where prerequisites permit. No secrets/IDs/paths from private traces in PR or tracked files.
