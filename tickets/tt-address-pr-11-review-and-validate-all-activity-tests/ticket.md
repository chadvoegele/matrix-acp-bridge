+++
name = "Address PR 11 review and validate all activity tests"
creation_date = 2026-09-29T13:35:57Z
status = "pending"
+++

Implement fixes on PR #11 (feat/verbose-acp-output) for the review at https://github.com/chadvoegele/matrix-acp-bridge/pull/11#issuecomment-5891372367.

1. Make ACP bounded text Unicode-safe. Propagate truncation information through client mapping and activity rendering so clipped tool content and streamed thoughts clearly say truncated. Prefer a shared small helper and simple, predictable behavior. Add client-to-renderer regression tests across limits (including emoji boundary and >32 tool entries).
2. Mark the top-level formatted HTML Matrix edit fallback as an edit, while leaving m.new_content unchanged. Add/update adapter tests.
3. Replace fragile 250 ms timing assumption for the scripted archived-tool-edit agent test with deterministic evidence or an assertion that guarantees an actual edit of an already sent batch. Make optional real agent activity test fail when required observations are absent, or clearly designate it diagnostic-only with an explicit non-gating command and explain coverage.
4. Run npm run check, the repository's scripted plaintext AND encrypted Matrix activity runners, and real-agent runner if prerequisites permit; document any environment/setup blockers and cleanup. Existing ignored .env is at repository layout root (../.env from feat/verbose-acp-output). It contains the test setup and pass is unlocked; source privately, never print credentials. Verify GitHub CI for the updated PR branch and fix failures. Report exact commands/results. No secrets in logs, patches, or comments.

Acceptance: no regression in functionality; targeted tests cover all fixed behaviors; checks and runnable agent tests pass; GitHub CI passes on updated PR head. Commit and push changes ONLY to feat/verbose-acp-output. Do NOT merge main or the PR. Request review from chad on PR #11 when done. Record work in waap work log and ticket.
