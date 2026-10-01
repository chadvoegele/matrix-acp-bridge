# Steering verification work log

Agent: `aa-steering-verification-exec` (steering-verification-exec)
Ticket: `tt-steering-integrated-verification-and-operator-docs`
Branch: `aa-steering-verification-exec`

## 2026-10-01 — intake and audit

- Read agent instructions, both WAAP skill copies, developer role, ticket,
  authoritative steering specification and implementation plan, and git skill.
- Marked only this ticket in-progress; `waap check` passed.
- Work remains in the launcher worktree. No worktrees, main changes, merge,
  push, PR, service restart, or deployment will be performed.
- Auditing command selection, capability/wire adapter, coordinator lifecycle,
  sync durable completions and recovery, threaded/encrypted notices and byte
  accounting; existing predecessor tests alone are not acceptance evidence.
- Existing local pi-acp checkout is main at
  `d1cffc047ab37a096ee70ca39cfc1de463db8d12`; it was inspected read-only and is
  not used for integration. PR #115 remains open. Fetched its actual head into
  this repository's FETCH_HEAD and exported the source under ignored
  `node_modules/.steering-verification/pi-acp` to obey the prohibition on new
  worktrees. Exact PR revision: `d7f9cb2428c992c62aa759919c799c5619a9b10b`.
- Pi executable is available at `/usr/local/bin/pi`, version `0.87.1`.
  Build and live prerequisite checks are pending; no credentials were read.

## 2026-10-01 — changes and findings

- Independently reviewed the complete steering spec and delivery plan against
  configuration/authorization/selection, ACP client, coordinator, daemon wiring,
  sync coordinator, durable state, rendering and Matrix encryption boundaries.
  Read referenced thread, persistence, verbose-output and encryption guidance,
  relevant tests and upstream PR implementation. No SDK upgrade is needed:
  dependency and lock remain pinned to SDK 1.3.0.
- Found a concrete lifecycle defect: `#deliverParts` checked lifecycle before
  acquiring the room mutex, allowing a queued steering error notice to start an
  SDK send after forced shutdown when the original send finally released it.
  The new regression failed with both event IDs sent before the fix. Added a
  check immediately before each send, covering mutex waits and multipart sends.
  The regression now passes. Existing deliberate best-effort session-creation
  error behavior remains covered by the full suite.
- Added seven meaningful regression tests: held session/load for both room and
  thread catch-up batches; queued notices after forced shutdown; forced shutdown
  with a pending accepted-injection or method-error durable callback; a real
  atomic state-write failure after injection; live/catch-up daemon sync batches
  with FIFO conversion and restart suppression; encrypted thread routing across
  real fake-ACP streams; full serialized byte budgets for split steering notices.
- Extended the existing stream peer and hermetic crypto/Matrix SDK rig with the
  actual extension and initialize metadata. Tests keep the original prompt
  unresolved, observe exact wire params, serialize steering, and check the ledger
  independently of the original turn. Explicit `/prompt` remains FIFO while
  other messages steer. Restart suppresses the injected ID and replays only the
  incomplete converted prompt.
- Added an opt-in real-agent probe and exact build/probe instructions in
  `docs/steering-acp-transport.md`. Updated README operator guidance for commands,
  defaults, cross-lane behavior, idle/unsupported fallback, acceptance versus
  consumption, Pi queue scheduling, bounds, threads, failures, cancellation and
  restart limitations. README TOML and config example normalize identically.
- Reviewed complete production diffs against `origin/main` at
  `2d9e8404ddf694934701c11746fd0359f3b5da24`, plus predecessor test and ancillary
  changes. The fixture default additions support the required config field;
  ESLint's 32-to-33 default-project allowance supports the added selection test.
  No unrelated churn, dependency changes, state schema changes, raw-error replay,
  newly concurrent prompts or collector/timer replacement were found. Only the
  bounded lifecycle defect above required a production fix in this ticket.

## Acceptance mapping — every steering specification section

| Section / requirement | Inspected implementation and evidence |
| --- | --- |
| Purpose, context and goals | Separate prompt FIFO and serial steering lane in `src/bridge.ts`; actual PR acknowledgement verified during a running tool. Acceptance is independent of consumption. |
| Non-goals | One unresolved prompt per conversation; no agent spawning, detached turns, new Matrix input types, image support, turn restart, cancellation approximation or Pi queue emulation. |
| Configuration and commands | `src/config.ts`, `src/message-delivery.ts`, authorizer-before-selection in `#submit`; config and selector suites cover default/invalid values, explicit overrides, preserved Unicode/multiline payload, empty commands, exact reset, slash text and payload `/reset`. Oversized original command, unauthorized and duplicate input tests send no unintended RPC. |
| Conversation routing | Existing conversation identity/key and known-thread checks reused for both modes. Room/thread coordinator tests cover independent roots, follow-ups, unknown threads and unrelated reply fallbacks. New encrypted stream test checks distinct top-level sessions and root-specific injection, notices and final output. |
| Prompt FIFO and steering admission | Sequence-bearing entries, reserved active entry, shared waiting count and `#pumpConversation`/`#pumpSteering`; unit tests cover bypass of waiting ordinary prompts, serial steering, busy bounds, active exclusion, closed gates, held creation, held load, global permit waiting and post-prompt drain. Live and catch-up daemon batch test validates the full composition. |
| No new calls after closed dispatch/cancellation/timeout | Pump gates check dispatch/stopping/fatal and run's started/resolved/cancel state. Existing clock tests prove no extra steering after timeout/cancellation and no timeout reset or extra permit. Adapter close/timeout tests prevent further RPCs. |
| Capability and exact wire contract | `src/acp-client.ts` reads only boolean metadata true and preserves loadSession. ACP tests cover true/false/absent/malformed metadata, independent request IDs, mandatory idle opt-in, reversed session replies and concurrent pending prompt. Actual PR head built and real server responses verified. |
| Injected completion | Decision/capacity release is separate from the `#steeringWork` lifetime. Existing independence tests plus new sync/real-agent disk checks prove silent completion before the original prompt; no extra prompt or collector. |
| promptRequired conversion and boundary race | Same entry/event/payload transfers capacity, sequence insertion preserves order, terminal callback withheld until prompt completion. Existing before-prompt-response and reset races plus new daemon recovery test prove no premature next turn/reset or completed fallback ID. |
| Malformed or detached outcomes | Adapter and coordinator tests reject missing/unknown/malformed results, invalid reason and `startedNewTurn`; extra unrelated result metadata is ignored. Failures close without replay. |
| Compatibility and reset | Unsupported capability or method-not-found converts to existing FIFO; current connection support is disabled globally on missing method. Earlier steering decisions settle before reset; later input becomes prompt behind the barrier and uses the replacement session. Existing explicit reset, unsupported payload/usage and queued reset race tests cover this. |
| Output and privacy | Original collector/activity/typing remain untouched. Encrypted SDK contract tests include all new response kinds and prohibit plaintext fallback. New encrypted threaded notices and renderer tests check full payload bytes, roots/reply targets, deterministic split results and sanitized method errors. |
| Method errors, transport and state failure | Healthy method error completes only the steering event, does not cancel or resubmit, and displays sanitized notice. SDK timeout/transport/protocol tests and coordinator malformed tests fail closed. New actual atomic write-fault test leaves the injected ID incomplete, triggers state fatal, and sends no replacement ACP input. |
| Lifecycle, cancellation, shutdown and idle | Pending decisions block replacement prompts/resets and are interrupted at grace; pending durable callbacks remain tracked after decision/capacity removal. Forced `stop()` returns at its existing grace bound while `waitForIdle` truthfully remains pending until durable work settles. New regression covers both injection and error callbacks and forbids late redelivery/output. Original collectors are not revived. Queued Matrix sends now recheck lifecycle. |
| Catch-up and restart | Existing age/count selection remains authoritative. New real-stream daemon test admits full live and initial recovery batches, preserves selection before dispatch/setup, suppresses pending duplicates and completed injected IDs, and recovers only an incomplete converted prompt. No state schema migration was introduced. |
| Crash gaps and server queue limits | Documented in README: ACP acceptance before durable completion may replay, queue acceptance does not imply consumption, bridge/Pi in-flight work is not promised recoverable, bridge backlog does not bound Pi's accepted queue, and cancellation is session-scoped. |
| Delivery scope | Required config/adapter/coordinator/rendering/sync/default fixture changes already integrated from predecessors; this branch completes regression coverage, lifecycle remediation and operator docs. SDK pin is unchanged. |
| Verification | Full `npm run check` and real Pi/PR ACP probe passed. Live Matrix homeserver remains untested for the concrete prerequisites below; fake crypto results are not represented as real encrypted wire validation. |
| Open questions and references | PR #115 remains open at the exact tested revision below; no finalized release/main support or Pi queue capacity/consumption visibility is assumed. |

## Exact checks and results

- `npx tsc -p tsconfig.test.json --pretty false` plus targeted new tests:
  five tests for shutdown, sync, encryption and rendering passed, then the two
  held-load and actual-write-fault tests passed. Bring-up found and corrected
  one inference annotation, lint formatting/assertion issues and the renderer
  fixture's multipart-label regex; the final gate below passed cleanly.
- `npm run check > node_modules/.steering-verification/check.log 2>&1`:
  exit 0. Prettier, full ESLint, production/test typechecking, build and all
  **447 tests passed**, 0 failures/cancelled/skipped (test duration 12.62 seconds).
  This adds seven tests to the integrated predecessor baseline of 440.
- Parsed README's TOML with production `parseConfigText` and deep-compared it
  to parsed `config.toml.example`: identical normalized configuration.
- `git diff --check` and staged diff check: passed. Independent production and
  ancillary diff inspection vs the recorded `origin/main` reference completed.
- `waap check`: passed at intake and again before handoff; final validation
  repeated after committing this log.

## Real integration: commands, outcome and limitations

1. `git fetch --no-tags https://github.com/svkozak/pi-acp.git refs/pull/115/head`
   succeeded; `git rev-parse FETCH_HEAD` yielded
   **`d7f9cb2428c992c62aa759919c799c5619a9b10b`**.
2. `mkdir -p node_modules/.steering-verification/pi-acp` and
   `git archive FETCH_HEAD | tar -x -C node_modules/.steering-verification/pi-acp`
   exported that exact source within the existing worktree.
3. In that export: `npm ci && npm run build && node --import tsx --test test/agent-steering.test.ts`:
   build succeeded, **7 upstream tests passed**, 0 failures. Dependency audit
   reported upstream vulnerabilities; no upstream dependencies were changed.
4. `pi --version`: installed Pi **0.87.1**. No system, model, provider or auth
   settings were changed, and no credentials were read or fetched.
5. `npm run build` then
   `node agent_tests/steering/real-agent-probe.mjs node_modules/.steering-verification/pi-acp/dist/index.js`:
   **exit 0** using the actual PR server, real Pi subprocess, production ACP
   adapter/coordinator and an isolated workspace. Observed:

   ```json
   {"phase":"initialize","steering":true}
   {"phase":"session/new","result":"created"}
   {"phase":"idle steering","result":{"kind":"steering","outcome":"promptRequired","reason":"noRunningTurn"}}
   {"phase":"tracked idle fallback","unresolvedPrompts":1,"notices":["steering_idle"]}
   {"phase":"active steering","durableCompletion":true,"unresolvedPrompts":1,"notices":["steering_idle"]}
   {"phase":"tracked turn completion","unresolvedPrompts":0,"notices":["steering_idle","agent"]}
   ```

   The probe reopens the actual private bridge state to confirm the injected ID
   completed while the original remained incomplete. It checks silent injection,
   normal original completion and independent durable callbacks. The earlier
   exploratory probe used a synthetic callback only; the committed probe above
   adds the actual disk assertion and is the acceptance result reported here.

**Concrete manual limitation:** Matrix sends in this real-agent probe are
modeled. No live Matrix homeserver test ran: cwd has no `.env` or provisioned
`environment.json`; all E2E homeserver/room/account/password/ACP-command variables
are unset (checked presence only). Consequently real encrypted wire types,
Matrix client thread display, live retries and real concurrent thread-agent
behavior were not manually verified. The encrypted/thread evidence is hermetic
crypto + SDK + real fake-ACP streams. No model-consumption or exactly-once claim
is made. No hosting daemon/service was restarted, no test Matrix devices were
provisioned, and upstream main was not run as a steering server. Pi-owned probe
history follows existing agent retention; the probe removes its temporary bridge
state and terminates only its own process group.

## Committed handoff

- Code branch: **`aa-steering-verification-exec`**.
- Code commit: **`2e4a3fe116b8a9225bf3623e47cfa5b23fa9e472`** —
  `aa-steering-verification-exec tt-steering-integrated-verification-and-operator-docs: verify steering recovery and shutdown`.
- Seven files committed: README, transport verification doc, opt-in real-agent
  probe, bounded production lifecycle fix, coordinator regressions, stream/crypto
  integration regressions and rendering byte-budget coverage. Code worktree clean.
- This log is committed separately and exclusively on WAAP state. Ticket remains
  **in-progress** for the integration coordinator. No main change, merge, push,
  PR, deployment or ticket completion was performed. Coordinator should
  integrate the above branch into `feat/message-delivery-steering`, rerun gates
  and disclose the live Matrix limitation when preparing the implementation PR.
