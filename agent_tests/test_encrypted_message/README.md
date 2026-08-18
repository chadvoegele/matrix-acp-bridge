# Encrypted Message Test

## Conditions

1. The test must never permit plaintext fallback.

## Test setup

The test-only harnesses in [`../encrypted-e2e/`](../encrypted-e2e/README.md) automate device provisioning, persistent sender crypto, real SAS comparison and confirmation, ACP/bridge process wiring, both exchanges, restart assertions, and cleanup. Generated identities and secrets remain in ignored private files. Prefer the repeatable entry point, which cleans up on success, failure, or an ordinary signal:

```sh
agent_tests/encrypted-e2e/test.sh
```

### Software

- A reachable ACP endpoint. The current environment proxies stdio to `pi-acp`:

```sh
docker --host ssh://ACP_DOCKER_HOST exec -i pi-acp \
  socat UNIX-CONNECT:/run/pi-acp/acp.sock STDIO
```

### Matrix identities

1. A bridge account and device.
2. A second trusted device for the bridge account, used for SAS verification.
3. A sender account and device, with persistent crypto state of its own.
4. A encrypted room containing the bridge and sender accounts.

### Bridge configuration

Create a private state directory and a configuration equivalent to:

```toml
state_dir = "/tmp/matrix-acp-e2e/bridge-state"

[matrix]
homeserver = "https://matrix.example.org"
user_id = "@bridge:matrix.example.org"
device_id = "BRIDGE_DEVICE"
access_token_file = "/tmp/matrix-acp-e2e/bridge-token"
allowed_rooms = ["!encrypted-room:matrix.example.org"]
allowed_senders = ["@sender:matrix.example.org"]
encryption = "required"

[acp]
cwd = "/tmp"

[limits]
startup_timeout_seconds = 120
shutdown_grace_seconds = 30
```

## Test steps

1. Install dependencies and run the automated checks:

   ```sh
   npm ci
   npm run check
   ```

2. Create a new empty bridge state directory.

3. Bootstrap the bridge crypto identity:

   ```sh
   node dist/main.js --config /tmp/matrix-acp-e2e/config.toml crypto bootstrap
   ```

4. Record the Ed25519 and Curve25519 fingerprints from `crypto-state.json`.

5. Complete real SAS verification with the trusted device:

   ```sh
   node dist/main.js --config /tmp/matrix-acp-e2e/config.toml \
     crypto verify --device TRUSTED_DEVICE
   ```

   Confirm that the emoji and decimal SAS agree on both devices.

6. Start the ACP stdio proxy and bridge. Wait for the bridge's `startup-ready` diagnostic.

7. Start the sender harness and wait for Matrix sync readiness.

8. Send:

   ```text
   Reply with exactly: ENCRYPTED_E2E_OK
   ```

9. Wait for the bridge response.

10. Assert the first exchange as described below.

11. Stop the sender and bridge gracefully. Wait for both processes to exit.

12. Assert that no `.indexeddb.snapshot.tmp` file remains and that shutdown reported no persistence error.

13. Restart the bridge using the same configuration and state directory.

14. Confirm that the manifest fingerprints are unchanged.

15. Restart the sender with its existing crypto state and send `Reply with exactly: ENCRYPTED_E2E_OK_OK`

16. Assert the second exchange and stop both processes gracefully.

17. Clean up test-created state, preferably from an `EXIT` trap:

   ```sh
   node agent_tests/encrypted-e2e/cleanup.mjs
   ```

   Cleanup must:

   - call ACP `session/delete` for every session ID saved in bridge state;
   - log out the bridge, SAS-helper, and sender devices, removing their access tokens and device records;
   - remove generated token files, TOML files, manifests, Matrix crypto databases, sync/session mappings, snapshots, and locks; and
   - preserve local state and report failure if remote ACP or Matrix cleanup fails.

   Encrypted room events remain in room history. Homeserver, ACP, proxy, and service logs may also retain ordinary operational records.

## State created by the test

A successful setup creates:

- three temporary Matrix device IDs and access tokens: bridge, SAS helper, and sender;
- public device keys, one-time keys, and temporary to-device verification/key-sharing traffic for those devices;
- one ACP agent session and its agent-owned transcript/state;
- ignored local identity configuration and token files;
- three persistent Matrix Rust crypto stores plus manifests and snapshots; and
- bridge sync state, room-to-ACP mapping, and lock files.

`cleanup.mjs` removes the active Matrix devices, ACP session, and local files. It intentionally leaves room messages, server/proxy logs, and normal ignored build outputs such as `node_modules/` and `dist/`.

## Expected outcome

The test passes only when all of these conditions hold:

- Bootstrap and SAS verification complete without ACP initialization.
- The bridge starts in `required` mode and reports `startup-ready`.
- The sender's prompt is `m.room.encrypted` on the wire.
- The bridge decrypts the prompt and sends its exact clear text to ACP once.
- ACP returns `ENCRYPTED_E2E_OK`.
- The bridge response is `m.room.encrypted` on the wire.
- The sender decrypts the response to exactly `ENCRYPTED_E2E_OK`.
- No plaintext `m.room.message` prompt or response is sent.
- Neither side reports `m.no_olm`, `m.room_key.withheld`, or an undecryptable live test event.
- Graceful shutdown persists crypto state without an `ENOENT` snapshot rename error.
- No snapshot temporary file remains after shutdown.
- Restart restores the same Ed25519 and Curve25519 fingerprints.
- The second encrypted exchange succeeds without re-bootstrap or key regeneration.

## Failure interpretation

- `m.no_olm` or `m.room_key.withheld` usually means the recipient lacks a valid Olm session. Verify that device IDs were not reused with regenerated crypto state and that claimed one-time-key signatures match the current device key.
- A response that exists but cannot be decrypted usually means the response's Megolm room key could not be shared with the sender device.
- `ENOENT` while renaming `.indexeddb.snapshot.tmp` indicates concurrent snapshot writers rather than a Matrix encryption failure.
- A changed fingerprint after restart means crypto persistence failed and the result must not be accepted.
