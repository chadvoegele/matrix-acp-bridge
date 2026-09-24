+++
status = "draft"
created = 2026-09-24
last_update = 2026-09-24
+++

# Verbose ACP output in Matrix

## Purpose

Let Matrix readers see useful progress from an ACP agent, beyond its final answer, without exposing private data by default. First determine what the agent actually sends over ACP; choose the Matrix presentation separately.

## Context

The bridge currently forwards text from `agent_message_chunk`. Its ACP adapter recognizes `agent_thought_chunk`, `tool_call`, and `tool_call_update` but discards their payloads; the coordinator ignores those update kinds. The adapter also recognizes plan, command, mode, configuration, and usage updates without forwarding their payloads. A `session/prompt` response supplies a stop reason, not the missing progress details. These observations about the bridge code do not imply that every agent emits every update.

## Goals

- Establish which progress and tool details the configured ACP agent emits during a real tool-using turn, including the order of updates and whether data arrives incrementally.
- Preserve useful agent commentary and available tool-call arguments and results for a future Matrix rendering design.
- Keep progress attributable to its turn and tool call without duplicating the final answer.

## Non-goals

- Specify Matrix message layout, edits, threading, or a verbosity setting yet.
- Promise raw chain-of-thought, or infer hidden reasoning from tool activity. Only agent-provided, explicitly available content is in scope.
- Publish raw ACP traces or automatically expose tool inputs, outputs, paths, credentials, or private context to Matrix users.

## Specification

### Observed ACP stream

Two isolated sessions of the configured agent answered “What's the weather in New York right now? Use a weather tool to check.” Both completed with `session/prompt` stop reason `end_turn`. The following is a **redacted field-shape inventory**, not a transcript or a guarantee across agents or turns:

| Update | Observed fields and sequence |
| --- | --- |
| `agent_message_chunk` | Text chunks arrived before and after tool calls. The initial messages included a startup prelude and startup metadata; subsequent small chunks formed the final answer. No separate commentary label or `messageId` appeared in these samples. Do not mistake startup text for turn commentary. |
| `agent_thought_chunk` | Two text chunks preceded the first tool call. Thinking descriptions are therefore available in this sample, but their content is not reproduced here. Availability depends on the agent and turn. |
| First `tool_call` | `toolCallId`, `title`, `kind`, `status: pending`, `locations`, and structured `rawInput` appeared. The input included a `path` key; its value is deliberately omitted. An `in_progress` update repeated the input; a `completed` update provided a `content` block (`type: content`, nested text content) and structured `rawOutput` with a `content` key. |
| Second `tool_call` | A terminal-style content block and terminal metadata appeared on the pending call. Updates progressed through `in_progress` to `completed`. Terminal output and exit information appeared in update metadata, **not** as `rawOutput` in this sample. |
| Other | `session_info_update` and `available_commands_update` also appeared. No plan or usage update was seen in these turns. |

A separate isolated turn wrote, read, edited, then read a new scratch file. The resulting file was verified and removed. It also ended with `end_turn`:

| Tool | Observed pending / in-progress input | Observed completed output |
| --- | --- | --- |
| Write | `rawInput` with `path` and `content` | `content` block of `type: diff` with `path`, `oldText`, and `newText`; no `rawOutput` |
| Read (twice) | `rawInput` with `path` | `content` block of `type: content` with nested text, plus `rawOutput.content` |
| Edit | `rawInput` with `path` and `edits` | `content` block of `type: diff` with `path`, `oldText`, and `newText`; no `rawOutput` |

Each operation had `pending`, `in_progress`, and `completed` updates. This turn emitted no `agent_thought_chunk`; only startup and final agent text was observed. Tool calls are correlated by `toolCallId`; arguments, outputs, and content-block forms differ between tools. A renderer must not assume `rawOutput` is always present or that `content` alone contains all tool results. Neither probe established a reliable distinction between mid-turn commentary and final-answer `agent_message_chunk` text.

Future probes should compare other tool types and turn shapes before fixing a display format. Never commit transcripts, endpoint addresses, session IDs, credentials, local paths, or unreviewed tool data to this public repository; publish only reviewed field shapes and presence/absence findings.

### Future behavior boundaries

- An implementation must associate updates with the correct ACP session and active turn; it must not display late or replayed updates as a new turn.
- Tool updates must be correlated by tool-call ID so changes to status and output do not appear as unrelated calls.
- Untrusted ACP text and tool data must be bounded by output limits and treated as data, not commands or trusted markup.
- A turn without progress updates must retain today's final-answer behavior. Errors, cancellation, and restart must not leave misleading in-progress output.
- Explicitly decide what categories of tool input/output can be shown to authorized Matrix room members before forwarding any of them. Room authorization alone does not make arbitrary tool output safe to disclose.

## Verification

- The redacted live probe inventory above is reproducible with a tool-using turn; no raw trace enters the repository.
- Adapter tests cover observed update shapes, partial and repeated tool updates, multiple tools, missing optional fields, and late updates.
- Bridge tests confirm that non-verbose behavior remains unchanged and that progress is scoped to the active room turn and bounded under cancellation and failure.

## Open questions

- Can commentary be distinguished from final answer text in other turns? Are thought chunks suitable as brief thinking descriptions, or could they contain sensitive reasoning?
- For which tools do arguments and results appear in `rawInput`, `rawOutput`, content blocks, or metadata? How are incremental terminal updates bounded?
- What should be hidden, summarized, or opt-in for tool arguments, outputs, and thought-like content?
- How should Matrix present the available content (separate messages, edits, threading, or another form)?
