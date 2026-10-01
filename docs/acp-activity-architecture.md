# ACP activity: module responsibilities

The activity pipeline separates protocol ingestion, retained state, presentation,
and delivery. Transport code does not assemble presentation markup; presentation
code does not send messages or own delivery IDs.

## Ingestion

`acp-client.ts` owns ACP transport, protocol requests, and notification dispatch.
`acp-activity-update.ts` validates and copies activity notifications into typed,
bounded updates. Its shared 256 KiB budget applies to each notification's retained
payload, not to a tool's lifetime, a turn, or the serialized protocol frame.

## Retained activity

`acp-activity.ts` owns the turn's thought/tool state and merges updates into stable
event objects. Updating a tool changes its original event, not its position in
the activity sequence. Retention bounds are independent of the ingestion budget.

## Presentation

`acp-activity-rendering.ts` renders one activity event: titles, status styling,
previews, details, diffs, escaping, and HTML budgets.

`acp-activity-batches.ts` owns batch presentation: event grouping, batch boundaries,
collapsing older batches, and composing event renderings. It reports changed
batches to its caller. It has no room IDs, message IDs, send queues, or retries.
It returns only plain text and HTML. The caller supplies a byte-cost function
that adds routing and reserves the edit envelope, so the presentation budget
accounts for the exact payload without owning routing or wire construction.

`matrix-text-rendering.ts` renders Markdown message bodies and splits live
agent text into Unicode-safe, size-bounded chunks. `matrix-markdown.ts` supplies Markdown
syntax conversion. `response-rendering.ts` continues to own finalized responses,
including lifecycle/error messages, output truncation, and numbered plain-text
parts; it does not own live activity batches.

## Delivery

`bridge.ts` coordinates turns and delivery. It routes updates to the activity
model and presentation modules, then schedules changed batch sends/edits. Matrix
event IDs, revisions, pending/dirty delivery state, ordering, retries, and failure
handling stay here, separate from batch presentation state.

`matrix-client.ts` owns Matrix SDK interactions. `matrix-message-content.ts` owns
the exact HTML message/edit wire content and its byte accounting. Both ordinary
and edited messages use that same payload builder.

## Shared text primitives

- `bounded-text.ts`: UTF-8 clipping without splitting code points.
- `html.ts`: HTML escaping, without activity-specific newline behavior.
- `matrix-html.ts`: branded safe HTML and tagged templates.

`config.ts` owns configuration parsing and validation, not batching policy.

## Verification

Module tests exercise ingestion budgets, stable activity state, event rendering,
batch boundaries/collapse behavior, text splitting, escaping, and byte costs.
Bridge tests retain the integration contract: send/edit order, late updates to
collapsed batches, and live-delivery failures. Existing encrypted and unencrypted
agent tests remain end-to-end checks rather than alternative implementations of
production presentation logic.
