# Thread session state migration and rollback

Starting the upgraded bridge automatically migrates `bridge-state.json` from
schema 12 to schema 13, under the existing private state-directory lock. It
preserves the Matrix account/device identity, initialized flag, completed-event
ledger and room sessions. Schema 13 adds independent thread records scoped by
room and root event ID. A known thread may have no session ID after admission or
reset. The next prompt can create a fresh session, including after restart when
ACP session loading is supported.

Each record in the schema-13 `threads` array contains only `roomId`,
`threadRootEventId` and an optional `sessionId`. Unexpected fields, including
`kind: "thread"`, and malformed fields are rejected. The reader reconstructs the
`kind` discriminator for in-memory conversation records.

Room and thread records remain separate across response-mode changes. Removing a
room from `allowed_rooms` prunes both kinds of record. Sender changes do not
prune records. There is no age, inactivity or count eviction. Startup without
`session/load` support discards all prior room mappings and thread identities;
old threads become unknown. Live in-process identities remain available through
reset. The state boundary performs no ACP session loading.

Before upgrading, stop the bridge and back up private `bridge-state.json` using
your own backup procedure. Backups are the user's responsibility; the bridge
creates no automatic backup and does not inspect or alter existing backup files.
Keep state and backups service-owned, private (directory 0700, files 0600) and out
of source control. Use the existing backup procedures for SDK recovery/crypto
state and agent history when needed; migration does not alter those stores.

Migration uses the normal atomic write/file-fsync/rename/directory-fsync sequence.
Failures stop startup. Failures before rename leave the original state intact;
a post-rename directory-fsync failure has an indeterminate disk commit and may
leave schema 13 on disk. State-write failures are fatal and must never produce a
successful reset acknowledgement.

Unsupported or corrupt documents stop startup with recovery guidance. Verify the
configured Matrix account/device identity, service ownership, permissions and
filesystem health. Do not delete state or edit its version number to bypass an
error.

## Restore-based rollback

An older binary cannot read schema 13. Stop the bridge completely and ensure it
has released the state lock. Save any desired post-upgrade state privately, then
restore your own pre-upgrade schema-12 backup to `bridge-state.json` as the service
user, retaining private ownership and permissions. If you have no pre-upgrade
backup, there is no downgrade/export tool.

Start the older binary with its matching configuration (remove `response_mode`
and `max_queued_turns_per_thread` if unsupported). Leave SDK-owned recovery and
crypto files intact. Do not run old and new binaries against the same state
directory concurrently.

**Restoring loses every post-migration bridge-state change**, including thread
identities/sessions, later room-session changes and completed-event IDs. It does
not delete agent-owned history. A later upgrade migrates the restored schema-12
state again; manage backups yourself before each upgrade.
