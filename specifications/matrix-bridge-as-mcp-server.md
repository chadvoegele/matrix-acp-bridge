+++
status = "abandoned"
created = 2026-08-10
last_update = 2026-08-19
+++

# Matrix bridge as an MCP server

## Purpose

Allow an agent turn that did not originate from Matrix to send a message through
the bridge's existing Matrix account. The motivating case is scheduled work:

1. A user asks the Matrix-connected agent to send a reminder later.
2. The agent calls a separate cron or scheduler tool.
3. At the requested time, the scheduler starts an agent session.
4. That session calls a Matrix delivery tool exposed by the bridge.
5. The bridge sends the message through its existing Matrix client.

The audience is the bridge implementation and its operators. The feature must
work without sharing Matrix credentials or crypto state.

## Context

ACP cannot provide this callback. `session/update` notifications belong to the
ACP client connection that issued `session/prompt`. A response from a session
started by a scheduler is therefore returned to the scheduler's ACP connection,
not to the Matrix bridge's ACP connection.

The bridge solves this by continuing to act as an ACP client on inherited stdio
while additionally acting as an MCP server on a separate local transport:

```text
Matrix conversation
       |
       v
matrix-acp-bridge -- ACP stdio --> Pi
       ^
       |
       +-- local MCP: send_matrix_message
                       ^
                       |
cron fires --> scheduled Pi session
```

The two protocol roles are independent:

- ACP carries Matrix-originated prompts from the bridge to Pi.
- MCP accepts explicit outbound Matrix delivery requests from authorized agent
  sessions.

The MCP endpoint is not an ACP event subscription and does not broadcast agent
responses. The scheduled agent must explicitly call the delivery tool.

## Goals

- One local MCP server owned by the bridge process.
- One constrained `send_matrix_message` tool.
- Configured destination aliases.
- Idempotent Matrix transaction IDs for retries.
- Delivery through the bridge's existing Matrix client and encryption state.
- Outbound serialization with ordinary bridge responses.
- Readiness, shutdown, limits, diagnostics, and tests for tool calls.

## Non-goals

- Cron or scheduling in the bridge.
- Automatic forwarding of every ACP response.
- Access to arbitrary Matrix rooms, users, event types, or account operations.
- A public MCP endpoint.
- Another Matrix account, access token, device, or crypto database.
- Conversation-history transfer to scheduled agent sessions.
- Durable exactly-once delivery beyond Matrix transaction idempotency.
- Automatic availability of the tool in every Pi session.

## Specification

### Transport and lifecycle

The MCP server uses a transport supported by the selected MCP SDK and Pi
integration, separate from the bridge's ACP stdin/stdout. The initial
deployment must be local-only. A loopback Streamable HTTP listener with bearer
authentication is acceptable. A Unix-domain transport or reviewed local proxy
is preferable when supported by both endpoints.

The listener must not bind a non-loopback TCP address. Cross-host MCP
exposure, TLS termination, and remote authorization are outside this
specification.

The server starts accepting connections only after:

1. configuration and private state are validated;
2. the state-directory lock is held;
3. Matrix identity is verified;
4. required-mode crypto is initialized and its manifest is validated;
5. configured room membership and encryption invariants are validated; and
6. Matrix sync reaches the bridge's ready state.

Before readiness, tool calls fail without being queued. During shutdown, the
server stops accepting calls before Matrix intake and crypto are closed. Calls
already handed to the Matrix adapter may finish within the existing shutdown
window; later calls fail.

The MCP server never writes protocol traffic to the ACP stdout descriptor.
Diagnostics remain on stderr and must not contain message text, credentials,
room IDs, session IDs, or raw SDK errors.

### Tool contract

The server exposes exactly one initial tool:

```text
send_matrix_message(
  destination: string,
  text: string,
  idempotency_key: string
)
```

#### `destination`

`destination` is a configured opaque alias such as `chad` or `operations`. It
is not a Matrix room ID, room alias, user ID, homeserver URL, or arbitrary
address. Each destination maps to one room already present in
`matrix.allowed_rooms`.

The MCP client cannot enumerate room IDs. Unknown destinations fail without a
Matrix request. Aliases are unique, nonempty, and contain only a conservative
ASCII identifier alphabet.

#### `text`

`text` becomes the body of one ordinary top-level `m.room.message` with
`msgtype = "m.text"`. It must be nonempty, must not be whitespace-only, and is
limited by a dedicated outbound tool byte limit no greater than the existing
Matrix message limit. The tool does not accept formatted HTML, relations,
threads, replies, edits, mentions, media, state events, or caller-supplied
event content.

The bridge does not reinterpret the text as a prompt and does not add it to the
room's ACP session. A later Matrix reply from a user remains a normal inbound
bridge prompt.

#### `idempotency_key`

The caller supplies a stable, opaque key for one logical delivery, normally
the scheduler's job or firing ID. It must use a bounded conservative ASCII
format. Retries of the same logical delivery use the same destination, text,
and key. Callers must never reuse a key for different content.

The bridge derives a deterministic Matrix transaction ID from a domain
separator, the configured Matrix identity, destination room, and idempotency
key. Retries, reconnects, and process restarts therefore reuse the same Matrix
transaction ID. The transaction ID and derivation must not expose the original
key or room ID.

The bridge keeps a bounded in-memory key-to-request-digest cache to reject
conflicting reuse while it is running. Matrix transaction idempotency remains
the duplicate-prevention boundary across restart. As in Milestone 2, this is
best effort rather than a durable exactly-once claim.

#### Result

A successful tool result means the homeserver acknowledged the Matrix send. It
does not mean a user read or decrypted the event. The result contains only a
stable status such as `delivered`; it does not expose a Matrix event ID, room
ID, transaction ID, SDK response, or crypto metadata.

A failure returns a stable, content-free category suitable for retry policy:

- `not_ready`;
- `invalid_request`;
- `unauthorized`;
- `rate_limited`;
- `transient_delivery_failure`;
- `permanent_delivery_failure`; or
- `shutting_down`.

Transient Matrix failures follow the bridge's existing retry classification
and backoff policy. A retry must reuse the same transaction ID. Permanent
failures are not retried by the bridge.

### Configuration

The exact TOML shape is deferred until implementation, but configuration must
provide:

- whether the MCP server is enabled;
- its local transport address;
- a protected bearer-token file when the transport cannot rely solely on Unix
  peer and filesystem permissions;
- destination alias to configured room mappings;
- request size, rate, concurrency, and idempotency-cache bounds; and
- an explicit policy for making the endpoint available to bridge-created ACP
  sessions.

Enabling the MCP server is explicit. Existing configurations retain
`mcpServers: []` and open no listener.

### Matrix delivery behavior

MCP-originated sends use the bridge's configured Matrix account, access token,
device ID, and `matrix-js-sdk` client.

In disabled mode, the destination room must remain plaintext. In required
mode, the existing Rust crypto instance encrypts the message. No second
process may open or copy the bridge's crypto database while the bridge runs.

MCP sends share each room's outbound mutex with responses to Matrix-originated
turns. Only one Matrix send attempt may be active per room. MCP delivery does
not consume an ACP prompt permit and does not enter the inbound room turn
queue. This prevents a scheduled delivery from blocking agent work while still
preventing outbound interleaving.

Messages are ordinary top-level text events. They intentionally have no
inbound Matrix event to reply to and no relation metadata. Their
transaction-ID domain is distinct from ordinary bridge response transaction
IDs, preventing a tool key from colliding with an inbound-event response.

The bridge ignores the resulting own-user timeline event under its existing
loop-prevention policy, so an MCP send cannot create another ACP prompt.

### Tool availability in Pi

Starting the MCP server does not make its tool globally available. Each Pi
session that may send scheduled messages must connect to the endpoint.

For bridge-created ACP sessions, a later implementation may advertise the
endpoint in `session/new` and `session/load` instead of the current
`mcpServers: []`, if the selected Pi ACP backend supports the chosen transport
and authentication contract.

A session created by another ACP client, including a cron runner, does not
inherit MCP servers supplied by the bridge's ACP connection. The scheduler
must configure the same MCP endpoint for that session, or a reviewed Pi
extension must register an equivalent tool globally. Sharing one Pi server
process or listening socket does not change this requirement.

### Failure and restart semantics

If the bridge is unavailable when a schedule fires, the MCP call fails. The
scheduler owns retry timing and expiry and must retain the same idempotency
key. The bridge does not persist scheduled jobs.

If the homeserver acknowledges a send but the caller loses the MCP result, a
retry uses the same Matrix transaction ID. If the bridge crashes before making
the Matrix request, a retry sends it normally. Existing Milestone-2
limitations still apply to process crashes and homeserver behavior.

Required-mode crypto failures preserve Milestone 3's fail-closed behavior. The
bridge must not send plaintext as a fallback and must not accept further MCP
calls after a fatal Matrix or crypto failure.

### Use cases

#### Fixed reminder

```text
Initial Matrix turn:
  user -> agent: "Remind me to check the oven in five minutes."
  agent -> cron tool: schedule(job-17, +5m, destination="chad",
                               text="Check the oven.")

Five minutes later:
  cron -> bridge MCP: send_matrix_message("chad", "Check the oven.", "job-17")
  bridge -> Matrix: "Check the oven."
```

A fixed reminder does not need another agent turn: a scheduler may call the
MCP tool directly. A scheduler may start an agent first when the message must
be generated or updated at delivery time.

#### Agent-generated scheduled message

```text
Initial Matrix turn:
  user -> agent: "In five minutes, check the build and tell me its status."
  agent -> cron tool: schedule agent task job-18

Five minutes later:
  cron -> separate Pi session: "Check the build and report the result."
  scheduled agent -> bridge MCP:
      send_matrix_message("chad", "The build passed.", "job-18-delivery")
  bridge -> Matrix: "The build passed."
```

The scheduled Pi session has its own context unless the scheduler explicitly
loads another session. Concurrent prompts against one persisted ACP session
are unsafe and remain outside this specification.

### Implementation boundaries

A likely implementation adds:

- `mcp-server.ts` for MCP transport, authentication, schema validation, and
  stable tool results;
- a direct outbound message contract in `types.ts` that does not require an
  inbound Matrix event ID;
- direct-send support in `matrix-client.ts` using a caller-independent,
  deterministic transaction ID;
- outbound coordination in `bridge.ts` shared with ordinary room sends;
- strict optional MCP configuration and private-secret loading in `config.ts`;
- composition and lifecycle wiring in `main.ts`; and
- unit and hermetic integration tests without a real MCP client, homeserver,
  or Pi process.

`mcp-server.ts` must not import Matrix SDK wire types. `matrix-client.ts`
remains the only module that imports `matrix-js-sdk`. MCP request types must
not leak into Matrix authorization or ACP adapters.

## Security and privacy

The MCP endpoint is a privileged local interface. Any caller that can invoke
`send_matrix_message` can cause the bridge account to speak in every
configured destination exposed to it.

The implementation must:

- authenticate before parsing or retaining tool arguments beyond protocol
  requirements;
- compare bearer credentials without content-dependent early exit;
- expose only explicitly configured destination aliases;
- reject arbitrary Matrix identifiers and event content;
- cap request bytes, text bytes, calls per interval, and concurrent calls;
- avoid logging credentials, text, destination mappings, or identifiers;
- return fixed failure categories instead of raw Matrix or MCP errors;
- preserve the existing process lock and private-state checks; and
- document that agent prompts can intentionally or accidentally invoke the
  tool.

The service runner should restrict network and filesystem access so only the
bridge and intended Pi or scheduler processes can reach the endpoint. MCP
authentication supplements rather than replaces OS isolation.

The bearer token follows the Matrix access-token file's private path, owner,
mode, symlink, and content rules. It is never accepted directly in TOML, an
environment variable, a command-line argument, diagnostics, or tool results.
It must be a separate secret from the Matrix access token.

## Alternatives considered

### Use a standalone Matrix CLI client

Instead of adding an MCP server to the bridge, scheduled and agent-initiated
messages can be sent with a standalone Matrix CLI client such as
[matrix-commander](https://github.com/matrix-commander/matrix-commander). The
scheduler or agent session invokes the CLI directly with its own credentials
or an appservice account, and the bridge is not involved in outbound
delivery.

This approach was preferred and this specification is abandoned in its favor:

- it adds no new attack surface, listener, or secret to the bridge;
- it needs no bridge readiness, lifecycle, or shutdown coordination;
- the delivery path, retry, and idempotency behavior stay in the scheduler
  and CLI rather than the bridge;
- the bridge keeps its single ACP-client role.

## Verification

The implementation is complete only when hermetic tests show:

1. a valid authenticated tool call sends one top-level text event to its
   mapped room;
2. the same idempotency key retries with exactly one Matrix transaction ID;
3. conflicting key reuse, unknown destinations, malformed text, and oversized
   text make no Matrix request;
4. missing or incorrect authentication makes no Matrix request and reveals no
   destination information;
5. a scheduled send and ordinary bridge response in one room never have
   concurrent Matrix send attempts;
6. required mode encrypts through the existing crypto instance and never
   falls back to plaintext;
7. pre-readiness, fatal-state, and shutdown calls fail without being queued;
8. an MCP-originated own-user timeline echo never becomes an ACP prompt;
9. a separate ACP client receives no implicit access to the MCP tool; and
10. diagnostics and tool failures contain no credentials, message text, room
    IDs, session IDs, transaction IDs, or raw SDK errors.
