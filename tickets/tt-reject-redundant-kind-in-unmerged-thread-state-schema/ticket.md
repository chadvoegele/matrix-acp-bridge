+++
name = "Reject redundant kind in unmerged thread state schema"
creation_date = 2026-10-01T13:48:09Z
status = "in-progress"
+++

# Remove compatibility for unmerged tagged thread records

User clarification supersedes the compatibility requirement in tt-simplify-persisted-thread-record-shape: PR #16 is not merged, so there is no need to accept the earlier schema-13 thread records with `kind: "thread"`.

Update current origin/feat/thread-scoped-sessions (existing PR #16). Remove compatibility code accepting `kind` in persisted threads. The schema-13 threads array must contain only roomId, threadRootEventId, and optional sessionId. Reject kind as an unexpected field, including kind: thread. Keep the useful in-memory discriminator reconstructed on read. Retain schema-12 migration and other supported existing state behavior; no schema-version bump for this unmerged change.

Remove compatibility tests and documentation claims, replace with strict-schema tests where useful. Keep scope minimal and readable. Run npm run check and git diff --check, commit, and push HEAD:feat/thread-scoped-sessions non-forced to update #16. Do not merge PR #16 or default branch, touch production state, or restart services.

Work in your WAAP isolated worktree on a task branch based on latest origin/feat/thread-scoped-sessions. Another agent aa-explicit-response-modes-codex-61-sol is concurrently updating this PR. Fetch/rebase onto latest remote before pushing, preserve concurrent changes, and safely retry non-fast-forward races without force. Record verification and commit in your WAAP work log, mark ticket completed on success. Public comments must be marked Chad's Agent.
