# Collector rendering verification

Chad's Agent

Current evidence for the collector refactor in PR #28. The
[earlier report](unified-message-rendering-verification.md) and
[earlier CODE.md review](pr-28-code-review.md) are historical and describe their
named pre-refactor revisions. This report will record the final tested code
revision, complete automated results and actual Matrix outcomes separately.

## Acceptance coverage

| Requirement                                                                                                                   | Executable evidence                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Shared text accumulation, UTF-8 bytes, quiet/maximum interval, pacing, explicit scoped flush/finish, transitions/cancellation | `text-collector.test.ts`, `text-publication.test.ts`; identical deterministic-clock checks for message/thought instances   |
| Repeated deltas append; cumulative card snapshots replace                                                                     | Text collector and activity-card tests                                                                                     |
| Thought/text alternation with the same response ID, pending thought before last tool completes                                | `session-output.test.ts`; SDK-boundary isolation integration covers two rooms/two threads and plaintext/modeled encryption |
| Response transitions finish both text owners; tools do not prove response completion                                          | Session output tests with unrelated tool message metadata                                                                  |
| Parallel tool patches, replacement results, terminal streams/status-only pacing, terminal flush before finish                 | `tool-collector.test.ts`, bounded model/rendering and ACP client tests                                                     |
| Stable old-card destinations, explicit finish, source retention bounds                                                        | Activity-card and session-output rollover/100 sequential card tests                                                        |
| Emitter-local equal IDs, older live IDs, finish during in-flight sends                                                        | `matrix-output-sender.test.ts` with gated sends                                                                            |
| Original targets/continuation growth and shrinkage; unchanged/empty output                                                    | Sender and text publication tests                                                                                          |
| Mandatory initial expanded view before collapse with blocked delivery                                                         | Sender and session-output barrier tests; bridge rapid-rollover tests                                                       |
| Shared safe Markdown in thoughts; markers/heading normalization, escaped raw HTML/tools and wrappers                          | Activity-card/rendering tests; SDK isolation asserts resumed Markdown in the original collapsed thought card               |
| Full output/event/thread/edit budgets and explicit truncation                                                                 | Text publication, activity-card, bridge/Markdown packing tests                                                             |
| Bounded queue, capacity/delivery failure, lifecycle cleanup and stale callbacks                                               | Sender, text publication, session output, conversation queue and bridge tests                                              |
| Prompt-independent lifetime, room/thread routing, load/history/restart/ID-less compatibility, encryption boundary             | Bridge and integration suites; existing SDK HTTPS subprocess regressions remain separate from actual Matrix                |

## CODE.md assessment

The component map has eight directional stages and expands into focused domain
owners. Message/thought text shares one implementation and scheduler; tool patch
semantics and card lifetime stay separate. `OutputSink` has only flush and finish;
`renderOutput` transforms payloads without timers or publication identity.

Private state retains only live content, bounded pending snapshots and in-flight
sender mappings. Structured snapshots replace entries; tool patches create fresh
bounded field values. Renderer functions are pure. The sender owns original event
IDs and queue barriers, and `MatrixDelivery` retains retry ownership. No new
configuration, dependencies, history caches, persistence schemas or Pi modifications.

Superseded `AgentTextBuffer`, `SessionActivity`, `AcpActivityBatches` and mixed
thought/tool model paths are removed. Existing tests were moved to the new owners;
assertions for content, safety, targets, bounds and barriers remain. Tests expecting
cross-type eager flushes now explicitly advance the shared publication clock. One
fixture previously emitted a second result after a terminal update; it now streams
the first result while running and ends with the final result, matching the explicit
terminal contract.

Guard clauses, functional modules, local settings/helpers and content-free failure
diagnostics follow CODE.md. Private mutation in accumulators, schedulers and queues
is deliberate bounded streaming state; publication records are readonly. No known
CODE.md issue remains. Existing bridge prompt/ID-less compatibility remains outside
the identified collector path.

## Validation status

Final bounded automated checks and actual scripted-ACP Matrix scenarios are being
completed before handoff. Real Pi is outside scope: these tests cannot establish
its response-ID adapter prerequisite. No production restart, crypto reset, trust
change, deployment or branch integration is part of this work.
