# matrix-acp-bridge

Use `matrix-acp-bridge` to talk to your agents from
[Matrix](https://matrix.org/). It relays Matrix messages to and from
[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) agents.

```mermaid
flowchart LR
    client[Matrix client] <--> homeserver[Matrix homeserver]
    homeserver <--> bridge[matrix-acp-bridge]
    bridge <--> agent[ACP agent]
```

## Features

1. plaintext messages
2. typing indicators
3. read receipts
4. catch-up across bridge restarts
5. SAS verification
6. encrypted messages

See the [Matrix bridge MCP server proposal](spec/matrix-bridge-as-mcp-server.md)
for scheduled and other agent-initiated outbound messages.

## Installation and verification

```sh
node --version                 # Tested with v22 through v26
npm ci                         # installs exactly package-lock.json
npm run build                  # cleans and emits production files to dist/
npm run typecheck              # checks production and test sources without emitting
npm test                       # builds dist/ and dist-test/ before running tests
npm run check                  # final typecheck and test gate
```

## ACP Connection

The bridge must have a full-duplex ACP stdio connection:

```text
ACP agent stdout  ───────▶ bridge stdin
ACP agent stdin   ◀─────── bridge stdout
```

`socat` can connect an ACP agent and the bridge through a Unix
socket:

```sh
socat UNIX-LISTEN:/run/matrix-acp-bridge/acp.sock,unlink-early,mode=0600 \
  EXEC:'/opt/acp-agent/bin/acp-agent'
```

Then connect the bridge:

```sh
socat UNIX-CONNECT:/run/matrix-acp-bridge/acp.sock \
  EXEC:'node /opt/matrix-acp-bridge/dist/main.js --config /etc/matrix-acp-bridge/config.toml'
```

## Configuration

Copy [`config.toml.example`](config.toml.example) to `config.toml` and update
its values.

```toml
state_dir = "/var/lib/matrix-acp-bridge"

[matrix]
homeserver = "https://matrix.example.org"
user_id = "@bridge:matrix.example.org"
device_id = "MABRIDGE01"
access_token_file = "/var/lib/matrix-acp-bridge/matrix-access-token"
allowed_rooms = ["!private-room:matrix.example.org"]
allowed_senders = ["@operator:matrix.example.org"]
encryption = "disabled"   # or "required"

[acp]
cwd = "/srv/acp-agent/workspace"

[limits]
max_input_bytes = 16384
max_output_bytes = 262144
max_matrix_message_bytes = 32768
max_queued_turns_per_room = 16
max_concurrent_prompts = 4
max_turn_seconds = 1800
shutdown_grace_seconds = 30
startup_timeout_seconds = 60
max_catchup_age_seconds = 900
max_catchup_events_per_room = 4
```

## Encryption Setup

Stop the daemon and then run:

```sh
node /opt/matrix-acp-bridge/dist/main.js \
  --config /etc/matrix-acp-bridge/config.toml crypto bootstrap

node /opt/matrix-acp-bridge/dist/main.js \
  --config /etc/matrix-acp-bridge/config.toml crypto verify --device TRUSTED_DEVICE_ID
```

`TRUSTED_DEVICE_ID` is the device ID of an already trusted Matrix client, such
as Element. Compare the emoji and decimal SAS values shown by both devices,
then type exactly `yes` in the bridge terminal to confirm them.

## AI

I co-authored the planning, specifications, and integration tests for
`matrix-acp-bridge` with GPT 5.6 Sol. GPT 5.6 Luna implemented it with `xhigh`
reasoning effort and can run the integration tests.

**Initial Prompt**
I want to build a matrix client to acp bridge. This will allow me to create a matrix room with a 'chadagent' user and my user 'chad' and I'll be able to send messages which the agent will respond to. We'll connect to the agent via acp using a stdio. I want the agent user to be a normal user. Hopefully no application service needed for synapse. Let's start by inspecting these two implementations ~/code/github.com/openclaw/openclaw/extensions/matrix and ~/code/github.com/zooid-ai/zooid. Start some notes in spec/spec.md. What's going to be involved? How practical is it? How simple can we keep it? What's needed for security? Can we support e2ee?
