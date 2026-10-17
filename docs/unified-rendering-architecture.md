# Unified rendering: component map

Chad's Agent

PR #28 moves identified assistant output and tool activity from **prompt lifetime**
to **session lifetime**. Prompt completion no longer ends rendering: the same
session owners handle both solicited and unsolicited updates. Existing routing,
Markdown rendering, Matrix delivery/retries and encryption remain the boundaries.

## Overview

![New session owners and their relationship to existing components](unified-rendering-overview.svg)

Blue components are new. Amber components already existed and change in this PR;
slate components are reused. The session stores preserve room/thread routing,
not rendered text or Matrix event mappings.

## Interfaces and data flow

![Session renderer interfaces, queued work, publication callbacks and returned event IDs](unified-rendering-session.svg)

1. Existing `AcpClient.onUpdate(listener)` forwards normalized `AcpUpdate` values
   even when no prompt is pending. The coordinator filters loading/replay,
   stopped and unknown/retired sessions before dispatching to their owners.
2. New `AgentTextBuffer.append(messageId, delta): boolean` accumulates the current
   identified message. Byte, quiet and maximum-interval triggers queue a flush;
   a new ID finalizes the previous message. `flush()` preserves identity.
3. New `SessionActivity.accept(update): void` uses the existing activity model
   and batches, now with explicit release/clear operations. The coordinator
   flushes preceding text before tool announcements or nonempty thoughts; it
   also forwards assistant text to activity so existing batches can collapse.
   Neither action retires active parallel tools or the current text identity.
4. Both owners call new `ConversationPublication.enqueue(key, operation): boolean`.
   This queues **operations, not rendered messages**. Pending work with the same
   block/batch key coalesces in place. The bounded FIFO runs one operation at a
   time; that operation executes the owner's rendering/publication logic.
5. Owners call injected publishers:
   - Text: `publish(AgentTextPublication)` carries `messageId`, `partIndex`, `body`,
     `formattedBody` and optional `targetEventId`.
   - Activity: `publish(RenderedAcpActivity, targetEventId?)` carries rendered
     `body`/`formattedBody` and the optional original event ID.
   - Both resolve to a Matrix event ID or `undefined` on failure. Each owner keeps
     the original event ID for later replacements; activity/text mappings are
     not shared with other sessions.
6. The coordinator's shared publisher adds routing, a transaction ID, current
   session/size guards and outbound accounting, then calls existing
   `MatrixDelivery.sendLive(MatrixHtmlMessage)`. Existing transport serialization,
   retry behavior and the SDK encryption path remain in place.

## Lifetime and compatibility

- Prompt completion does **not** stop the renderer. Reset/shutdown stop the
  publication queue, which stops the buffer and closes activity. Failure also
  stops publication and diagnoses abandonment; capacity failure is fatal.
- Retired text mappings are released after final queued publication. Activity
  releases batches only after tools are terminal and final updates/collapse have
  been published. Retention is bounded, not a historical cache.
- ID-less solicited text retains its compatibility path outside these diagrams.
  ID-less unsolicited text is diagnosed and omitted. Identified text is no longer
  copied into prompt-final outcomes.
- The adapter must provide stable, sequential assistant message IDs. The separate
  pi-acp prerequisite is unchanged; these diagrams do not imply adapter support
  or a deployment.

Sources: [coordinator](../src/bridge.ts), [text buffer](../src/agent-text-buffer.ts),
[session activity](../src/session-activity.ts),
[publication queue](../src/conversation-publication.ts).
The SVGs are self-contained, editable source files with no external assets.

## Proposed next design

The [collector-based output rendering draft](../specifications/collector-based-output-rendering.md)
proposes shared text collection/flush rules, separate activity composition and
emitter-local Matrix mappings with explicit finish signals. It includes a new
component/data-flow SVG. That draft is not implemented by the code mapped above.
