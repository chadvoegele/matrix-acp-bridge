# Unencrypted Message Test

## Conditions

1. The configured room must not have encryption enabled.
2. Both prompt and response must be plaintext `m.room.message` events.

## Test setup

The test-only harnesses in [`../unencrypted-e2e/`](../unencrypted-e2e/README.md) automate device provisioning, ACP/bridge process wiring, both exchanges, restart, and cleanup. Generated identities and secrets remain in ignored private files. Prefer the repeatable entry point, which cleans up on success, failure, or an ordinary signal:

```sh
agent_tests/unencrypted-e2e/test.sh
```

### Software

- A reachable ACP endpoint. The current environment proxies stdio to `pi-acp`:

```sh
docker --host ssh://ACP_DOCKER_HOST exec -i pi-acp \
  socat UNIX-CONNECT:/run/pi-acp/acp.sock STDIO
```

### Matrix identities

1. A bridge account and temporary device.
2. A sender account and temporary device.
3. An unencrypted room containing both accounts.

The harness shares the encrypted test's `E2E_HOMESERVER`, account, password, ACP, and working-directory variables. Set `UNENCRYPTED_E2E_ROOM_ID` for the plaintext room; `E2E_ROOM_ID` is the fallback. See [`../unencrypted-e2e/README.md`](../unencrypted-e2e/README.md).

### Bridge configuration

Create a private state directory and a configuration equivalent to:

```toml
state_dir = "/tmp/matrix-acp-unencrypted-e2e/bridge-state"

[matrix]
homeserver = "https://matrix.example.org"
user_id = "@bridge:matrix.example.org"
device_id = "BRIDGE_DEVICE"
access_token_file = "/tmp/matrix-acp-unencrypted-e2e/bridge-token"
allowed_rooms = ["!plaintext-room:matrix.example.org"]
allowed_senders = ["@sender:matrix.example.org"]
encryption = "disabled"

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

3. Log in temporary bridge and sender devices. No crypto bootstrap or SAS verification is needed.

4. Start the ACP stdio proxy and bridge. Wait for the bridge's `startup-ready` diagnostic.

5. Start the sender harness and wait for normal Matrix sync readiness.

6. Send a prompt asking the agent to return a Markdown-formatted value. The
   automated test sends a prompt like:

   ```text
   Reply with exactly this Markdown and nothing else: **UNENCRYPTED_E2E_MARKDOWN_<run-id>**
   ```

7. Wait for the bridge response.

8. Assert the first exchange as described below.

9. Stop the bridge gracefully and wait for both processes to exit.

10. Restart the bridge with the same configuration and state directory.

11. Send `Reply with exactly: UNENCRYPTED_E2E_OK_OK` and assert the second exchange.

12. Stop the processes and clean up from an `EXIT` trap:

   ```sh
   node agent_tests/unencrypted-e2e/cleanup.mjs
   ```

   Cleanup must delete saved ACP sessions, log out both temporary Matrix devices, and remove generated tokens, configuration, sync/session state, and locks. It preserves local state if remote cleanup fails.

## State created by the test

A successful setup creates:

- two temporary Matrix device IDs and access tokens;
- one ACP agent session and its agent-owned transcript/state;
- ignored local identity configuration and token files; and
- bridge sync state, room-to-ACP mapping, and lock files.

Cleanup removes the active devices, ACP session, and local files. It leaves plaintext room events, service logs, and normal ignored build outputs such as `node_modules/` and `dist/`.

## Expected outcome

The test passes only when all these conditions hold:

- The bridge starts in `disabled` mode and reports `startup-ready`.
- The sender's prompt is a top-level `m.room.message` on the wire.
- The bridge sends the exact prompt to ACP once.
- ACP returns the requested Markdown value.
- The bridge response is a top-level `m.room.message` on the wire.
- The response includes `format: "org.matrix.custom.html"` and the expected
  `<strong>` element in `formatted_body`.
- The sender receives exactly one response with the expected body.
- No `m.room.encrypted` prompt or response is used.
- The second plaintext exchange succeeds after restarting the bridge.

## Failure interpretation

- Startup failure reporting an encrypted room means the configured room has `m.room.encryption` state and cannot test disabled mode.
- A missing response usually means the sender or room allowlist is wrong, the bridge device is not joined, or ACP did not answer.
- More than one matching `session/prompt` means one Matrix event was submitted to ACP more than once.
- An encrypted wire event means the test room or client setup violates the disabled-mode contract.
