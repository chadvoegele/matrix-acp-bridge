# ACP steering transport

`src/acp-client.ts` implements the `_session/steering` extension on the same SDK
connection as `session/prompt`. SDK 1.3.0 supports custom method requests and
independent outstanding request IDs; no SDK upgrade is required.

## Reviewed upstream contract

On 2026-10-01, [pi-acp PR #115](https://github.com/svkozak/pi-acp/pull/115) remained
open and unmerged at head `d7f9cb2428c992c62aa759919c799c5619a9b10b`.
The [actual agent implementation](https://github.com/davidhs26/pi-acp/blob/d7f9cb2428c992c62aa759919c799c5619a9b10b/src/acp/agent.ts)
advertises `_meta.steering.supported = true`, awaits Pi's native `steer` RPC
before acknowledging `injected`, and returns `promptRequired` with reason
`noRunningTurn` when idle and opted in. Native steering failures become ACP
method errors. Without the opt-in it can start a detached turn and return
`startedNewTurn`, which the bridge treats as a fatal protocol failure.

This is source inspection and fake-stream validation. Real integration against
a finalized upstream revision has not been performed.

## Coordinator API

- `initialize().agentCapabilities?.steering === true` indicates support. Only
  strict boolean `true` in `_meta.steering.supported` enables this capability;
  absent, false or malformed optional metadata does not fail initialization.
  `loadSession` remains independent.
- `AcpClient.steer?(sessionId, text, timeoutMs): Promise<AcpSteeringOutcome>` is
  optional for existing test doubles and implemented by the production client.
  The coordinator must require both capability support and an installed method.
- The adapter sends one `_session/steering` request with `sessionId`, one text
  block in `prompt`, and mandatory
  `_meta.steering.idleBehavior = "promptRequired"`. It neither sends a prompt nor
  modifies the active prompt's text/activity collectors or cancellation.
- Successful results are `{ kind: "steering", outcome: "injected" }` or
  `{ kind: "steering", outcome: "promptRequired", reason: "noRunningTurn" }`.
  Extra result fields are ignored. Other outcomes/shapes fail closed.
- Healthy method failures return `{ kind: "method_error", operation:
"session_steering", fatal: false, methodNotFound: boolean }` with no raw error
  message/data. `methodNotFound` is true for JSON-RPC code `-32601`; the coordinator
  must disable steering for the connection. Method errors must not retry or
  resubmit input, since they can follow side effects.
- Protocol/transport failures return the existing fatal error shapes with
  operation `session_steering`, signal the fatal listener, and close the connection.

The coordinator supplies `timeoutMs` from the existing
`limits.startupTimeoutSeconds` using the normal bounded seconds-to-milliseconds
conversion. The adapter owns the steering timer, clears it on every terminal
path, and closes the shared connection on expiry. A lost acknowledgement is
ambiguous: timeout never retries steering or converts it to a prompt. The timer
is independent of the active turn's timeout. `close()` interrupts outstanding
requests and prevents further steering calls, including a response racing close.

Admission eligibility, one outstanding steering request per conversation,
serialization, reset barriers, dispatch/cancellation gating, conversion order,
silent independent durable completion, notices, and waiting for those callbacks
remain coordinator responsibilities. Acceptance by Pi does not prove consumption
by the model.
