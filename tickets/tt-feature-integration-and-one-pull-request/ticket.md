+++
name = "Feature integration and one pull request"
creation_date = 2026-09-27T12:20:07Z
status = "in-progress"
depends_on = ["tt-agent-tests-and-live-matrix-validation"]
+++

# Final integration, review, and single feature pull request

Own final verification and create the ONE new pull request for `feat/verbose-acp-output` against `main`. Do not merge it. Spec: `specifications/verbose-acp-output.md` (already on main). Earlier developers merged their tickets into this feature branch; read their work logs and verify their changes.

Scope:
- Review spec acceptance against implementation, ACP v1 vs pi-acp extension handling, Matrix edit semantics/encryption, status colors, per-event and per-message truncation, live grouping, archived late edits, eager messages, fallback safety and no private data in commits. Fix deficiencies on feature branch with signed commits; add tests if necessary. Run `npm run check` and applicable live `agent_tests` from previous ticket; report any skipped prerequisite truthfully.
- Compare branch to `main`; ensure only feature/test/docs changes, not waap state, credentials or private traces. Push feature branch and create one GitHub PR (`gh pr create --base main --head feat/verbose-acp-output`) with concise scope, test results, limitations, and a human-readable review request marked "Chad's Agent" if posting a comment. The user explicitly wants to review before merge; do not merge. Request review from chad if the hosting service permits it for this PR.
- Do not print token values. If gh lacks auth, retrieve only for the invocation via `nopass_pass.sh p/github.com/chadvoegele/admin_token` as described in the password-secrets skill. Record the resulting PR URL in work log and completion message.

Acceptance: exactly one new PR exists for this feature branch, signed commits where available, checks pass or any externally blocked live tests are transparently disclosed. Close ticket only after PR creation; no direct merge to main.
