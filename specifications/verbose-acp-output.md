+++
status = "draft"
created = 2026-09-24
last_update = 2026-09-24
+++

# Verbose ACP output in Matrix

## Purpose

Let Matrix readers see useful progress from an ACP agent, beyond its final answer, without exposing private data by default. First determine what the agent actually sends over ACP; choose the Matrix presentation separately.

## Context

The bridge currently forwards text from `agent_message_chunk`. Its ACP adapter recognizes `agent_thought_chunk`, `tool_call`, and `tool_call_update` but discards their payloads; the coordinator ignores those update kinds. The adapter also recognizes plan, command, mode, configuration, and usage updates without forwarding their payloads. A `session/prompt` response supplies a stop reason, not the missing progress details. These are observations about the bridge code, **not** evidence that a particular agent emits every update.

## Goals

- Establish which progress and tool details the configured ACP agent emits during a real tool-using turn, including the order of updates and whether data arrives incrementally.
- Preserve useful agent commentary and available tool-call arguments and results for a future Matrix rendering design.
- Keep progress attributable to its turn and tool call without duplicating the final answer.

## Non-goals

- Specify Matrix message layout, edits, threading, or a verbosity setting yet.
- Promise raw chain-of-thought, or infer hidden reasoning from tool activity. Only agent-provided, explicitly available content is in scope.
- Publish raw ACP traces or automatically expose tool inputs, outputs, paths, credentials, or private context to Matrix users.

## Specification

### Discovery gate

Before choosing a display format, probe an isolated ACP session with a weather question that requires a tool call (for example, “What's the weather in New York right now? Use a weather tool to check.”). Record, locally, the ordered `session/update` kinds and the shapes of their payloads, followed by the `session/prompt` stop reason. Distinguish observed wire fields from ACP schema capabilities and from fields the bridge currently retains. Inspect at least:

| Update | Questions to resolve |
| --- | --- |
| `agent_message_chunk` | Does commentary precede the tool call? Are progress and final text distinguishable, and are chunks grouped by message ID? |
| `agent_thought_chunk` | Is any thinking description emitted? Is it safe and useful to show, or absent? |
| `tool_call` / `tool_call_update` | Which identifier, title, status, argument/input, content, and result/output fields appear? Are arguments or results partial, updated, or omitted? |
| Other updates | Do plans, usage, or other kinds contain useful progress? |

The probe must not commit transcripts, endpoint addresses, session IDs, credentials, local paths, or unreviewed tool data to this public repository. Publish only reviewed, redacted field shapes and presence/absence findings. If the configured endpoint is unavailable, keep findings explicitly unverified rather than substituting mock traffic for a live observation.

### Future behavior boundaries

- An implementation must associate updates with the correct ACP session and active turn; it must not display late or replayed updates as a new turn.
- Tool updates must be correlated by tool-call ID so changes to status and output do not appear as unrelated calls.
- Untrusted ACP text and tool data must be bounded by output limits and treated as data, not commands or trusted markup.
- A turn without progress updates must retain today's final-answer behavior. Errors, cancellation, and restart must not leave misleading in-progress output.
- Explicitly decide what categories of tool input/output can be shown to authorized Matrix room members before forwarding any of them. Room authorization alone does not make arbitrary tool output safe to disclose.

## Verification

- A live tool-using ACP probe yields a redacted field-shape inventory, including absent fields and ordering; no raw trace enters the repository.
- Adapter tests cover observed update shapes, partial and repeated tool updates, multiple tools, missing optional fields, and late updates.
- Bridge tests confirm that non-verbose behavior remains unchanged and that progress is scoped to the active room turn and bounded under cancellation and failure.

## Open questions

- Does the configured agent emit commentary separately from final answer text? Which ACP fields, if any, describe thinking rather than expose raw reasoning?
- Are tool arguments and tool results available as structured fields, content blocks, both, or neither in the live stream?
- What should be hidden, summarized, or opt-in for tool arguments, outputs, and thought-like content?
- How should Matrix present the available content (separate messages, edits, threading, or another form)?
