+++
name = "Consolidate per conversation queue limit"
creation_date = 2026-10-01T18:05:33Z
status = "completed"
+++

# Consolidate queue limits per conversation

User approved consolidating separate room/thread waiting queue limits into one per-conversation limit. Use new config name `limits.max_queued_turns_per_conversation` and TypeScript `maxQueuedTurnsPerConversation`. Keep default 16. Use only the new config name in README.md.

Retain old existing room-mode TOML key `max_queued_turns_per_room` as a legacy alias mapping to the new internal field so existing configurations work. Do not retain two internal limits or select a limit by identity kind. The unmerged `max_queued_turns_per_thread` setting should be removed rather than perpetuating a second limit. If new and legacy room keys are both explicitly present, reject with a clear configuration error rather than silently picking one. Validate alias values with the same positive-safe-integer rules as the new key. Do not change waiting-queue admission semantics, catch-up behavior, global prompt limit, or active-turn handling.

Audit src, tests, example configs, agent harness generated configs, and docs for old fields. Update tests for legacy alias, new key, default, invalid values, conflicting keys, and room/thread queue behavior. Existing README should mention only the new name; config examples should use the new name as well. Other explanatory docs may mention the legacy alias only where useful. Do not reintroduce removed README sections unnecessarily.

Update current PR #16 on origin/feat/thread-scoped-sessions. Work in an isolated WAAP worktree/task branch based on latest remote; other agents are updating the same branch. Fetch/rebase latest remote before final push, preserve concurrent changes, safely retry non-fast-forward races without force. Run npm run check and git diff --check. Commit and push HEAD:feat/thread-scoped-sessions non-forced; never merge PR/default branch.

Maintain agent-specific WAAP work_log.md, update ticket status using WAAP CLI, and report verification and commit. Public comments marked Chad's Agent. No production state/services changes.
