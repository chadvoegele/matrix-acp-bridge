+++
name = "Remove automatic migration backup"
creation_date = 2026-10-01T17:58:46Z
status = "pending"
+++

# Remove automatic pre-migration state backup

User explicitly requests removing automatic bridge-state.pre-v13.json backup: backing up state is the user's responsibility. Update existing PR #16 on origin/feat/thread-scoped-sessions.

Remove BRIDGE_STATE_BACKUP_FILE_NAME and automatic backup creation/validation/durability handling, backup-only fault injection points/error categories/helpers, and backup-specific migration rollback machinery where no longer justified. Update tests, docs, implementation/review/spec assertions and error recovery guidance to reflect user-managed backups. Remove claims that the bridge creates a rollback backup. Document concisely that users must back up private bridge state before upgrading and restore their own pre-upgrade backup to downgrade; do not introduce another automatic backup mechanism.

Keep schema-12 to schema-13 migration and normal atomic write/fsync/rename/directory-fsync behavior. Preserve identity checks, private permissions, strict state validation, session behavior, and fatal failure handling. Do not delete any existing backup or production file; no private state changes or service restarts. No unrelated refactors.

Work in an isolated WAAP worktree/task branch from latest origin/feat/thread-scoped-sessions. Other agents may update PR #16 concurrently. Fetch/rebase onto latest remote before pushing and preserve their changes; safely retry non-fast-forward races, never force push. Run npm run check and git diff --check, audit stale backup references. Commit and push HEAD:feat/thread-scoped-sessions to update PR #16; do not merge PR/default branch.

Maintain agent-specific WAAP work_log.md, update ticket status through WAAP CLI, and report commit/check outcomes. Public comments must be marked Chad's Agent. If PR #16 body still claims automatic backup, update just those claims to user-managed backup without erasing unrelated sections or concurrent updates.
