+++
status = "final"
created = 2026-08-09
last_update = 2026-08-12
+++

# Matrix–ACP bridge specification

Milestone 2 and Milestone 3 are accepted in their reduced forms in
[spec/m2-persistence.md](m2-persistence.md) and [spec/m3-encryption.md](m3-encryption.md). Those documents are normative for
the current release. The older durable-delivery material below is retained as
history only and must not be implemented or used to expand the accepted M2
contract.

## Goal

Run one local daemon that signs into Matrix as an ordinary account such as
`@agent:<server>`, listens in explicitly configured rooms, and relays text
from allowlisted Matrix users to one ACP agent over inherited stdin/stdout. The
agent replies as the Matrix account.

Each room has an independent ACP session on the same long-lived ACP connection.
All configured senders are authorized for all configured rooms because the
allowlist belongs to the bridge's single agent, not to individual rooms.
Multiple authorized users in one room therefore share that room's agent
context. Run another bridge instance for another agent or authorization domain.

The user creates, joins, and manages the rooms, then configures their immutable
Matrix room IDs. This is not a general bot platform.

## Protocol baseline

The first implementation targets stable ACP v1 through the official TypeScript
SDK. ACP uses JSON-RPC over NDJSON on stdio. One connection supports several
concurrent sessions; the bridge serializes turns within each room session while
allowing bounded concurrency between room sessions.

ACP v2 and non-stdio transports are out of scope until deliberately adopted.
Milestone 1 supports Node.js 22 through 26 (`>=22 <27`),
`@agentclientprotocol/sdk` 1.3.0, and `matrix-js-sdk` 42.0.0. Package manifests
use exact versions without ranges, the lockfile is committed, and automated
installs use the frozen lockfile. ACP initialization must negotiate protocol version 1 exactly.

## Feasibility and references

A normal Matrix client can authenticate with an access token and device ID,
receive events through `/sync`, send replies, and participate in encrypted
rooms after crypto initialization. No Application Service, Synapse module,
webhook, inbound public port, or account impersonation is needed.

### Zooid

Zooid demonstrates the useful ACP flow: initialize a client, create or load a
session, send `session/prompt`, process `session/update`, answer permission
requests, map a conversation key to a session ID, queue per session, and
buffer streamed text. Its Matrix transports use Application Service
credentials and must not be copied for this bridge.

### OpenClaw Matrix plugin

OpenClaw demonstrates ordinary-user Matrix authentication, SDK-managed sync,
Node crypto initialization, persistent crypto storage, decryption, and device
verification. Its broader channel, media, provisioning, and recovery features
are outside this bridge's scope.

Use `matrix-js-sdk` instead of implementing `/sync`, event decryption, or
outbound encryption directly. The difficult work is durable event handling,
crypto persistence, strict authorization, and safe lifecycle behavior.

## Architecture

```text
Matrix homeserver <-- outbound HTTPS /sync --> bridge daemon
                                           |
                               authorize -> room queue
                                           |
                                   ACP v1 client
                                           |
                                  stdio NDJSON
                                           v
                              service-managed ACP agent
```

```text
src/
  main.ts                 composition, startup, shutdown, signals
  config.ts               parse and validate config and secret references
  matrix-client.ts        Matrix SDK lifecycle and bridge-facing adapter
  authorization.ts        pure inbound event policy
  bridge.ts               queues, turn coordination, and reply assembly
  acp-client.ts           inherited-stdio ACP adapter
  session-store.ts        milestone-2 sync, inbox, dedup, and session state
  bridge-facing contracts colocated with their owning modules
```

- **`main.ts`** owns startup ordering and graceful shutdown. It contains no
  event-routing or protocol translation logic.
- **`config.ts`** resolves paths, validates Matrix identifiers and limits, and
  reads secrets without returning them in errors or diagnostics.
- **`matrix-client.ts`** is the only module that imports `matrix-js-sdk`. It
  exposes normalized inbound messages and methods for replies and errors.
- **`authorization.ts`** accepts or rejects normalized event metadata without
  network, filesystem, or SDK dependencies.
- **`bridge.ts`** owns per-room queues, a global concurrency semaphore,
  room-to-session selection, ACP turn state, and Matrix reply assembly.
- **`acp-client.ts`** performs ACP initialization and session operations. It
  never starts an agent process. All diagnostics use stderr because stdout is
  ACP protocol traffic.
- **`session-store.ts`** is an in-memory boundary in M1. The accepted M2
  checkpoint and optional room/session map use `bridge-state.ts`; Matrix Rust
  crypto storage remains owned by `matrix-client.ts`.
- Bridge-facing contracts are colocated with the narrowest module that owns
  their behavior. Type-only imports prevent Matrix or ACP wire types from
  leaking into policy and coordination code.

Dependency direction is `main → bridge → adapters/policy/store`; adapters do
not import each other.

## Configuration

The daemon requires a TOML config path, for example
`--config /etc/bridge.toml`. The access token is always read from a separate
file.

```toml
state_dir = "/path/to/private-state"

[matrix]
homeserver = "https://matrix.example"
user_id = "@agent:example"
device_id = "AGENT"
access_token_file = "/path/to/private-state/matrix-access-token"
allowed_rooms = ["!room-id:example"]
allowed_senders = ["@user:example", "@other-authorized-user:example"]
encryption = "disabled" # disabled|required; required is the accepted M3 mode

[acp]
cwd = "/absolute/agent/workspace"

[limits]
max_input_bytes = 16384
max_output_bytes = 262144
max_matrix_message_bytes = 32768
max_queued_turns_per_room = 16
max_concurrent_prompts = 4
max_turn_seconds = 1800
shutdown_grace_seconds = 30
startup_timeout_seconds = 60
```

Every limit key is optional and receives the shown default. Operators may
raise or lower limits. Integer values must be positive and no larger than
`2^31 - 1`; time values converted to milliseconds must also fit a Node.js
timer. `max_output_bytes` must be at least 20 and
`max_matrix_message_bytes` at least 64 so fixed markers, statuses, and
multipart prefixes fit. Byte limits count UTF-8 bytes. `max_output_bytes` is
the aggregate agent text kept for one turn; `max_matrix_message_bytes`
controls each Matrix part.

Configuration rules:

- Parsing is strict. Reject duplicate keys, unknown keys, unknown table names,
  and values of the wrong type rather than ignoring them.
- `matrix.homeserver` must be an absolute HTTPS URL without credentials, query,
  or fragment.
- `acp.cwd` is required, resolved once at startup, and must be an existing
  absolute directory. Every `session/new` and `session/load` request uses it.
  The MVP sends `mcpServers: []` and advertises no client filesystem or
  terminal capability.
- `state_dir`, `matrix.access_token_file`, and `acp.cwd` must be absolute.
- Room IDs and sender MXIDs are exact, nonempty, and unique. Each allowlist
  must contain at least one entry. Aliases and display names are invalid.
- `allowed_senders` is global to the bridge. Every listed sender may prompt the
  agent in every listed room.
- `access_token_file` and every component of its path must not be a symlink.
  The file must be regular, owned by the service user, and have no group or
  world permission bits; `0400` or `0600` are typical. Its content is one
  nonempty token with no whitespace except one optional final LF.
- If `state_dir` does not exist, create it securely with mode `0700`. No path
  component may be a symlink. The directory must be owned by the service user
  with no group or world access. New files use mode `0600`. Hold a nonblocking
  OS advisory lock on `state_dir/.lock` for the process lifetime; an unlocked
  stale lock file is harmless.
- M1/M2 deployments use `encryption = "disabled"`; required mode follows the
  accepted M3 contract in [spec/m3-encryption.md](m3-encryption.md).
- Matrix passwords, interactive login, token creation, environment-variable
  tokens, and checked-in secrets are unsupported.

## Startup contract

Startup is fail-fast and occurs in this order:

1. Parse the config, validate identifiers, limits, paths, ownership, and modes,
   and reserve exclusive use of `state_dir`.
2. Bind the official ACP SDK to inherited stdin/stdout, call `initialize` with
   ACP v1 and no filesystem or terminal capabilities, and require negotiated
   protocol version 1.
3. Create the Matrix client and call `whoami`. Require its user ID and device ID
   to equal `matrix.user_id` and `matrix.device_id`; do not trust configuration
   alone to identify the token.
4. Register the Matrix sync-batch listener, start Matrix sync, and discard the
   initial batch's timeline events before the first `SyncState.Prepared`
   transition, including events in the `/sync` response that causes that
   transition. Atomically open live
   intake while handling `Prepared`. Later eligible events enter through sync
   batches and are registered before `BridgeCoordinator.handleTimelineEvent`
   dispatches them to ACP; the SDK's timeline source remains internal to the
   adapter and is normalized into those batches.
5. Require the Matrix account to be joined to every configured room. A missing,
   left, or mistyped room fails startup rather than silently disabling it.
6. Require every configured room to be unencrypted when `encryption =
   "disabled"`. In Milestone 3, require every configured room to be encrypted
   when `encryption = "required"`. There is no mixed mode.
7. Enable ACP dispatch and drain the buffered live events in room order.

Apply `startup_timeout_seconds` to the complete ACP-initialize and Matrix-ready
startup sequence after configuration validation. Timeout fails startup.
After startup, enabling encryption in a configured room or removing the bridge
account from one is fatal; membership changes involving other users do not
change authorization.

The bridge has no ACP authentication UI. Advertised authentication methods do
not themselves fail startup because they may be optional. Sessions remain
lazy; an authentication-required or other `session/new` error on the first
affected event receives one best-effort generic response and then causes fatal
shutdown without exposing raw error text.

## Inbound authorization and normalization

An event is eligible only when all of these conditions hold:

- it belongs to an exact configured room ID;
- its sender is an exact globally allowlisted MXID;
- its sender is not the bridge's verified Matrix user ID;
- it is a live plaintext `m.room.message` event;
- its `msgtype` is `m.text` and `body` is a string;
- it is not redacted; and
- `m.relates_to` is absent or has exactly this shape, with a valid Matrix event
  ID and no additional keys:

  ```json
  { "m.in_reply_to": { "event_id": "$event-id" } }
  ```

Reject edits (`m.replace`), threads (`m.thread`), unknown relation types,
relations that combine `m.in_reply_to` with another relation, extra relation
fields, and malformed relations. Ignore reactions, state events, notices,
emotes, media, files, locations, invites, membership events, and custom events.
Never accept a DM or newly joined room merely because its sender is allowlisted.

For a valid ordinary Matrix reply, strip its protocol-defined plain-text reply
fallback first. Preserve the result exactly and reject it if empty or
whitespace-only; do not trim the text sent to ACP. The remaining body must be
no larger than `max_input_bytes` UTF-8 bytes. Send only that body to ACP; do not
prepend sender, room, event, or relation metadata.

Authorization and normalization run before queueing or ACP session creation.
An oversized otherwise-authorized message always receives the exact configured
oversized response. Other rejections are silent except for metadata-only
diagnostics. Rate-limit diagnostics with a token bucket per `(room ID, reason)`
with burst 5 and refill 1 per minute, reporting the suppressed count with the
next permitted diagnostic. Logs contain timestamp, room ID, sender MXID, event
ID, and reason, but never bodies, content objects, tokens, raw ACP errors, or
Matrix request headers.

## ACP sessions, turns, and concurrency

Create one ACP session lazily for each configured room. Use `acp.cwd` and an
empty MCP server list. A room never receives context from another room.

ACP permits multiple sessions on one client connection. The bridge therefore:

- runs at most one turn at a time in each room session;
- permits one active turn plus at most `max_queued_turns_per_room` waiting turns
  per room;
- treats a turn as active from removal from the waiting queue through session
  creation, prompt, drain, and final Matrix delivery or abandonment;
- while startup dispatch is gated, designates the first buffered event as
  active, allowing `1 + max_queued_turns_per_room` buffered events per room;
- runs no more than `max_concurrent_prompts` unresolved `session/prompt`
  requests at once, acquiring the permit immediately before dispatch and
  releasing it when the prompt promise resolves, before draining; and
- lets an operator set `max_concurrent_prompts = 1` for an agent that needs
  connection-wide serialization. Waiting for the global permit still counts as
  the room's active turn.

A failed queue item other than `session/new` must not poison later items. A
full waiting queue receives the exact busy response and is not sent to ACP.
Start `max_turn_seconds` when `session/prompt` is dispatched; session creation,
post-response draining, and Matrix sending are outside that deadline. When it
expires, send `session/cancel`. If the prompt resolves within
`shutdown_grace_seconds`, render the timeout outcome and continue without the
normal post-response drain because cancellation orders pending updates before
the response. Otherwise the ACP connection is unhealthy and shutdown is fatal.

Keep a room turn open for update collection while its prompt is unresolved and
while draining trailing output. ACP v1 does not guarantee that normal-turn
updates precede the `session/prompt` response, and some agents begin streaming
several seconds afterward. After the response:

- if text has arrived, wait until its buffer is unchanged for 300 milliseconds;
- if no text has arrived, wait up to 30 seconds for streaming to begin;
- if no text arrives by the cap, finish with an empty response; and
- if the 30-second cap expires while text is still changing, treat session
  attribution as uncertain and perform fatal shutdown.

ACP v1 has no prompt identifier on updates. Correct attribution therefore
requires a compatible agent to emit every prompt's updates before this drain
closes. Ignore updates when no turn is open. Keep a bounded FIFO of the 1,000
most recently closed `messageId` values per session and ignore later chunks
using them. Id-less output arriving during a later prompt cannot be
unambiguously distinguished and remains an explicit ACP v1 limitation.

Do not start the next turn in that room until draining and Matrix delivery
finish; other rooms may continue. Only updates for the session with an open
turn contribute to its response. Ignore startup, load-history, replay, plan,
thought, tool, usage, and unsolicited updates. Concatenate text
`agent_message_chunk` content in arrival order; when distinct ACP `messageId`
values identify separate messages, join them with a blank line. Non-text chunks
are ignored.

The client automatically grants every ACP permission request. It selects an
offered `allow_always` option, falls back to `allow_once`, and returns
`cancelled` if neither exists. Selecting `allow_always` may cause the agent to
persist a grant; the bridge does not maintain, revoke, display, or audit that
agent-side permission state. Interactive approval is a later feature.

## Outbound responses

Every user-facing response is one or more ordinary top-level
`m.room.message` events with `msgtype: m.text`. Do not set `m.relates_to`,
`m.in_reply_to`, or `m.thread`, and do not include a quoted reply fallback.
Use these exact texts and stable response kinds:

| Outcome | Response kind | Exact text when no agent text exists |
| --- | --- | --- |
| Successful empty turn | `empty` | `The agent returned no text.` |
| Queue full | `busy` | `The room queue is full. Try again later.` |
| Oversized input | `oversized` | `Your message is too large.` |
| Timeout | `timeout` | `[agent timed out]` |
| Token limit | `max_tokens` | `[agent reached its token limit]` |
| Turn-request limit | `max_turn_requests` | `[agent reached its turn-request limit]` |
| Refusal | `refusal` | `[agent refused the request]` |
| Cancelled | `cancelled` | `[agent cancelled the request]` |
| Nonfatal agent/protocol error | `error` | `[agent error]` |

Successful nonempty `end_turn` output uses response kind `agent`. For other
stop reasons, join collected text and the exact status with `\n\n`; status text
is outside `max_output_bytes`. Transport failures are fatal and do not
guarantee a user response. Truncation does not change the response kind.

Keep at most `max_output_bytes` for agent text, blank-line message separators,
and the visible truncation marker. If the agent emits more, retain a valid
UTF-8 prefix while reserving room for and appending the exact marker
`\n\n[output truncated]`. Append any status after truncation.

If the rendered response fits in one Matrix part, send it without a prefix.
Otherwise iteratively partition it until the assumed and produced part counts
match, because prefixes affect capacity. At each split choose the last fitting
paragraph boundary (`\n\n`), then line boundary (`\n`), then Unicode extended
grapheme boundary from Node's `Intl.Segmenter`, and finally a code-point
boundary if one grapheme cannot fit. Keep delimiters in the preceding part.
Prefix final parts exactly as `[1/N]\n`, `[2/N]\n`, and so on. Prefixes count
toward each Matrix-part limit but not `max_output_bytes`; no part may exceed
`max_matrix_message_bytes` UTF-8 bytes.

For each part, UTF-8 encode the JSON serialization of this array:

```text
["matrix-acp-bridge-txn-v1", roomId, inboundEventId,
 responseKind, oneBasedPartNumber]
```

The transaction ID is `mab1_` followed by the unpadded base64url encoding of
the SHA-256 digest. All retries reuse it.

Serialize outbound sends with one mutex per room, ordered by response readiness;
a busy or oversized response may overtake an unfinished agent turn. Only one
Matrix send attempt may be active per room. The active turn does not finish
until all its parts succeed or its response is abandoned. Matrix send failure
never retries the ACP prompt. A permanent failure abandons that response,
skips its remaining parts, and unblocks the room.

Treat HTTP 408, 429, 5xx responses, network failures, and SDK-designated
retryable errors as transient. Honor Matrix `retry_after_ms` or `Retry-After`;
otherwise retry after 1, 2, 4, 8, 16, then 30 seconds with full jitter. Retry
with the same transaction ID until success or shutdown. Other non-success HTTP
responses are permanent.

## Initial sync, restarts, and delivery semantics

### Milestone 1

State is in memory. Every process start suppresses initial-history events in
the first cursor-bearing sync batch and accepts only later events, including
those buffered during post-ready startup validation. It does not catch up
messages sent while the bridge was stopped, resume ACP sessions, or promise
delivery across a crash.

Record every post-ready sync-batch event with a valid event ID in a global FIFO
set before authorization or normalization. Duplicates do not refresh insertion
order. Inserting entry 10,001 evicts the oldest. Events without a valid event ID
are rejected silently because no deterministic transaction ID can be formed.
A duplicate cannot produce another diagnostic, prompt, or response.

### Milestone 2 historical superseded design

The durable `pending`/`claimed`/`replying`/`completed` inbox design that was
formerly described here was superseded before implementation. The accepted M2
contract is the smaller best-effort cursor, bounded catch-up, optional
`session/load`, `/reset`, typing, receipt, and private-state design in
[spec/m2-persistence.md](m2-persistence.md). It does not provide durable event bodies, prompt replay,
exactly-once delivery, or automatic history pagination.

## Failure and shutdown behavior

The Matrix SDK owns homeserver reconnect and backoff. A healthy-transport
`session/prompt` JSON-RPC or agent error produces the generic response and does
not poison later turns. Unknown stop reasons do the same. ACP stdio EOF,
malformed NDJSON or JSON-RPC, read or write failure, connection failure, or any
`session/new` error is fatal. The bridge cannot reconnect inherited stdio.

On the first SIGINT or SIGTERM:

1. mark the bridge stopping, stop Matrix event intake, and stop dequeueing room
   turns;
2. silently drop waiting Milestone-1 turns;
3. send `session/cancel` for active prompts and answer pending permission
   requests with `cancelled`;
4. do not create new user-facing Matrix responses; allow active Matrix requests
   to finish but do not retry them;
5. wait at most `shutdown_grace_seconds` total from signal receipt;
6. flush Milestone-2 state, stop Matrix, close ACP transport, release the state
   lock, and exit zero.

If the deadline expires, force-close adapters and exit 1. A second signal exits
immediately with the conventional signal exit code. Other fatal runtime
failures exit 1 so the service runner can restart the complete relay. The
`cancelled` user-facing response is for an agent stop reason, not process
shutdown.

The bridge never starts or kills an ACP child. The service runner owns agent
commands, processes, relays, containers, mounts, networking, and restart
policy.

## Security requirements

- **Exact authorization:** Trust only immutable room IDs, sender MXIDs, and
  authenticated event metadata. Never trust aliases, display names, mentions,
  quoted text, or content fields that claim another identity.
- **User-managed rooms:** Do not create or join rooms, accept invites, invite
  users, or modify membership or power levels. Private invite-only rooms are
  the recommended deployment.
- **Least-privilege Matrix identity:** Use a token and device dedicated to the
  bridge account, never an administrator or authorized human's token. Rotate
  it after suspected compromise.
- **Agent sandbox is the execution boundary:** `allow_always` means the Matrix
  allowlist and the agent's OS/container restrictions protect local data and
  commands. An authorized user can still prompt-inject the agent.
- **Private state:** Sync data, pending inbox records, session IDs, and crypto
  stores can contain conversation text or keys. Keep them beneath `state_dir`,
  out of repositories, images, backups without equivalent protection, and
  normal logs.
- **Bound resources:** Enforce all configured byte, queue, and concurrency
  limits. Never download unsupported media merely to inspect it.
- **Protocol stream integrity:** Write only ACP NDJSON to stdout. Logs, metrics,
  stack traces, startup banners, and Matrix diagnostics go to stderr and must
  redact tokens and plaintext.

## E2EE

Milestone 3 adds `encryption = "required"`; the only other mode is
`"disabled"`. There is no mixed mode. Disabled mode fails startup if any
configured room is encrypted. Required mode fails startup if any configured
room is not encrypted or if crypto initialization, restoration, or room-state
validation fails. It never falls back to plaintext.

Use `matrix-js-sdk` with its supported Node Rust crypto backend. Initialize
crypto before sync, persist the crypto database beneath `state_dir`, and keep
the configured device ID stable. Do not process an encrypted event until the
SDK reports decrypted content; ciphertext and undecryptable events are never
forwarded to ACP.

The bridge manages only its local device state. Milestone 3 provides local
operator commands that open `/dev/tty`; they never reuse ACP stdin/stdout:

1. `crypto bootstrap` initializes and persists the configured Matrix device,
   publishes its device keys, records that bootstrap completed, and exits.
2. `crypto verify` participates in SAS verification with an existing
   trusted Matrix client, displays the verification data, requires local
   operator confirmation, and exits.
3. Normal daemon startup requires the bootstrapped device to be verified,
   restores the same crypto store, and fails closed if the store is missing,
   unreadable, or replaced.
4. The daemon reports undecryptable events as metadata-only diagnostics and
   allows normal SDK key retry behavior.

The commands may complete verification and permit an existing trusted device
to sign this device, but they do **not** create, reset, import, or export the
account's cross-signing keys, secret storage, key backup, or recovery keys.
They do not request a Matrix password for UIA. In particular, the bridge must
never reset an existing Matrix trust identity to make bootstrap succeed.

Losing the local crypto store after bootstrap creates a recovery incident and
may make old or offline messages undecryptable. Recovery is an explicit
operator action, not an automatic new-device fallback.

## Scope and milestones

### Milestone 1 — plain private-room bridge

- Node/TypeScript daemon using pinned `matrix-js-sdk` and ACP v1 SDK.
- Pre-created Matrix account, access token, device, and private rooms.
- Startup identity and joined-room validation.
- Exact global room/sender allowlists and `encryption = "disabled"`.
- One in-memory ACP session and serialized queue per room, with bounded
  cross-room concurrency.
- Global configured ACP cwd and empty MCP server list.
- Automatic `allow_always` permission selection.
- Ordinary top-level Matrix text responses, bounded multipart output, and
  deterministic send transaction IDs.
- No restart catch-up, durable sessions, thread handling, media, rich text,
  streaming edits, typing, receipts, controls, or approval UI.
- Graceful Matrix/ACP transport shutdown; no child-process management.

### Milestone 2 — accepted reliability and operator controls

The accepted M2 scope is defined by [spec/m2-persistence.md](m2-persistence.md): private sync cursor,
bounded best-effort offline catch-up, optional session restoration, `/reset`,
typing, receipts, and explicit state diagnostics. Durable inbox delivery and
automatic prompt/reply recovery remain deferred.

### Milestone 3 — accepted required E2EE

- `encryption = "required"` with encrypted-room validation and no plaintext
  fallback.
- Durable Rust crypto state and stable-device restart behavior.
- `/dev/tty` bootstrap and manual SAS verification commands; no QR,
  cross-signing, or recovery reset.
- New encrypted-room, offline catch-up, undecryptable-event, unverified-device,
  verified-device restart, and crypto-store-loss tests.
- Operator documentation for protected backup and explicit recovery.

## Verification requirements

Unit tests must cover:

- exact room and global sender authorization;
- self-event, bootstrap-history, edit, redaction, thread, malformed relation,
  unsupported message type, and size rejection;
- ordinary reply fallback stripping and relation-free outbound responses;
- one-session-per-room isolation, same-room serialization, cross-room
  concurrency limits, queue overflow, and queue recovery after rejection;
- ACP update correlation, post-response draining, load-history suppression,
  multipart UTF-8 splitting, aggregate truncation, and deterministic Matrix
  transaction IDs for every response kind;
- `allow_always`, `allow_once` fallback, and no-allow cancellation;
- token/state path ownership and mode checks; and
- Milestone-2 pending/claimed/replying crash points and stale session-load
  fallback.

Integration tests must prove first-sync suppression, live delivery, no
self-loop, no cross-room context, ACP EOF shutdown, Matrix reconnect, and the
accepted Milestone-2 offline catch-up. Milestone 3 adds eleven named hermetic
scenarios covering bootstrap, SAS, encrypted send/receive, restart, encrypted
history suppression, plaintext rejection, undecryptable events, verification
gating, fingerprint continuity, and missing/replaced crypto state.

## Later, only if useful

Streamed replies via Matrix edits, markdown, attachments, interactive ACP
approvals, multiple agents in one process, and a container runtime. If
approvals are added, introduce `approvals.ts` and bind each decision to its
room, session, tool call, requesting sender, and expiry.
