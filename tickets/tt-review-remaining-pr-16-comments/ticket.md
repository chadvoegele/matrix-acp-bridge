+++
name = "Review remaining PR 16 comments"
creation_date = 2026-10-01T18:00:27Z
status = "in-progress"
depends_on = ["tt-remove-automatic-migration-backup"]
+++

# Review remaining PR #16 comments after backup removal

After tt-remove-automatic-migration-backup completes, fetch current PR #16 head and inspect all inline comments/review threads and issue comments. User asks to check other comments when the backup change is done.

Known unanswered inline comment: id 4158650885, src/acp-activity-batches.ts line 17, Chad asks 'Why do limits need to know about routing?'. Evaluate whether activity batching can avoid owning routing by receiving an exact payload measurement callback, analogous to text packing/rendering, keeping routing at coordinator/wire construction boundaries. Prefer a small coherent simplification if warranted; preserve exact byte accounting including threaded edit envelopes, live activity relations, and all room/thread behavior. Do not blindly remove routing from measurement, undercount payloads, or add needless abstractions. If a change is not justified, reply with a concise explanation and report why. Audit other comments for unresolved actionable requests, implement clear authorized scope or report any ambiguity rather than guessing.

Use latest origin/feat/thread-scoped-sessions in an isolated task branch/WAAP worktree. If changes are made run npm run check and git diff --check; commit and push non-forced HEAD:feat/thread-scoped-sessions to update #16, never merge PR/default branch. Fetch/rebase before push to preserve concurrent work. Reply to relevant PR comments marked Chad's Agent with actual changes/verification, not claims about work not done. Preserve other comments and PR description.

Maintain WAAP agent work_log.md, update ticket status via WAAP CLI, and report outcome. No production state/service changes. Read applicable repository/password skills; use nopass_pass.sh for secrets without exposure.
