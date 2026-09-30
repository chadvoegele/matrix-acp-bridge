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

## Installation and verification

```sh
node --version                 # Tested with v22 through v26
npm ci                         # installs exactly package-lock.json
npm run build                  # cleans and emits production files to dist/
npm run typecheck              # checks production and test sources without emitting
npm test                       # builds dist/ and dist-test/ before running tests
npm run format                 # fix spacing and format the repository
npm run check                  # formatting, lint, typecheck, and test gate
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
response_mode = "room"    # or "thread"; defaults to room
encryption = "disabled"   # or "required"

[acp]
cwd = "/srv/acp-agent/workspace"

[limits]
max_input_bytes = 16384
max_output_bytes = 262144
max_matrix_message_bytes = 32768
max_activity_events_per_message = 10
max_queued_turns_per_room = 16
max_queued_turns_per_thread = 16   # independent default; used in thread mode
max_concurrent_prompts = 4
max_turn_seconds = 1800
shutdown_grace_seconds = 30
startup_timeout_seconds = 60
max_catchup_age_seconds = 900
max_catchup_events_per_room = 4
```

### Room and thread response modes

The default `response_mode = "room"` keeps one ACP session per room and
continues to reject inbound Matrix thread relations. Set
`[matrix].response_mode = "thread"` to give each authorized top-level message
its own ACP conversation. An ordinary Matrix reply without an `m.thread`
relation also starts a new conversation. A message with a valid thread relation
continues the conversation for that room and thread root; its reply fallback is
removed before the text is sent to the agent. Agent responses, activity, errors
and reset acknowledgements are sent in the originating thread. Clients without
thread support may display reply fallbacks in the main timeline.
When `encryption = "required"`, threaded responses use the same validated
encrypted-room path as other responses and are never sent as plaintext.

`allowed_senders` is one global allowlist for every configured room. Every
message is authorized before its thread session is looked up or loaded; a
persisted session does not grant its sender access. Keep allowed senders and
rooms restricted to trusted operators.

In thread mode, `max_queued_turns_per_thread` defaults to 16 independently of
`max_queued_turns_per_room`, even if the room limit is customized. Prompts and
resets run in order within each thread. Different threads can run concurrently,
bounded by `max_concurrent_prompts`, which counts unresolved ACP prompt
requests only. Session creation and lazy session loading do not consume prompt
slots. Room mode continues to use `max_queued_turns_per_room`. Thread mode has
no room-wide backlog cap, so queued work can grow with the number of threads.

An unknown thread receives `Unknown thread agent session. Please start a new
thread.` Start a new top-level message to create a conversation. Oversized
top-level messages also leave no thread session behind, so follow-ups to their
error replies are unknown. An exact `/reset` inside a known thread clears only
that thread's ACP session when the reset reaches the front of its queue; the
next prompt starts a fresh session. `/reset` at the top level returns
`Use /reset inside a thread to reset its agent session.` Neither form deletes
agent-owned history.

Thread mappings are retained without an age or count limit and are loaded only
when a thread next receives work. This does not unload sessions kept in memory
by the ACP agent. If the ACP agent does not support
`session/load`, old room and thread sessions cannot resume after a bridge
restart; start a new top-level thread. Room and thread contexts stay separate
when switching response modes, and removing a room from `allowed_rooms` removes
both. Removing a sender from `allowed_senders` blocks their messages but keeps
the stored mappings.

The first startup with this schema automatically migrates bridge state and
creates a private `bridge-state.pre-v13.json` backup in `state_dir`. For
recovery guidance and the stop-and-restore rollback procedure, see
[`docs/thread-sessions-state.md`](docs/thread-sessions-state.md). Restoring the
backup loses bridge-state changes made after migration, including thread
mappings and completed-event IDs.

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
