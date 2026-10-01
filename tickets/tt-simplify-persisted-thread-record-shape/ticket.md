+++
name = "Simplify persisted thread record shape"
creation_date = 2026-10-01T13:40:36Z
status = "in-progress"
+++

# Simplify persisted thread records

Remove the redundant `kind: "thread"` property from each record in the persisted `bridge-state.json` `threads` array. Its containing array already conveys its kind. Keep the in-memory ConversationRecord discriminator where useful; reconstruct it at the persistence boundary.

Work against current origin/feat/thread-scoped-sessions (PR #16), not main. Keep functionality otherwise unchanged and keep the scope small/readable.

Requirements:
- Write only roomId, threadRootEventId, and optional sessionId in each persisted thread record.
- Preserve known sessionless identities after reset and all existing state durability, validation, and migration behavior.
- Account explicitly for existing schema-13 files containing kind. Prefer accepting both old tagged and new untagged records on read while always writing the minimal new form; do not bump the schema just for this backward-compatible simplification. Continue rejecting malformed fields/invalid kind values. Do not touch real private bridge state.
- Add focused tests for exact written JSON shape, loading old/new shapes, and sessionless reset/restart. Keep in-memory snapshot behavior consistent.
- Update any affected examples/docs/spec assertions minimally; avoid unrelated refactors.
- Run npm run check and git diff --check.
- Commit and push the resulting changes to the existing feat/thread-scoped-sessions branch to update PR #16, without merging PR #16 or default branch. Use an isolated WAAP worktree/branch, verify the remote target has not moved unexpectedly before pushing, never force push.
- Report commit, verification, compatibility choice, and PR link in WAAP work log and completion report. Mark public comments "Chad's Agent".
