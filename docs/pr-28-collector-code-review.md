# PR #28 collector CODE.md review

Chad's Agent

This is a fresh item-by-item review of the collector implementation, including
all changes in PR #28 rather than only its latest refactor commit. It supersedes
the current-code assessment in the [pre-refactor review](pr-28-code-review.md);
that report and its verification results remain historical.

The eager-rejection follow-up removes the earlier reachable ID-less assistant-text
compatibility described in row 12. That row records the `d553581` audit; the current
[architecture](unified-rendering-architecture.md) and
[verification](collector-rendering-verification.md) supersede its compatibility claim.
The follow-up removes turn groups/history/drain and prompt-result accumulation,
uses one shared ID predicate at intake boundaries, and adds no component, output
operation, configuration, persistence or retry owner. The eight-stage component
map and flush/finish contracts still apply. Remaining legacy thoughts/tools are
explicitly retained. The original 56-item findings below stay revision-qualified.

## Revisions and scope

- Guideline source: `/home/chad/code/code.voegele.me/chad/agents/main/CODE.md`
  at `db0a8fa7b0bbe49d1539c2ff53a5e93c748dbb46`; checked file blob
  `81ef759914fe7f1512ee633910f0ddd50ced8d9d` matches that revision exactly.
- Reviewed feature revision: `e3d6626df064c90a6721cca369fbb57d826f438a`.
- PR base and merge base: `93ba97150f43a14539f910dab09a3d099a0dd40c`
  (`origin/main` as locally recorded for this audit).
- Audited remediation/code-test revision:
  `d553581be53b53f68ccfce78e8ab61442f48383b`, integrated into
  `feat/unified-message-rendering`. Subsequent report-only edits pin revisions
  and record independent coordinator validation; they do not change code/tests.
- Read all 58 PR-changed paths against that base, including removed batch code
  and tests; inspected surrounding normalization, Markdown, size/envelope,
  routing, delivery and lifecycle interfaces. Source/tests cover ACP forwarding,
  configuration, all four collectors/model/scheduler, renderers, sender, queue,
  bridge and integration. Runner/cleanup changes, static configuration, README,
  implementation/verification guides, both specifications and all four SVGs
  are included. Six unrelated test fixtures only add required flush settings.

The source has **56 evaluative numbered items/sub-items**, in order:
Architecture 5 + Code Structure 6 + Eliminate Debt 2 + Abstractions 6 + Scoping 4 +
Naming 6 + Responsibilities 4 + Comments 2 + Dependencies 3 + Logging 1 +
Errors 2 + Feel 13 + Testing 2 = **56**. Parent items are assessed separately from
nested items. Rows 01–56 below reproduce each guideline's wording, retaining its
source section and hierarchy. The four bibliography entries are separate and
excluded from this count. Final dispositions: **32 passes, 10 fixed, 14 justified
qualifications, zero remaining issue rows**. Dispositions are `passes`, `fixed`,
`justified qualification`, or `remaining issue`; qualifications are deliberate
limits, not blanket compliance claims.

## Findings and remediation

1. **Tool identity collision:** raw ACP `toolCallId = "anonymous-tool-0"` and
   the first ID-less tool previously selected the same card entry. One could
   replace/finish the other. `ToolCollector.accept` now namespaces identified and
   anonymous entry keys; snapshots still preserve the raw tool-call ID. The
   integrated regression checks both the old generated-looking ID and the current
   `anonymous:0` form, both visible entries, independent completion, collapse,
   original edit target and eventual retirement.
2. **Rejected model retention:** `AcpToolModel.accept` created an event before
   `ToolCollector` checked capacity. A callback that kept intake open left each
   rejected event retained and later allowed patches for a never-accepted start.
   The collector now releases that new event before calling `onCapacity`.
   A 20-rejection regression frees the accepted tool, verifies late rejected-ID
   updates stay ignored, and verifies a subsequent genuine start still works.
   Production already stops the queue on capacity; the fix also makes the local
   collector contract bounded without depending on that callback's side effect.
3. **Constructor guards:** tools now reject invalid retention and scheduler
   settings before intake; cards reject invalid event/byte limits as well as
   retention. Tests exercise zero, negative, fractional, NaN, infinite and unsafe
   integer limits and invalid pacing. Existing valid configuration is unaffected.
4. **Card rollover/cleanup:** the card retention guard ran before rollover could
   close/release a finished current card, so otherwise valid sequential output at
   the configured bound could be rejected. Rollover now releases eligible state
   before applying retention capacity. Also, synchronous publication failure/close
   could previously be followed by new card allocation or another collapse/finish
   callback. Card composition now rechecks closure after publication and clears
   the current-card pointer on collapse. Regressions cover 20 completed rollovers
   with a one-entry retention limit, close during unfinished/finished rollover,
   and close during a delayed card's mandatory first expanded publication.
5. **Cleaned-empty legacy thoughts:** ID-less ANSI/control-only initial chunks
   could reserve an invisible card entry/timer because the nonempty guard preceded
   cleaning. `SessionOutput.accept` now cleans both thought paths before deciding
   whether to reserve. The extended blank-thought regression checks no entries,
   cards or timers are allocated and both tool slots remain available. Meaningful
   thought whitespace/continuations and the coordinator's identified-thought fix
   remain covered.
6. **Scope/dead interface cleanup:** made unused exported `ActivityCardLimits`
   private and removed the obsolete `AcpThoughtActivity.messageId` field. Card
   entry indexes own thought identity; content DTOs need only text/cut. These are
   type-only changes and preserve emitted runtime behavior.
7. **Review quality/naming:** restored exact marker-inclusive UTF-8 bytes/content
   in the ACP thought truncation regression. Refactor-introduced setup helpers now
   use `createFixture`, `createPart`, `createGate`; behavioral assertions remain.

The changes affect edge-case tool identity/retention, card rollover/cleanup and legacy thought admission;
they add no public operation, timing setting, dependency, stored schema, transport
retry or diagram component. The approved [collector specification](../specifications/collector-based-output-rendering.md)
still governs cumulative flush/finish, emitter-local sender mappings, final-delivery
retirement, old live cards, safe shared thought Markdown, bounded state and placement
at first publication. Existing sender/blocked-send tests verify expanded-before-collapse
barriers, finish during originals/edits, and continuation shrink/growth using original
event IDs. These fixes require coordinator review and would need real Matrix/Pi
validation before a new complete live claim.

## Itemized assessment

### Architecture

| Row / source item | Guideline                                                                                               | Disposition and current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01 / 1            | Make sure the code could be expressed in a diagram of 5-10 components with directional logical flow.    | **passes** — [Component map](unified-rendering-architecture.md) has eight directional stages: dispatch, text, tools, cards, message rendering, card rendering, sender, queue/delivery. `SessionOutput` composes them; it does not deliver Matrix events.                                                                                                                                                                                                         |
| 02 / 1.1          | Ensure self-similar diagramming property when zooming into any component.                               | **passes** — Zooming into `TextCollector` yields bounded accumulation → `PublicationScheduler` → `OutputSink`; zooming into `MatrixOutputSender` yields pending snapshot → original/continuation delivery → explicit mapping retirement. The [session diagram](unified-rendering-session.svg) depicts those hand-offs.                                                                                                                                           |
| 03 / 1.2          | Avoid spaghetti code.                                                                                   | **passes** — `SessionOutput.accept` dispatches by update kind; `ActivityCardCollector` owns entry/card associations; `MatrixOutputSender.#deliver` alone tracks originals. Imports and callbacks form directional content flow; no collector calls back into bridge routing.                                                                                                                                                                                     |
| 04 / 2            | Prefer composable designs with interchangeable components that express different application behaviors. | **passes** — `OutputSink<Content>` admits recording sinks in collector tests and rendering adapters in production. Messages/thoughts instantiate the same `TextCollector`; separate sender instances isolate equal IDs without a transport-specific collector base class.                                                                                                                                                                                        |
| 05 / 3            | Generally prefer immutable data structures, since immutable code is easier to reason about.             | **justified qualification** — `TextSnapshot`, `ActivityCard` and `MatrixHtmlBody` expose readonly publication values; `ToolCollector` copies each mutable model event before emitting. Collectors keep their changing model fields, timers, queues and live mappings within each owner. This is compile-time readonly/snapshot discipline, not recursive runtime freezing; `AcpToolModel.events` remains a mutable model inspection seam used by existing tests. |

### Code Structure

| Row / source item | Guideline                                                                                                      | Disposition and current evidence                                                                                                                                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 06 / 1            | Prefer shallow indentation. Use early returns and focused helpers to reduce nesting.                           | **passes** — `TextCollector.append`, `SessionOutput.accept`, `ActivityCardCollector.#finish` and `MatrixOutputSender.flush` reject closed/irrelevant work early. Card addition, emission, collapse and release are focused private helpers instead of one nested dispatcher.                                                            |
| 07 / 1.1          | Separate wrappers, such as lock acquisition, from core logic; encapsulate conditional logging in a helper.     | **passes** — `MatrixDelivery.#serializeRoom` wraps delivery policy; bridge `#reportRenderingAbandoned` centralizes conditional capacity diagnostics/fatal recovery advice. `#ensureSessionRendering` keeps generation checks and outbound accounting around the delivery callback, outside pure rendering.                              |
| 08 / 2            | Group components by functionality, not by type.                                                                | **passes** — `text-collector.ts`, `tool-collector.ts`, `activity-card-collector.ts` and `session-output.ts` group state with its behavior. Rendering and sender modules are functional owners; tests are adjacent to their production owners.                                                                                           |
| 09 / 2.1          | Avoid catch-all files that have only data structures.                                                          | **justified qualification** — New `output-sink.ts` includes the `renderOutput` adapter, rather than being a catch-all DTO file. Existing `acp-activity.ts` co-locates activity DTOs and `AcpToolModel`; its DTOs describe one activity domain. Unchanged protocol/type modules are not consolidated for this audit.                     |
| 10 / 3            | Avoid metaprogramming wherever possible; prefer explicit code that is easy to inspect and reason about.        | **passes** — `SessionOutput.accept` uses explicit update-kind branches; collector state is ordinary maps/classes. `scripted-unified-acp.mjs` uses an explicit JSON-RPC switch; `test-unified.sh` selects four static mode/transport commands. No runtime code generation in production.                                                 |
| 11 / 3.1          | Apply the same principle to configuration: prefer static config files over dynamic files rewritten at runtime. | **justified qualification** — `config.toml.example`, `parseConfigText` and `validateAgentTextSettings` use static supported keys. E2E `makeConfig`/`writePrivateFile` generate disposable test configuration and `cleanup.test.mjs` writes a tiny isolated peer fixture; these do not rewrite installed source or daemon configuration. |

### Eliminate Debt

| Row / source item | Guideline                                                                                  | Disposition and current evidence                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 12 / 1            | Dead code should be removed.                                                               | **fixed** — PR diff removes `acp-activity-batches.ts` and its mixed model thought path; this audit also removes the obsolete `AcpThoughtActivity.messageId` field; no references to `AgentTextBuffer`, `SessionActivity` or `AcpActivityBatches` remain in production. Historical reports retain those names with explicit revision labels. Existing ID-less turn collection remains reachable compatibility code. |
| 13 / 2            | Repair code as you go to avoid accumulating debt and confusing defects before they spread. | **fixed** — Tool identity collision, rejected-model retention and missing constructor guards are repaired at their owners; `SessionOutput.accept` cleans legacy thought text before reserving state. Regression tests reproduce the pre-fix failures. ACP truncation checks again assert exact content/bytes rather than an approximate prefix.                                                                    |

### Abstractions

| Row / source item | Guideline                                                                                                                                                                      | Disposition and current evidence                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14 / 1            | Consider data-object anti-symmetry:                                                                                                                                            | **passes** — `ActivityCard`/`TextSnapshot` are values operated on by independent pure renderers; collectors/sender hide lifetime state behind methods. This separates data traversal from commands without placing rendering behavior on every DTO.                                                                                                                                                            |
| 15 / 1.1          | Use data structures when you expect to add more functions over time since adding functions on existing data structures doesn't require modifying the existing data structures. | **passes** — `renderActivityCard` and `renderAcpActivity` consume structured activity values, so another presentation function can consume them without changing collector classes. `renderMatrixTextChunks` operates on text snapshots without changing accumulation.                                                                                                                                         |
| 16 / 1.2          | Use class interfaces when you expect to add more class implementations over time since adding more implementations doesn't require modifying existing interfaces.              | **passes** — `OutputSink` has only `flush(id, content)` and `finish(id)`; recording sinks, `renderOutput` adapters and `MatrixOutputSender` implement that boundary. Alternative delivery implementations can satisfy it without adding methods to collectors.                                                                                                                                                 |
| 17 / 2            | Use abstractions to minimize the amount components need to know about each other.                                                                                              | **passes** — `PublicationScheduler` knows settings/clock/publish callback only; collectors know sinks, not Matrix event IDs. `MatrixOutputSender` knows rendered parts/queue/publish, not ACP tool patch rules. `MatrixDelivery` retains the sole retry policy.                                                                                                                                                |
| 18 / 3            | Ensure internal component details do not 'leak' so that external components need to know more than just the interface.                                                         | **justified qualification** — `SessionOutput` necessarily knows card measurement and composes collectors/renderers/senders. `ActivityCardLimits.measure` is an injected pure function; `liveCount`, `retainedEvents`, `retainedCards`, `hasPendingText` support lifecycle assertions/diagnostics without exposing private sender maps. Existing mutable tool model observation is the qualification in row 05. |
| 19 / 4            | Too many abstractions increase cognitive load. Balance encapsulation versus abstraction count.                                                                                 | **passes** — One scheduler implementation is shared by text and tools; the card collector adds no debounce. `OutputSink`/`renderOutput` are the only generic publication boundary. There is no universal collector framework, history cache, second transport queue/retry layer or speculative Pi protocol.                                                                                                    |

### Scoping

| Row / source item | Guideline                                                                                                                      | Disposition and current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 20 / 1            | Prefer minimal scoping.                                                                                                        | **passes** — `#live` is sender-instance state; `#tools`/`#thoughts` are card-instance indexes. Bridge generation/revision/publish closures live inside `#ensureSessionRendering`; no process-global raw-ID output map is added.                                                                                                                                                                                                                                                                                                            |
| 21 / 1.1          | Keep variables and methods in the smallest scope possible.                                                                     | **passes** — `ToolCollector.accept` keeps each update/state local; card entry helpers and scheduler timer cleanup are private. Bridge generation/revision/publish closures stay inside `#ensureSessionRendering`; fixture-specific transport callbacks stay within `createFixture`.                                                                                                                                                                                                                                                        |
| 22 / 1.2          | Global constants which are only used by a single function are not minimally scoped. possible exception for app configurations. | **justified qualification** — New settings defaults/ranges in `config.ts` are application configuration, explicitly allowed by this item. `#sequence` counters are instance-local. Existing activity size constants are shared model/rendering budgets, not new single-function globals; concrete runner timings/counts remain bounded scenario inputs.                                                                                                                                                                                    |
| 23 / 1.3          | Variables and methods are exposed on a need-to-know basis.                                                                     | **fixed** — Options interfaces for collectors/sender/session stay module-private; only content contracts and actual owners are exported. Retention getters provide direct lifecycle observability. `AcpToolModel.events` is preexisting-style model inspection retained for working tests rather than adding a replacement query API solely for this review. The unused exported `ActivityCardLimits` type is now private, and the obsolete `AcpThoughtActivity.messageId` DTO field is removed; entry identity belongs to the card index. |

### Naming

| Row / source item | Guideline                                                                                         | Disposition and current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 24 / 1            | Prefer descriptive names.                                                                         | **passes** — `TextCollector`, `PublicationScheduler`, `ActivityCardCollector` and `MatrixOutputSender` identify content, scheduling, grouping and delivery identity. `finishing`, `pending`, `collapsed` and `published` describe distinct states. Tool raw IDs remain in `AcpToolActivity.toolCallId`.                                                                                                                                                                                   |
| 25 / 2            | Start function names with verbs.                                                                  | **fixed** — New setup helpers now start with `create`; production commands use `append`, `flush`, `finish`, `accept`, `collapse`, `release`, `render` and `publish`. Predicate/getter names (`hasPendingText`, `dirty`, `stopped`) express queries; short local `text`/`thought`/`tool` callbacks are scenario DSL, not production methods. Existing noun helpers in the unchanged activity formatter are outside this naming remediation.                                                |
| 26 / 3            | Name the same concept consistently throughout the code.                                           | **passes** — `OutputSink.flush` always carries cumulative content; `finish` always retires identity. Tool/card/text ID namespaces stay explicit. `ToolCollector` now prefixes identified/anonymous internal entry keys consistently with the thought adapter’s namespace separation; raw ACP `toolCallId` is preserved.                                                                                                                                                                   |
| 27 / 4            | Use existing terminology rather than inventing new terms where possible.                          | **passes** — `SessionOutput`, `toolCallId`, `messageId`, Matrix originals/replacements and continuation parts retain ACP/Matrix meanings. Collectors, scheduler and sender are the approved design’s terms; no additional ACP lifecycle messages or configuration names were invented.                                                                                                                                                                                                    |
| 28 / 5            | Avoid magic numbers.                                                                              | **justified qualification** — Flush timing/byte limits have named validated configuration; activity source/detail/preview budgets have named constants. `renderActivityCard` retains concrete presentation fitting values (64/16-byte floor and 0.7 shrink factor); the existing formatter has terminal head/tail allocation values. These are bounded rendering heuristics retained with budget tests, not opaque identity/lifecycle sentinels; extracting every number would add noise. |
| 29 / 6            | Avoid double negatives: use positive conditions like `if verbose` instead of `if not no_verbose`. | **passes** — `#closed`, `#stopped`, `finishing`, `dirty` and `collapsed` are positive state names. No new `no_*` option or negated-negative predicate appears in collectors, session composition or sender.                                                                                                                                                                                                                                                                               |

### Responsibilities

| Row / source item | Guideline                                                                                                                                | Disposition and current evidence                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 30 / 1            | Ensure clear contracts between components. Each component should have a clear responsibility and a clear hand-off to the next component. | **fixed** — `OutputSink` documents cumulative flush/ordered finish; `ToolCollector` now separates raw identified IDs from generated anonymous keys. Capacity rejection releases the new model event before notifying the owner. `SessionOutput` still supplies two independent sender subscriptions; no interface or retry ownership change.                                                                                                                 |
| 31 / 2            | Check preconditions at the beginning of functions; return or throw if they fail.                                                         | **fixed** — `ToolCollector` now validates positive safe-integer retention and all pacing settings at construction; `ActivityCardCollector` validates event/byte limits as well as retention. `TextCollector` already rejects empty IDs/insufficient truncation budgets; sender/queue reject invalid bounds. `SessionOutput.accept` now rejects cleaned-empty leading legacy thoughts before allocation. Invalid-bound and capacity tests cover these guards. |
| 32 / 3            | Each function does only one thing and does it well.                                                                                      | **justified qualification** — Card `#add`/`#emit`/`#release`, scheduler `change`/`flush`, sender `#enqueue`/`#deliver` and bridge rendering helpers each have one owner-level purpose. `SessionOutput` construction is still a longer wiring function, and existing `BridgeCoordinator`/HTTPS scenario functions are large. Splitting wiring/linear test scenarios further would obscure dependencies without resolving a defect.                            |
| 33 / 4            | When a function has a side effect, it should do that only.                                                                               | **justified qualification** — `renderActivityCard`, `renderAcpActivity` and Markdown conversion remain pure. Collector `append`, queue `enqueue` and delivery methods return acceptance/event IDs as the result of their commands. `AcpToolModel.accept` mutates owned patch state and returns that event for publication; strict command/query separation is relaxed at this existing state-owner boundary, not mixed with unrelated I/O.                   |

### Comments

| Row / source item | Guideline                                                                                                                                  | Disposition and current evidence                                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 34 / 1            | Rarely use comments; make code so readable it explains itself.                                                                             | **passes** — `output-sink.ts` and `MatrixOutputSender` comments explain ownership/protocol; `scripted-unified-acp.mjs` comments explain deliberate stale updates, concurrent intake and SDK cleanup. Method names and guards carry ordinary control flow. The fixture-local lint exception explains why its callback is deliberately local. |
| 35 / 2            | Don't leave a work log in the code. Preserve only the best and most correct logic. Use the git history if you want to see a prior version. | **passes** — No remediation chronology was added to `tool-collector.ts`, `session-output.ts` or other source comments. Investigations/results live in WAAP `work_log.md` and this report; prior reports remain historical. Removed implementations stay in Git history rather than commented-out source.                                    |

### Dependencies

| Row / source item | Guideline                                                                      | Disposition and current evidence                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 36 / 1            | You own the entire stack including the dependency.                             | **justified qualification** — Reviewed ACP normalization/forwarding (`acp-client.ts`), escaped Markdown/tool rendering, exact Matrix edit/thread measurement and `MatrixDelivery` retry/serialization. Real-SDK HTTPS subprocess tests exercise the dependency boundary. Actual Rust crypto/homeserver behavior and Pi stable IDs remain external validation limits, not assumed from doubles. |
| 37 / 2            | Including a dependency means you are committing to maintaining the dependency. | **passes** — `package.json`/lockfile are unchanged by the full PR; ACP SDK 1.3.0 and Matrix SDK 42.2.0 remain pinned. `unified-wire.test.mjs` owns its protocol fixture, ephemeral TLS certificate and subprocess lifecycle; OpenSSL prerequisite and fixture limits are documented in the runner README.                                                                                      |
| 38 / 3            | Prefer open-source dependencies since you can't maintain closed source ones.   | **passes** — `package.json`’s pinned ACP/Matrix SDKs, markdown-it and existing toolchain carry open-source licenses in their installed package metadata. No proprietary runtime dependency or remote rendering service is introduced. This row assesses dependency choice, not a new license/compliance audit.                                                                                 |

### Logging

| Row / source item | Guideline                              | Disposition and current evidence                                                                                                                                                                                                                                  |
| ----------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 39 / 1            | Prefer a logger over print statements. | **passes** — Bridge `#diagnostic`/`MatrixDelivery.#diagnostic` use the diagnostic sink; no collector prints payloads. Scripted ACP stdout is its JSON-RPC transport and harness stdout is CLI result output; scripted-peer stderr reports a generic test failure. |

### Errors

| Row / source item | Guideline                                                                                   | Disposition and current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 40 / 1            | A user-facing error should clearly indicate what the user needs to do to resolve the error. | **passes** — `validateAgentTextSettings` names each invalid key/range and timer ordering. Bridge `#reportRenderingAbandoned` advises reducing concurrent output or increasing the two named limits, then restarting. New constructor `RangeError`s name the programmer-supplied field; queue delivery abandonment remains a safe diagnostic rather than inventing an unsolicited user message.                                                                                                        |
| 41 / 2            | Internal errors should include enough detail to debug the issue to root cause and fix.      | **justified qualification** — `MatrixDelivery.sendLive` logs room, attempts and validated HTTP status without raw errors/text; bridge capacity diagnostics include configured bounds. `ConversationPublication` intentionally reduces exceptions to `delivery`; render/size failures lose exact exception detail at that boundary. Existing size tests and constructor field errors localize causes, but this is not full exception-level root-cause telemetry. No unsafe raw error dumping is added. |

### Feel

| Row / source item | Guideline                                                                         | Disposition and current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 42 / 1            | Eliminate common code smells:                                                     | **fixed** — The following twelve sub-items were assessed individually; `ToolCollector.accept`, `SessionOutput.accept` and `ActivityCardCollector` fixes address collisions, retention and preconditions, with dead type surface removed from `acp-activity.ts`. The overall smell item does not replace rows 43–54.                                                                                                                                                                                                                                                                                                                                                           |
| 43 / 1.1          | Vague or unclear names                                                            | **fixed** — `createFixture`/`createPart`/`createGate` replace noun-only refactor setup helpers. `identified:`/`anonymous:` clearly distinguish key origin; `ToolState.id` remains the internal sink key while snapshot `toolCallId` remains the ACP correlation ID.                                                                                                                                                                                                                                                                                                                                                                                                           |
| 44 / 1.2          | Frequently repeated code                                                          | **passes** — Both text kinds share `TextCollector`/`PublicationScheduler`; status-only tool patches also use the scheduler. `renderOutput` shares protocol adaptation; bridge uses one generation-guarded publish closure for text/activity. The legacy thought collector is another instance, not copied accumulation logic.                                                                                                                                                                                                                                                                                                                                                 |
| 45 / 1.3          | Overly long functions                                                             | **justified qualification** — The former bridge batch scheduling/drain logic has been replaced by focused card/sender helpers. `SessionOutput`’s constructor explicitly wires the two flows; bridge prompt processing and the HTTPS test remain long cohesive orchestration. Unrelated full-coordinator or fixture rewrites were avoided.                                                                                                                                                                                                                                                                                                                                     |
| 46 / 1.4          | Classes with an excessive number of methods                                       | **passes** — New owner classes expose only intake/lifetime methods and small observation getters. `PublicationScheduler` has change/flush/stop; sender has flush/finish. The existing large `BridgeCoordinator` is not represented as newly small; it delegates new output responsibilities to `SessionOutput`.                                                                                                                                                                                                                                                                                                                                                               |
| 47 / 1.5          | Data structures with an excessive number of fields                                | **justified qualification** — `AcpToolActivity` retains many bounded fields for ACP patches, result fallback and terminal head/tail formatting. These belong to one tool’s state and are covered by model/rendering tests. `LiveOutput`, `CardState` and `TextSnapshot` stay small; no speculative unified state bag added. Splitting the established tool DTO is deferred rather than claiming its field count disappeared.                                                                                                                                                                                                                                                  |
| 48 / 1.6          | Long parameter lists                                                              | **passes** — New production constructors take cohesive private options; sink operations take one/two arguments; `renderOutput`/`renderActivityCard` take three. Existing four-argument `runScenario` is a bounded protocol-fixture operation; setup helper defaults describe scenario limits.                                                                                                                                                                                                                                                                                                                                                                                 |
| 49 / 1.7          | Unnecessary global scoping                                                        | **passes** — Sender maps, model/card indexes, timers and sequence counters are instance-local. `unified-wire.mjs` observation maps live for one bounded CLI run and are not daemon-global caches; separate subprocesses isolate modes. No additional worktrees or shared global renderer registry added.                                                                                                                                                                                                                                                                                                                                                                      |
| 50 / 1.8          | Excessive mutation                                                                | **justified qualification** — Mutation is limited to bounded accumulators/patch state and pending queue coalescing. Each emitted tool record copies the model object; nested bounded content values are replaced, not patched in place; card emissions allocate fresh event arrays. This preserves earlier production snapshots without retaining historical copies or requiring deep freezes.                                                                                                                                                                                                                                                                                |
| 51 / 1.9          | Adding an apparently isolated feature requires modifying the entire codebase.     | **passes** — PR production changes are confined to ACP forwarding, config, rendering owners, bridge composition and delivery diagnostics. Six unrelated subsystem test files only supply the three newly required configuration fields. No crypto/bootstrap/state schema rewrite is hidden in those fixture changes.                                                                                                                                                                                                                                                                                                                                                          |
| 52 / 1.10         | Unnecessary, "just-in-case" abstractions where the abstraction is not needed yet. | **passes** — No tombstone set, historical Matrix cache, universal collector superclass, configurable anonymous-ID protocol or second retry policy was added. Prefixing the two tool key origins fixes the collision in `ToolCollector`; it does not add an unnecessary public abstraction.                                                                                                                                                                                                                                                                                                                                                                                    |
| 53 / 1.11         | Inconsistently populated objects                                                  | **passes** — `ToolState`, `CardState` and `LiveOutput` initialize all lifetime fields. `AcpToolModel` optional fields reflect genuinely absent ACP patches; result/terminal defaults are explicit. `PublishedPart` is populated only after a successful event ID, preserving original targets on every replacement.                                                                                                                                                                                                                                                                                                                                                           |
| 54 / 1.12         | Missing cleanup                                                                   | **fixed** — Rejected tool model entries now release before capacity notification, even if the callback leaves intake open. `ActivityCardCollector.#add` rolls/reclaims finished current cards before the capacity check; `#emit`/`#release` honor synchronous closure and cannot emit collapse/finish afterward. Queue stop clears sender maps and stops all text/tool schedulers and cards; in-flight callbacks cannot repopulate mappings. Harness `finally` closes adapters/crypto/processes/server/temp files; encrypted cleanup includes reset-detached ACP session IDs. Tests cover cancellation, old-card retirement, sequential release and retained reusable stores. |

### Testing

| Row / source item | Guideline                                                                                                                                                                           | Disposition and current evidence                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 55 / 1            | Untested code doesn't work. All code must be tested.                                                                                                                                | **fixed** — Added executable tool constructor, rejected-model, integrated tool-collision, completed-card rollover and synchronous-close regressions; extended thought/card-limit guards and strengthened the ACP byte/marker assertion. Shared scheduler coverage remains through both message/thought parameterized tests and tool pacing tests. No test asserts new helper spelling; final full-suite evidence appears below. |
| 56 / 2            | Follow the test-level pyramid approach using mostly unit tests, integration tests that combine components, and end-to-end tests which verify functionality from a user perspective. | **justified qualification** — Unit-heavy collector/model/sender/queue suites are combined with bridge/SDK-boundary isolation tests and two real bridge/ACP/SDK HTTPS subprocess scenarios. Hermetic encrypted integration and local HTTPS do not establish real homeserver/SAS coverage. Historical live results and absent real Pi validation remain separately revision-qualified below.                                      |

## Bibliography (four references, no assessment rows)

1. Clean Code by Martin.
2. Pragmatic Programmer by Hunt.
3. Why Functional Programming Matters by Hughes.
4. Structure and Interpretation of Computer Programs by Abelson.

These are CODE.md's references, not additional executable rules. This review does
not claim to audit the books themselves.

## Validation and remaining qualifications

Environment: Linux, Node 26.11.1, npm 12.2.1. The regression-first run failed four
of 13 tests (9 passed), confirming the tool collision, rejected model retention,
missing tool guards and cleaned-empty legacy thought reservation. The first
remediation run passed 52 tests, zero failures/cancellations/skips, in 223.050456 ms
of test time. A second regression-first card run confirmed two failures among eight tests
(6 passed), in 79.690813 ms test time / 2.206 seconds command wall time. These
exploratory runs are not the final validation totals.

Final focused validation passed **266 tests**, zero failures/cancellations/skips,
in **1.389804996 seconds test time / 3.520 seconds command wall time**, including
TypeScript test compilation. The 60-second process limit and seven-second per-test
limit covered these owners:

```sh
timeout --kill-after=5s 60s sh -c 'npx tsc -p tsconfig.test.json --pretty false && node --test --test-timeout=7000 dist-test/text-collector.test.js dist-test/text-publication.test.js dist-test/activity-card-collector.test.js dist-test/session-output.test.js dist-test/matrix-output-sender.test.js dist-test/tool-collector.test.js dist-test/acp-activity.test.js dist-test/acp-client.test.js dist-test/bridge.test.js dist-test/integration.test.js dist-test/conversation-publication.test.js dist-test/config.test.js dist-test/matrix-delivery.test.js'
```

Complete bounded `timeout --kill-after=10s 240s npm run check` passed formatting,
lint, production/test typecheck/build and **595 tests**, with **zero failures,
cancellations or skips**, in **103.728 seconds command wall time**
(**89.487246335 seconds test time**). Both included slow real-SDK HTTPS subprocess
regressions passed: room **59.904408058 seconds**, thread **29.490695893 seconds**.
The final focused/full runs include the card rollover/close fixes. No fake-clock
stall occurred. Only evidence prose was updated after the final successful check;
no production/test code changed. Final changed-document formatting and link/count
checks were repeated after recording results.

No SVG/interface/component changes were necessary. All four PR SVGs were parsed
as XML, checked for external asset references, rendered with `rsvg-convert` and
visually inspected; labels and arrows fit. Local Markdown links, supported
specification front matter (`draft`/`final`/`abandoned`), exact checklist order/count
and `git diff --check` are validated with the final changes.

There is no known unresolved defect found in the audited PR scope after these
fixes; the table explicitly records architectural/style/observability and external
validation qualifications. In particular, `ConversationPublication`'s coarse
`delivery` diagnostic is not exception-level root-cause logging. Existing large
coordinator/test orchestration functions and tool DTOs remain; mutable private
streaming state is intentional. The current adapter contract must provide stable,
sequential response IDs shared by text/thoughts and must not reuse retired IDs.
This is a producer precondition; neither sender nor collectors keep an unbounded
retired-ID tombstone set to reject arbitrary future reuse. ID-less tool updates
still cannot be correlated to an earlier anonymous start without an ACP tool-call
ID; no new protocol was invented to guess that association.

No new live Matrix or real Pi test was performed. The [current live evidence](collector-rendering-verification.md#actual-scripted-acp-matrix-evidence)
remains **three scripted-ACP Matrix passes at `9cbf1c70e874211f410e0e43c6d058f0ac1d2c0d`**,
before coordinator whitespace correction `5559a6dde6b78000767389a9a8c5df791a9c6f99`;
encrypted thread setup was HTTP429-blocked. Cleanup remediation was
`cc708d4019949ecc71e9a4b9417320e7a487c5e8`. None establishes a fresh complete
live pass at this audit revision, a live alternating thought/text case, or real Pi
adapter support. Earlier four-case results describe earlier pre-refactor code.
Automated encrypted integration uses modeled crypto; slow HTTPS uses real SDK
subprocesses against a local protocol fixture. No credentials/devices/production
services were changed, and the audit developer did not integrate, push or publish
PR content.

## Independent coordinator validation

The coordinator reviewed the production/test diff and integrated the agent's
`d553581be53b53f68ccfce78e8ab61442f48383b` into the feature branch only. Independent
reconciliation against the blob-matched CODE.md confirmed all **56 rows**, exact
wording/order/hierarchy and four separate bibliography entries. The validation
script also checked **47 local links across 12 changed Markdown files**, supported
specification metadata and links from both current guides. The SVGs are unchanged
from the previously validated/rendered implementation diagrams.

An independent `timeout --kill-after=10s 240s npm run check` on the integrated code
passed formatting, lint, typecheck/build and **595 tests**, zero failures,
cancellations or skips. Wall time was about **103 seconds**; test duration was
**89.372261403 seconds**. Included real-SDK slow HTTPS room/thread cases passed
in **59.838845155 / 29.438042449 seconds**. No code/test changes were needed after
review; subsequent edits only pin this report's revision and record results.

No new live Matrix or real Pi pass is claimed. The 14 qualified assessments remain
explicit limitations/preferences, not converted into unconditional passes. The PR
is updated for review; no default-branch merge or deployment is authorized.
