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

## Verification on 2026-10-01

The actual PR head was fetched and built in an isolated source export inside the
verification agent's launcher worktree. The local pi-acp main checkout was only
inspected; it was not used or changed. This export avoids creating another Git
worktree, as required by the WAAP launcher instructions.

```sh
git fetch --no-tags https://github.com/svkozak/pi-acp.git refs/pull/115/head
git rev-parse FETCH_HEAD
# Observed: d7f9cb2428c992c62aa759919c799c5619a9b10b
mkdir -p node_modules/.steering-verification/pi-acp
git archive FETCH_HEAD | tar -x -C node_modules/.steering-verification/pi-acp
npm --prefix node_modules/.steering-verification/pi-acp ci
npm --prefix node_modules/.steering-verification/pi-acp run build
(cd node_modules/.steering-verification/pi-acp && node --import tsx --test test/agent-steering.test.ts)
pi --version
# Observed: 0.87.1
npm run build
node agent_tests/steering/real-agent-probe.mjs node_modules/.steering-verification/pi-acp/dist/index.js
```

The PR build passed and its seven steering tests passed. The opt-in probe uses
the production bridge ACP adapter and coordinator, the PR's real stdio server,
and the installed Pi process with its existing default model and authentication.
It requests a bounded `sleep 10` tool call in an isolated workspace. It does not
change model/provider settings, restart services or read credentials itself.
It verifies RPC acceptance, independently of whether the model follows the
correction:

- Initialize advertises steering; an idle request returns exactly
  `promptRequired` with reason `noRunningTurn`.
- Idle `/steer` automatically submits a tracked prompt and one idle notice.
- While that prompt remains unresolved and a tool is running, the next `/steer`
  completes silently; the injected event is durably recorded independently.
- The original prompt completes normally, with one final response and its own
  durable completion. No steering payload is resubmitted as a second prompt.

The probe prints only operation/outcome metadata and notice kinds. Its private
bridge state is removed after cleanup; agent-owned Pi history follows Pi's
normal retention behavior. It is opt-in and requires a Pi provider that is
already authenticated. Run it only against the explicitly built PR revision.

**Integration limits:** Matrix sends in this real-agent probe are modeled.
A live Matrix homeserver test was blocked: the verification worktree has no
`.env`, no provisioned harness environment and none of the required homeserver,
room, account, password or ACP command variables. No secrets were retrieved or
test devices provisioned. Real encrypted wire events, client thread display and
live Matrix retries were not manually validated. The existing hermetic crypto
and Matrix SDK harness covers encrypted thread roots, silent injection, fallback
and method-error notices, byte accounting and routing. Sync/ACP stream tests
cover live and catch-up batches, duplicate suppression, independent completed
IDs and recovery of an interrupted converted prompt. Those automated results
do not imply live Matrix validation or model consumption guarantees.

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
