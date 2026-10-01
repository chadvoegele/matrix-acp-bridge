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

Before replacement, migration writes a byte-for-byte copy of the original to
`bridge-state.pre-v13.json` in `state_dir`. The directory remains service-owned
and private (0700), and the backup is service-owned with mode 0600. The backup is
published exclusively after file fsync, then the directory is fsynced before
migration. A retry validates and retains an existing original backup; repeated
startup never refreshes it. Keep this private file out of source control.

The bridge does not alter SDK-owned sync cursors, recovery files or crypto state.
The backup covers the bridge document only. It is not a backup of agent history,
Matrix history or the entire state directory. Use the existing backup procedure
for those separate stores when needed.

Backup failure stops startup before replacing bridge state. Migration uses the
existing atomic write/file-fsync/rename/directory-fsync sequence. Reported
post-rename migration failures attempt an atomic restoration of the original
inode; the original backup also remains available after a crash or an underlying
filesystem failure that prevents restoration. Ordinary mutation failures are
fatal; a post-rename fsync failure has an indeterminate disk commit and must
never produce a successful reset acknowledgement.

Unsupported or corrupt documents stop startup with recovery guidance. Verify the
configured Matrix account/device identity, service ownership, permissions and
filesystem health. Do not delete state or edit its version number to bypass an
error. An unsafe, corrupt or incompatible existing migration backup also blocks
migration; inspect it privately rather than overwriting the first original.

## Restore-based rollback

An older binary cannot read schema 13. **Stop the bridge completely** using its
service manager and ensure it has released the state lock before restoring.
Save any desired post-upgrade state privately first. Restore the original backup
as the service user (substitute your configured `state_dir`):

```sh
python3 - /var/lib/matrix-acp-bridge <<'PY'
import os
import pathlib
import shutil
import sys

state_dir = pathlib.Path(sys.argv[1])
backup = state_dir / "bridge-state.pre-v13.json"
target = state_dir / "bridge-state.json"
temporary = state_dir / "bridge-state.restore.tmp"
with backup.open("rb") as source, temporary.open("xb") as output:
    os.fchmod(output.fileno(), 0o600)
    shutil.copyfileobj(source, output)
    output.flush()
    os.fsync(output.fileno())
os.replace(temporary, target)
directory_fd = os.open(state_dir, os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)
PY
```

Then start the older binary with its matching configuration (remove the new
`response_mode` and `max_queued_turns_per_thread` settings if unsupported). Leave
SDK-owned recovery and crypto files intact. Do not run old and new binaries
against the same state directory concurrently.

**Restoring loses every post-migration bridge-state change**, including thread
identities/sessions, later room-session changes and completed-event IDs. It does
not delete agent-owned history. The retained backup is always the first original,
so upgrading again after rollback migrates the current schema-12 document but
keeps that first backup. There is no downgrade/export tool.
