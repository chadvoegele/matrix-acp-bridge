# MCP startup notices (issue #19)

## Cause and fix

`pi-mcp-adapter` 2.32.1 calls `ui.notify()` in `init.ts` after eager MCP
connections succeed. `pi-acp` 0.0.33 translates extension UI notifications into
`agent_message_chunk` updates with `_meta.piAcp.notify.level` on the update.
These are separate from the session's advertised `_meta.piAcp.startupInfo`.
The bridge discarded that notification metadata during normalization and
collected the banner as assistant text when startup overlapped a prompt.

The bridge now consumes tagged notifications before collecting text or notifying
response/activity subscribers. It emits `acp-extension-notification` diagnostics
with session ID and severity (`info`, `warn`, or `error`), including outside
active prompts. Notification bodies are not logged, preserving the existing
private-content logging boundary. Untagged assistant text remains unchanged,
even if it contains exactly the same MCP banner.

This applies before both plaintext and encrypted Matrix delivery and does not
require matching MCP strings or changing production deployment configuration.
Adapters without the pi-acp metadata marker retain their existing behavior.

For deployments wanting to suppress successful startup notifications at source,
`pi-mcp-adapter` also supports this in `mcp.json`:

```json
{
  "settings": {
    "notifyOnStartupConnect": false
  }
}
```

Merge this setting with existing settings; retain `mcpServers`. The adapter's
connection-error and authentication-warning branches are independent of this
setting. This optional deployment change alone does not address other tagged
extension notices, so the bridge fix uses the metadata instead.

## Verification

- `npm run check`: 399 tests passed, including regressions for notifications
  before/during the first prompt of two independent sessions, warning/error
  diagnostic severity, body privacy, and identical untagged assistant text.
- Real plaintext thread-session scenario: both concurrent roots returned their
  exact tokens; independent persisted sessions, restart/lazy load, reset, and
  fresh-session exact responses passed. The suite then failed on the unrelated
  unknown-root send with Matrix HTTP 400, before that prompt reached the bridge.
  Its cleanup deleted sessions and revoked test devices.
- Real encrypted thread-session scenario attempted: helper crypto bootstrap
  failed with `database-invalid` before message delivery. Cleanup completed.
  A retry timed out during provisioning; its two partially provisioned devices
  were explicitly logged out and their local private state removed. Encrypted
  live delivery is therefore not claimed as passing.

Local investigation logs: `/tmp/issue19-check.log`,
`/tmp/issue19-plaintext.log`, `/tmp/issue19-encrypted.log`, and
`/tmp/issue19-encrypted-retry.log`.
