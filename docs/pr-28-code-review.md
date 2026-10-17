# Historical PR #28 guideline-by-guideline review

This audit applies to the pre-collector revision named below. See the [current collector evidence](collector-rendering-verification.md).

Chad's Agent

Source: `chad/agents` → `CODE.md` at
`db0a8fa7b0bbe49d1539c2ff53a5e93c748dbb46`.
Reviewed PR head: `b430bc440b1ba827f455aded9d62ce5d5cff1ad5` against
`main` at `93ba97150f43a14539f910dab09a3d099a0dd40c`.
Scope: every changed production module, test, runner, configuration example and
document; surrounding interfaces inspected for ownership and compatibility.
The 56 individual checks below supersede the earlier verification report's
group-level CODE audit.

**Pass** means no change needed; **fixed** identifies a remediation in this review;
**qualified** records an intentional interpretation of a preference, not an
unconditional claim. IDs below follow CODE.md's section and bullet order,
including nested bullets.

## Architecture

| ID   | Guideline                                        | Assessment and evidence                                                                                                                                                                                                      |
| ---- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | Diagram of 5–10 components with directional flow | Pass: ACP wire → authorized session router → text buffer / activity model+batches → publication queue → delivery policy → Matrix SDK. Durable session store supplies routing. Eight components.                              |
| A1.1 | Self-similar diagrams when zooming               | Pass: text intake → bounded accumulation → timing → safe Markdown packing → original/edit publication. Activity normalization → batching → publication → terminal/collapse retirement.                                       |
| A1.2 | Avoid spaghetti                                  | Fixed: text/activity now share one guarded publication closure, rather than duplicate transport/accounting paths in `bridge.ts`.                                                                                             |
| A2   | Composable, interchangeable behavior             | Pass: injected clock, publication callback, queue and adapters; solicited/unsolicited identified text uses the same buffer. No alternate retry implementation.                                                               |
| A3   | Prefer immutable data                            | Qualified: configuration, contracts and publication snapshots are readonly. Private mutable current-message, timer, queue and tool state is necessary for bounded incremental delivery; no shared historical renderer cache. |

## Code structure

| ID   | Guideline                                                     | Assessment and evidence                                                                                                                                                    |
| ---- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | Shallow indentation, early returns, focused helpers           | Fixed: extracted `SessionActivity.#publishBatch` and `#releaseCompletedBatch`; guard clauses replace the nested retirement condition.                                      |
| S1.1 | Separate wrappers/core logic; encapsulate conditional logging | Fixed: scheduling/error/finally wrapper delegates batch publication and retirement; `#reportRenderingAbandoned` owns conditional diagnostics/fatal handling. No new locks. |
| S2   | Group by functionality, not type                              | Pass: text buffer, session activity, publication queue and their tests are cohesive functional modules.                                                                    |
| S2.1 | Avoid catch-all data-structure files                          | Pass: publication/options/state types remain beside their behavior; no new generic types collection.                                                                       |
| S3   | Avoid metaprogramming; explicit inspectable code              | Pass: explicit ACP dispatch, callbacks and transport/mode cases. No reflection, generated production source or eval.                                                       |
| S3.1 | Static rather than runtime-rewritten configuration            | Pass: production TOML is static and validated. Test-only temporary TOML selects a disposable fixture's room/thread mode; no live configuration is rewritten.               |

## Eliminate debt

| ID  | Guideline                  | Assessment and evidence                                                                                                                                                                                                                                      |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Remove dead code           | Fixed: removed `ActivityBatch.index` and its newly added monotonic counter. Delivery uses batch object identity; only obsolete tests still consumed numeric indexes. Assertions now check distinct batches. Removed the unnecessary exported tool predicate. |
| D2  | Repair encountered defects | Fixed: activity retention validates its constructor input; direct activity close unregisters its queue listener. Capacity errors now explain recovery and expose configured bounds. Existing prompt-final identified-text duplication remains removed.       |

## Abstractions

| ID   | Guideline                                       | Assessment and evidence                                                                                                                                              |
| ---- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1   | Consider data/object anti-symmetry              | Pass: rendering records are data; stateful lifecycle owners expose methods.                                                                                          |
| B1.1 | Data when adding functions                      | Pass: `MatrixHtmlBody`, activity records and publication payloads remain plain typed records usable by render/measure/assert functions.                              |
| B1.2 | Interfaces when adding implementations          | Pass: Matrix/ACP adapters, clocks and publisher callbacks support production and test implementations without changing callers.                                      |
| B2   | Minimize component knowledge                    | Fixed: shared session publisher owns routing, generation/revision, size guard and outbound accounting; buffer/activity know only their publication contract.         |
| B3   | Do not leak internals                           | Fixed: `SessionActivity` options and batch limits are private; `isActiveTool` is local to its only consumer module. Removed externally visible unused batch indexes. |
| B4   | Balance encapsulation against abstraction count | Pass: reused existing queue/delivery boundaries; extracted private helpers rather than adding publisher factories, base classes or strategy hierarchies.             |

## Scoping

| ID   | Guideline                                                     | Assessment and evidence                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | Prefer minimal scope                                          | Fixed: shared publisher/generation/revision stay inside session construction; activity settings are private.                                                                                                  |
| P1.1 | Smallest variable/method scope                                | Fixed: tool predicate moved from the activity model's public module API to session activity; new retirement/publication helpers are private.                                                                  |
| P1.2 | No single-function global constants, except app configuration | Fixed: the session fixture's default send callback is local, with a narrow lint exception because the existing lint rule otherwise requires hoisting it. Flush defaults/ranges are application configuration. |
| P1.3 | Expose only on need-to-know basis                             | Fixed: options/limits/index cleanup above. Retention getters remain observable contracts for lifecycle tests; private maps are not exposed.                                                                   |

## Naming

| ID  | Guideline                             | Assessment and evidence                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | Descriptive names                     | Pass: `AgentTextBuffer`, `SessionActivity`, `ConversationPublication`, dirty/pending state and explicit flush settings identify their roles.                                                                                                                                                       |
| N2  | Start function names with verbs       | Fixed: `#ensureSessionRendering`, `getEffectiveContent`, `createIdentifiedFixture`, `createFixture` and `createGate` replace noun-only helper names introduced by this PR. Local text/tool callback shorthand in scenario fixtures acts as a test DSL; production methods use verbs or predicates. |
| N3  | Consistent names for the same concept | Pass: message ID, session ID, tool call ID, batch, original and replacement retain ACP/Matrix meanings.                                                                                                                                                                                            |
| N4  | Existing terminology                  | Pass: no new protocol vocabulary; identified versus ID-less explicitly describes the adapter contract.                                                                                                                                                                                             |
| N5  | Avoid magic numbers                   | Qualified: production timing/size values are validated, documented configuration defaults/ranges. Queue/retention bounds derive from existing limits; timing/stream counts in tests are concrete scenario inputs. Removed the unused numeric batch identity.                                       |
| N6  | Avoid double negatives                | Pass: no new `no_*` flags or negated negative predicates; `stopped`, `closed`, `pending`, `dirty` and `isActiveTool` are explicit states.                                                                                                                                                          |

## Responsibilities

| ID  | Guideline                                     | Assessment and evidence                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Clear contracts and hand-offs                 | Pass: adapter forwards deltas; buffer owns current text; activity owns retained tools/batches; queue serializes/coalesces; delivery owns retries; coordinator owns routing/lifecycle.                                                                                          |
| R2  | Check preconditions first                     | Fixed: positive safe-integer activity retention validation precedes subscriptions/state construction. Buffer and queue already validate their bounds; routing rejects unknown/loading/retired sessions.                                                                        |
| R3  | One thing per function                        | Fixed: batch scheduling, publication and retirement are separate helpers. Shared publisher handles only delivery/accounting; session construction composes owners. Longer E2E functions describe one bounded scenario or protocol fixture, not production orchestration.       |
| R4  | A side-effecting function should only do that | Qualified: rendering/measurement is pure; command methods perform intake/publication/cleanup. Existing `append`/`enqueue` return acceptance acknowledgments and publisher callbacks return event IDs: these are results of the command, not an unrelated query responsibility. |

## Comments

| ID  | Guideline                    | Assessment and evidence                                                                                                                                                                                 |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Rare comments; readable code | Pass: retained comments explain non-obvious expanded-before-collapse ordering, retirement sequencing, subprocess concurrency or fixture limits. One lint exception explains the deliberate local scope. |
| C2  | No work log in code          | Pass: no chronology or superseded implementation remains in source comments. Verification history is documentation/Git history, not executable code.                                                    |

## Dependencies

| ID  | Guideline                               | Assessment and evidence                                                                                                                                                                                                                      |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Own the entire stack                    | Pass: reviewed ACP forwarding, Matrix delivery, size/routing contracts and lifecycle rather than assuming SDK behavior. Hermetic tests and real-SDK subprocess tests exercise boundaries. External Pi adapter prerequisite remains explicit. |
| E2  | Dependency means maintenance commitment | Pass: no package/lockfile additions. New HTTPS tests use system OpenSSL, documented as a prerequisite; fixture and cleanup code live in this repository.                                                                                     |
| E3  | Prefer open-source dependencies         | Pass: existing SDKs/toolchain and OpenSSL are open source; no closed dependency introduced.                                                                                                                                                  |

## Logging

| ID  | Guideline                | Assessment and evidence                                                                                                                           |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Logger rather than print | Pass: production uses the diagnostic sink. Scripted ACP stdout is the JSON-RPC transport; runner stdout is a CLI test result, not daemon logging. |

## Errors

| ID  | Guideline                                    | Assessment and evidence                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1  | User-facing errors explain resolution        | Fixed: text/activity capacity errors name configuration keys, reducing concurrent output, and restarting. Existing configuration errors identify the key and allowed values/order.                                                                                                                                                                                                  |
| X2  | Internal errors support root-cause diagnosis | Fixed: capacity diagnostics include both configured bounds. Permanent live-delivery diagnostics now include room, attempt count and validated HTTP status (or explicit null), distinguishing permission failures without logging raw errors. Raw message/errcode/credentials remain excluded; malformed statuses are tested. Arbitrary exception dumps are intentionally not added. |

## Feel

| ID    | Guideline                                | Assessment and evidence                                                                                                                                                                                                                                               |
| ----- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1    | Eliminate common code smells             | Fixed: individual checks follow.                                                                                                                                                                                                                                      |
| F1.1  | Vague/unclear names                      | Fixed: verb-based session construction and helper names above.                                                                                                                                                                                                        |
| F1.2  | Frequently repeated code                 | Fixed: removed duplicate text/activity routing, send, revision and outbound accounting; unified abandonment handling. Repeated fixture values are explicit test inputs, not another production default source.                                                        |
| F1.3  | Overly long functions                    | Fixed: activity scheduler split into scheduling/publication/retirement. Session construction's repeated transport blocks reduced to one local callback. Existing large coordinator and bounded test scenarios are not rewritten wholesale.                            |
| F1.4  | Classes with excessive methods           | Pass: new owners expose narrow lifecycle/intake APIs. Only focused private coordinator helpers were added; no unrelated responsibility moved into it.                                                                                                                 |
| F1.5  | Data structures with excessive fields    | Qualified: `TextBlock` fields all describe one current message's source, pacing and event mappings; turn compatibility state is separate. No unrelated state or speculative option bag added.                                                                         |
| F1.6  | Long parameter lists                     | Pass: new production APIs use cohesive options or at most three arguments. Existing scripted scenario's four scalar inputs are bounded test setup.                                                                                                                    |
| F1.7  | Unnecessary global scope                 | Fixed: single-use predicate export and fixture-global callback removed; options/limits made private. E2E module state belongs to one runner process, not shared production globals.                                                                                   |
| F1.8  | Excessive mutation                       | Qualified: mutable delivery/timer/tool ownership is private and bounded; render results/configuration are readonly. Coalescing mutates queued operations deliberately rather than retaining unbounded snapshots.                                                      |
| F1.9  | Isolated feature modifies whole codebase | Pass: production change is localized to ACP forwarding, coordinator routing, render owners and flush configuration. Other fixture edits supply required settings; no crypto/bootstrap behavior changes.                                                               |
| F1.10 | Just-in-case abstractions                | Fixed: removed unused batch identity/counter; no speculative cache/history/index or new configuration capacities.                                                                                                                                                     |
| F1.11 | Inconsistently populated objects         | Pass: batch deliveries initialize all fields; optional event IDs distinguish originals from edits. Stopped/closed state is explicit; no undefined IDs reported as successful sends.                                                                                   |
| F1.12 | Missing cleanup                          | Fixed: direct activity close detaches its subscription. Existing queue-stop listeners cancel timers and release text, tools, batches and mappings. Reset/shutdown/stale callbacks, subprocess groups, HTTPS connections and temporary files have regression coverage. |

## Testing

| ID  | Guideline                                             | Assessment and evidence                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | All code must be tested                               | Fixed: added direct queue tests for constructor bounds, FIFO/coalescing, capacity rejection, delivery failure, restart-after-idle, stop idempotence and listener lifecycle. Added activity validation/direct-close/stopped-construction tests, capacity recovery diagnostics and safe HTTP diagnostic tests. Existing buffer/bridge tests cover the shared publication refactor. |
| T2  | Unit-heavy pyramid, integration, user-perspective E2E | Pass: deterministic unit suite dominates; integration combines real ACP parsing/coordinator/delivery with modeled SDK/crypto boundaries; two automated HTTPS subprocess tests use real bridge/ACP/SDK processes. Historical real Matrix checks remain documented separately, not relabeled as fresh results.                                                                     |

## References

CODE.md's four reference entries are bibliography, not executable requirements:
Clean Code; Pragmatic Programmer; Why Functional Programming Matters; Structure
and Interpretation of Computer Programs. The checks above apply their listed
principles without claiming that these books were independently audited.

## Validation and limits

Environment: Node 26.11.1, npm 12.2.1.

The first full run stalled in the newly added activity-capacity regression:
its fixture resolved an ID-less prompt and awaited completion without advancing
the fake drain clock. A focused TAP run isolated the stall after bridge test 103.
The fixture now emits identified text before prompt completion. Its focused test
passes with a five-second test timeout; the full rerun has a four-minute shell
timeout. This was a test-fixture error introduced during this review, not a
production transport delay.

Validation passed:

- `timeout --kill-after=10s 240s npm run check`: formatting, lint,
  typecheck/build and **580 tests passed**, zero failures/cancellations/skips;
  command completed in 102 seconds. Includes both slow HTTPS room/thread
  subprocess scenarios.
- Focused buffer, batch, bridge, queue, activity and delivery suites with
  `node --test --test-timeout=5000`: **148 tests passed**, zero failures/skips.
- `git diff --check` and a final formatting check of the review documents passed.

No production code changed after the successful full run; subsequent edits
record these results in documentation.
No production deployment, live account/device mutation or merge is part of this
review. Previous real Matrix evidence applies only to its recorded revision;
this review does not establish a new live encrypted Matrix or real Pi E2E pass.
