+++
status = "draft"
created = 2026-09-24
last_update = 2026-09-27
+++

# Verbose ACP output in Matrix

## Purpose

Show users progress from an ACP agent during the agent loop, rather than just showing the final response.

## Context

The bridge currently shows text from `agent_message_chunk`. The ACP adapter also recognizes `agent_thought_chunk`, `tool_call`, and `tool_call_update` but discards their payloads.

## Goals

- Preserve agent commentary and available tool-call arguments and results.
- Display preserved commentary and tool calls using a progressive-disclosure technique.
- Make live agent activity the most visible.
- Past agent activity is available to the user but not immediately visible.
- Show agent messages as soon as they are available, rather than waiting until turn end.

## Non-goals

- Display data that isn't passed through ACP.
- Use Matrix as an archival store for agent traces.

## Specification

### Available ACP Data

The example ACP trace shows agent activity in repeated `session/update` messages.

1. method = "session/update"
    1. params.update.sessionUpdate = "agent_thought_chunk"
    1. params.update.sessionUpdate = "tool_call"
        1. params.update.kind = "read"
        1. params.update.kind = "edit"
        1. params.update.kind = "execute"
    1. params.update.sessionUpdate = "tool_call_update"

ACP v1 references:

- [Prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn): `session/prompt`, `session/update`, message chunks, and stop reasons.
- [Tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls): tool-call fields, statuses, updates, and result content.
- [Terminals](https://agentclientprotocol.com/protocol/v1/terminals): standard terminal capability and output methods.
- [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility): implementation-specific `_meta` data.

#### Thought chunk

```jsonc
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      // ACP v1: optional streamed agent reasoning; agents need not emit it.
      "sessionUpdate": "agent_thought_chunk",
      "content": { "type": "text", "text": "**Planning tools for text processing**" }
    }
  }
}
```

#### Read tool call

```jsonc
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      // ACP v1: new tool call, correlated by toolCallId.
      "sessionUpdate": "tool_call",
      "toolCallId": "call-read",
      "title": "read",
      "kind": "read",
      "status": "pending",
      // ACP v1: rawInput is optional; "path" is this tool's input, not an ACP field.
      "rawInput": { "path": "/tmp/output.txt" }
    }
  }
}
```

```jsonc
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      // ACP v1: patch an existing tool call; completed means success.
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-read",
      "status": "completed",
      // ACP v1: displayable tool result content.
      "content": [
        { "type": "content", "content": { "type": "text", "text": "alpha\nbeta\n" } }
      ],
      // ACP v1: rawOutput is optional; its inner shape is tool-specific.
      "rawOutput": { "content": [{ "type": "text", "text": "alpha\nbeta\n" }] }
    }
  }
}
```

#### Edit tool call

```jsonc
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "call-write",
      "title": "write",
      // ACP v1: edit means modifying content; pi-acp classifies its write tool this way.
      "kind": "edit",
      "status": "pending",
      // ACP v1: optional rawInput; its path/content keys are tool-specific.
      "rawInput": { "path": "/tmp/output.txt", "content": "alpha\nbeta\n" }
    }
  }
}
```

```jsonc
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-write",
      "status": "completed",
      // ACP v1: diff content; oldText: null means a new file.
      "content": [
        { "type": "diff", "path": "/tmp/output.txt", "oldText": null, "newText": "alpha\nbeta\n" }
      ]
    }
  }
}
```

#### Execute tool call

```jsonc
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "call-exec",
      // ACP v1: title is a human-readable label, NOT a guaranteed command field.
      // pi-acp happens to put the exact command in it.
      "title": "cat -- /tmp/output.txt",
      "kind": "execute",
      "status": "pending",
      // ACP v1: terminal reference; standard terminal methods require client capability.
      "content": [{ "type": "terminal", "terminalId": "terminal-1" }],
      // pi-acp extension: terminal_info is not an ACP-defined _meta key.
      "_meta": { "terminal_info": { "terminal_id": "terminal-1", "cwd": "/tmp" } }
    }
  }
}
```

```jsonc
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-exec",
      "status": "in_progress",
      // pi-acp extension: ACP permits _meta but does not define terminal_output.
      // This is not a standard terminal/output response.
      "_meta": {
        "terminal_output": { "terminal_id": "terminal-1", "data": "alpha\nbeta\n" }
      }
    }
  }
}
```

```jsonc
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-exec",
      // ACP v1: completed means the tool call succeeded.
      "status": "completed",
      // pi-acp extension: ACP does not define terminal_exit or its fields.
      "_meta": {
        "terminal_exit": { "terminal_id": "terminal-1", "exit_code": 0, "signal": null }
      }
    }
  }
}
```

### Eager Message Rendering

In the example ACP trace, the following text is sent together at the end of the turn:

```
I’ll create only the specified scratch file at its explicit /tmp path, verify its contents, then display it with the exact allowed cat -- command. No other files or commands will be touched.Completed: wrote, read, and displayed the specified scratch file.
```

The first sentence is produced before the tool calls but only displayed at the end. We should display the message chunk when the agent finished writing. The specification mentions a `messageId` field, but it is not required. Possible heuristics to delineate thought chunks are double newlines or the start of a tool call in the next message.

### Progressive Disclosure via Collapsible Trees

We can model the agent's activity for the UI as a tree. Each level of tree depth progressively displays more information to the user.

1. Past Agent Events: # events = # thoughts + # tool calls
    1. Thought 1
    1. Thought 2
    1. (status) Tool Call 1 Abbreviated Command
        1. Tool Call 1 Full Command
        1. Tool Call 1 Abbreviated Result
            1. Tool Call 1 Full Result
1. (status) Tool Call 2 Abbreviated Command
    1. Tool Call 2 Full Command
    1. Tool Call 2 Abbreviated Result
        1. Tool Call 2 Full Result

The most recent message is always displayed at depth 2. Past activity is collapsed and shown at depth 1.

Full commands and results are shown only if their abbreviated versions were truncated.

Use color cues where possible to make activity easy to understand at a glance. For example, tool-call status should be gray when pending, black when running, green when completed successfully, and red when failed. For file diffs, red text is old and green text is new.

### Matrix HTML subset

The [Matrix `m.room.message` specification](https://spec.matrix.org/v1.16/client-server-api/#mroommessage-msgtypes) supports HTML via `format: "org.matrix.custom.html"` and `formatted_body`, alongside a plain-text `body`.

1. **Structure:** `p`, `h1`–`h6`, `blockquote`, `div`, `br`, `hr`.
2. **Inline text:** `strong`, `b`, `em`, `i`, `u`, `s`, `del`, `sup`, `sub`, `span`.
3. **Lists:** `ul`, `ol`, `li`.
4. **Code:** `pre`, `code`.
5. **Links and images:** `a`, `img`.
6. **Tables:** `table`, `thead`, `tbody`, `tr`, `th`, `td`, `caption`.
7. **Collapsible sections:** `details`, `summary`.

Permitted attributes and Matrix extensions:

- **Color:** `span` may use `data-mx-color` and `data-mx-bg-color`, each with a `#RRGGBB` value.
- **Spoilers:** `span` may use `data-mx-spoiler`.
- **Math:** `span` and `div` may use `data-mx-maths`.
- **Other attributes:** `code` accepts `language-` classes, links require an approved absolute URI scheme, and image sources must use `mxc://`.
- **Limits:** Arbitrary CSS (`style`), scripts, and event-handler attributes are not permitted. Clients may support fewer tags, so collapsible sections and color cannot be the only way to understand activity or status.

### Bounded tool-call disclosure

These are initial limits, measured on the unescaped source text before HTML formatting:

| Content | Visible summary | Maximum in expanded detail |
| --- | ---: | ---: |
| Tool result (read, write, edit, or terminal output) | 1 KiB UTF-8 | 8 KiB UTF-8 |
| Terminal command/title | 160 Unicode characters | 2 KiB UTF-8 |

Show short results directly. For a longer result, keep an abbreviated `<pre><code>` preview visible and put the detailed result in a closed `<details><summary>Detailed result</summary>…</details>` under the same tool event. The expanded view contains at most the hard limit. If it was cut short, append ` (truncated)` to its `<summary>` label instead of inserting a cut-off marker into the detailed code block. The plain-text `body` contains the preview and a truncation notice, not a hidden copy of the entire result. If a client does not support `details`, the preview remains readable and the summary still states when the detail is truncated. Preserve the existing outer tree: live tool activity stays visible; past events collapse, and only an expanded event exposes its detailed result.

For read, write, and edit, show the first bytes in the preview and detailed view. For terminal output, show the most recent 1 KiB in the preview so live progress remains visible; show the entire output once if it is at most 8 KiB, otherwise retain the first 6 KiB and most recent 2 KiB for the detailed view, separated by a blank line; the `<summary>` marks the detail as truncated. Append incoming chunks to this bounded view rather than retaining unbounded output. Never split a UTF-8 character; prefer whole lines, but do not exceed the limits to preserve a line. For an edit's two full-file strings, share each result limit evenly between old and new so both remain visible. Count displayed file line numbers against the original text, not truncated excerpts.

For long terminal commands, abbreviate only the displayed title to 160 characters with an ellipsis. Put the command text (up to 2 KiB) in a separate closed `<details><summary>Detailed command</summary><pre><code>…</code></pre></details>` under the title. If it exceeds 2 KiB, label the `<summary>` `Detailed command (truncated)` rather than adding a cut-off marker to the command text; never present the abbreviated command as though it were complete. ACP's title is a display label, not necessarily a runnable command. Keep output disclosure separate from command disclosure; either may need expansion without the other. A schematic long-running terminal event looks like this (the short placeholder text is not a literal threshold example):

```html
<p><span data-mx-bg-color="#F2F2F2"><span data-mx-color="#000000">┃</span> <span data-mx-color="#000000">🔧 Execute(python3 -c '…'…)</span></span></p>
<details><summary>Detailed command (truncated)</summary><pre><code>python3 -c 'print("alpha")'</code></pre></details>
<pre><code>recent output…</code></pre>
<details><summary>Detailed result (truncated)</summary><pre><code>first output&#10;&#10;recent output</code></pre></details>
```

The limits are defaults, not a promise that Matrix will accept every formatted event: cap the serialized Matrix event (including HTML markup and the plain-text fallback) at 48 KiB by reducing detailed content before the preview, updating the corresponding `<summary>` to indicate truncation. Escape text after selecting excerpts, and avoid duplicating output from `rawOutput` or other ACP fields. These bounds apply while streaming and across status updates, not only at turn completion.

## Event Rendering
### Thoughts

Render each chunked thought as a single entry. Use a thought-bubble emoji followed by the thought text.

```html
<p>💭 Preparing initial write</p>
```

### Tool Calls

Treat `tool_call` and subsequent `tool_call_update` notifications with the same `toolCallId` as one evolving tool event. Use a color-coded heavy left rail (`┃`) to indicate the tool-call status. Then use a 🔧  to indicate a tool call. Then include the specific tool call title.

#### Reads

For reads, use `Read(path)` as the title.

1. **Pending — gray (`#808080`):**

   ```html
   <p><span data-mx-bg-color="#EAEAEA"><span data-mx-color="#808080">┃</span> <span data-mx-color="#000000">🔧 Read(/tmp/output.txt)</span></span></p>
   ```

2. **Running — black (`#000000`):**

   ```html
   <p><span data-mx-bg-color="#F2F2F2"><span data-mx-color="#000000">┃</span> <span data-mx-color="#000000">🔧 Read(/tmp/output.txt)</span></span></p>
   ```

3. **Completed successfully — green (`#008000`), with output:**

   ```html
   <p><span data-mx-bg-color="#E6F4EA"><span data-mx-color="#008000">┃</span> <span data-mx-color="#000000">🔧 Read(/tmp/output.txt)</span></span></p>
   <pre><code>alpha&#10;beta&#10;</code></pre>
   ```

4. **Failed — red (`#C00000`), with an illustrative error if available:**

   ```html
   <p><span data-mx-bg-color="#FCE8E6"><span data-mx-color="#C00000">┃</span> <span data-mx-color="#000000">🔧 Read(/tmp/output.txt)</span></span></p>
   <pre><code>Permission denied</code></pre>
   ```

#### Writes

The agent's `write` tool is reported as ACP `kind: "edit"`. Show `Write(path)` with the same status rail and tinted background as Read. A successful new-file write has a `diff` result with `oldText: null`; display the returned `newText` with a simple line-number gutter counted from the beginning of that full-file text. Put a green `+` to the left of each line number as presentation.

1. **Pending — gray (`#808080`):**

   ```html
   <p><span data-mx-bg-color="#EAEAEA"><span data-mx-color="#808080">┃</span> <span data-mx-color="#000000">🔧 Write(/tmp/output.txt)</span></span></p>
   ```

2. **Running — black (`#000000`):**

   ```html
   <p><span data-mx-bg-color="#F2F2F2"><span data-mx-color="#000000">┃</span> <span data-mx-color="#000000">🔧 Write(/tmp/output.txt)</span></span></p>
   ```

3. **Completed successfully — green (`#008000`), with returned `newText`:**

   ```html
   <p><span data-mx-bg-color="#E6F4EA"><span data-mx-color="#008000">┃</span> <span data-mx-color="#000000">🔧 Write(/tmp/output.txt)</span></span></p>
   <pre><code><span data-mx-color="#008000">+</span><span data-mx-color="#000000">1 </span><span data-mx-color="#008000">alpha</span>&#10;<span data-mx-color="#008000">+</span><span data-mx-color="#000000">2 </span><span data-mx-color="#008000">beta</span>&#10;</code></pre>
   ```

4. **Failed — red (`#C00000`), with an illustrative error if available:**

   ```html
   <p><span data-mx-bg-color="#FCE8E6"><span data-mx-color="#C00000">┃</span> <span data-mx-color="#000000">🔧 Write(/tmp/output.txt)</span></span></p>
   <pre><code>Permission denied</code></pre>
   ```

#### Edits

Show `Edit(path)` with the same four status colors. In the observed edit, `rawInput.edits` contained an old/new replacement, an `in_progress` update reported `locations[].line: 3`, and the completed `diff` contained full-file `oldText` and `newText`. Display the old text in red and the new text in green. Count lines from the beginning of each returned full-file string and show those numbers in a black gutter beside its lines. Put red `-` to the left of each old line number and green `+` to the left of each new line number. If full-file text is unavailable, omit the gutter rather than imply absolute line positions.

1. **Pending — gray (`#808080`):**

   ```html
   <p><span data-mx-bg-color="#EAEAEA"><span data-mx-color="#808080">┃</span> <span data-mx-color="#000000">🔧 Edit(/tmp/output.txt)</span></span></p>
   ```

2. **Running — black (`#000000`):**

   ```html
   <p><span data-mx-bg-color="#F2F2F2"><span data-mx-color="#000000">┃</span> <span data-mx-color="#000000">🔧 Edit(/tmp/output.txt)</span></span></p>
   ```

3. **Completed successfully — green (`#008000`), with the returned old text in red and new text in green:**

   ```html
   <p><span data-mx-bg-color="#E6F4EA"><span data-mx-color="#008000">┃</span> <span data-mx-color="#000000">🔧 Edit(/tmp/output.txt)</span></span></p>
   <pre><code><span data-mx-color="#C00000">-</span><span data-mx-color="#000000">1 </span><span data-mx-color="#C00000">2</span>&#10;<span data-mx-color="#C00000">-</span><span data-mx-color="#000000">2 </span><span data-mx-color="#C00000">3</span>&#10;<span data-mx-color="#C00000">-</span><span data-mx-color="#000000">3 </span><span data-mx-color="#C00000">5</span>&#10;<span data-mx-color="#C00000">-</span><span data-mx-color="#000000">4 </span><span data-mx-color="#C00000">7</span>&#10;&#10;<span data-mx-color="#008000">+</span><span data-mx-color="#000000">1 </span><span data-mx-color="#008000">2</span>&#10;<span data-mx-color="#008000">+</span><span data-mx-color="#000000">2 </span><span data-mx-color="#008000">3</span>&#10;<span data-mx-color="#008000">+</span><span data-mx-color="#000000">3 </span><span data-mx-color="#008000">5</span>&#10;<span data-mx-color="#008000">+</span><span data-mx-color="#000000">4 </span><span data-mx-color="#008000">11</span>&#10;</code></pre>
   ```

4. **Failed — red (`#C00000`), with an illustrative error if available:**

   ```html
   <p><span data-mx-bg-color="#FCE8E6"><span data-mx-color="#C00000">┃</span> <span data-mx-color="#000000">🔧 Edit(/tmp/output.txt)</span></span></p>
   <pre><code>Could not apply edit</code></pre>
   ```

#### Terminal execution

Show `Execute(title)` with the same status rail and tinted background. In the observed pi-acp call, `title` was the command, but ACP only promises a human-readable title. The initial ACP `content` contained a terminal reference. pi-acp then sent output in `_meta.terminal_output.data` while `in_progress` and exit information in `_meta.terminal_exit` when `completed`. These `_meta` keys are pi-acp extensions.

1. **Pending — gray (`#808080`):**

   ```html
   <p><span data-mx-bg-color="#EAEAEA"><span data-mx-color="#808080">┃</span> <span data-mx-color="#000000">🔧 Execute(cat -- /tmp/output.txt)</span></span></p>
   ```

2. **Running — black (`#000000`), with output as it arrives:**

   ```html
   <p><span data-mx-bg-color="#F2F2F2"><span data-mx-color="#000000">┃</span> <span data-mx-color="#000000">🔧 Execute(cat -- /tmp/output.txt)</span></span></p>
   <pre><code>alpha&#10;beta&#10;</code></pre>
   ```

3. **Completed successfully — green (`#008000`), retaining the output:**

   ```html
   <p><span data-mx-bg-color="#E6F4EA"><span data-mx-color="#008000">┃</span> <span data-mx-color="#000000">🔧 Execute(cat -- /tmp/output.txt)</span></span></p>
   <pre><code>alpha&#10;beta&#10;</code></pre>
   ```

4. **Failed — red (`#C00000`), with illustrative output if available:**

   ```html
   <p><span data-mx-bg-color="#FCE8E6"><span data-mx-color="#C00000">┃</span> <span data-mx-color="#000000">🔧 Execute(cat -- /tmp/output.txt)</span></span></p>
   <pre><code>Command exited with code 1</code></pre>
   ```

## Verification

- A text thought chunk followed by `"\n\n"` appears as one live thought entry and counts once.
- Different `messageId` values create separate thought entries; repeated IDs append to their existing entries.
- Without IDs, tool and agent-message transitions separate thought runs, while metadata updates and whitespace alone do not. Late chunks do not create entries after turn closure.
- The thought example renders as a single paragraph with 💭 and unbolded text in an HTML-capable Matrix client; its plain-text fallback remains readable when HTML is unavailable.
- One read tool event transitions through pending, running, and either completed or failed; the status-tinted title includes one left rail and `Read(path)`, results use a separate code block without a rail, and the plain-text fallback includes the status.
- Write and edit use the same status progression. A new-file write displays only its returned `newText` with green `+` prefixes; an edit colors the returned `oldText` red with `-` prefixes and `newText` green with `+` prefixes, without labels or synthesized hunk headers. When the result contains full-file text, count its lines into a gutter after the sign and before the text; leave the title unchanged and do not treat optional `locations[].line` as a hunk offset. The plain-text fallback retains the text and line numbers in order.
- A terminal tool event retains streamed output while moving from running to completed or failed, without duplicating output; missing extension metadata does not create invented terminal text.
- Short tool results and commands stay visible. Long results show a 1 KiB summary and a collapsible detailed view capped at 8 KiB; long terminal titles show at most 160 characters and offer a separately collapsible command capped at 2 KiB. Truncated detailed views say so in their `<summary>` labels and plain-text fallback, not in their code blocks.
- Streaming terminal output preserves a recent visible tail and a bounded head-and-tail detail; older output does not grow bridge memory or Matrix event size without limit. An oversized encoded event shrinks details before its preview while keeping truncation explicit.

## Open questions


## Appendix


### Example ACP Trace

Here is a full sequence of ACP messages, trimmed and commented for readability.

```jsonc
// User prompt
{
  "method": "session/prompt",
  "params": {
    "prompt": [
      {
        "type": "text",
        "text": "First consider the safest way to handle a temporary file and briefly describe your plan before using tools. Use only these tools in order on a new scratch file: write /tmp/output.txt with exact text \"alpha\\nbeta\\n\"; read it; use bash (exec) to run only `cat -- /tmp/output.txt`; then briefly confirm completion. Do not inspect anything else or run any other command."
      }
    ]
  }
}

// This is hidden now
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "agent_thought_chunk",
      "content": { "type": "text", "text": "**Planning tools for text processing**" }
    }
  }
}
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "agent_thought_chunk",
      "content": { "type": "text", "text": "\n\n" }
    }
  }
}

// Agent message is collected, then displayed after the turn completes
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "I" }
    }
  }
}
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "’ll" }
    }
  }
}
// Same agent_message_chunk repeated to make it say:
// I'll create only the specified scratch file with the provided contents, verify it by reading it, then display exactly that file using the requested `cat --` command.

// Tool calls are not displayed
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "call-1",
      "title": "write",
      "kind": "edit",
      "status": "pending",
      "locations": [{ "path": "/tmp/output.txt" }],
      "rawInput": { "path": "/tmp/output.txt", "content": "alpha\nbeta\n" }
    }
  }
}
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-1",
      "status": "in_progress",
      "locations": [{ "path": "/tmp/output.txt" }],
      "rawInput": { "path": "/tmp/output.txt", "content": "alpha\nbeta\n" }
    }
  }
}
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-1",
      "status": "completed",
      "content": [
        { "type": "diff", "path": "/tmp/output.txt", "oldText": null, "newText": "alpha\nbeta\n" }
      ]
    }
  }
}
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "call-2",
      "title": "read",
      "kind": "read",
      "status": "pending",
      "locations": [{ "path": "/tmp/output.txt" }],
      "rawInput": { "path": "/tmp/output.txt" }
    }
  }
}
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-2",
      "status": "in_progress",
      "locations": [{ "path": "/tmp/output.txt" }],
      "rawInput": { "path": "/tmp/output.txt" }
    }
  }
}
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-2",
      "status": "completed",
      "content": [
        { "type": "content", "content": { "type": "text", "text": "alpha\nbeta\n" } }
      ],
      "rawOutput": {
        "content": [{ "type": "text", "text": "alpha\nbeta\n" }]
      }
    }
  }
}
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "call-3",
      "title": "cat -- /tmp/output.txt",
      "kind": "execute",
      "status": "pending",
      "content": [{ "type": "terminal", "terminalId": "call-3" }],
      "_meta": {
        "terminal_info": { "terminal_id": "call-3", "cwd": "/tmp" }
      }
    }
  }
}
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-3",
      "title": "cat -- /tmp/output.txt",
      "kind": "execute",
      "status": "in_progress"
    }
  }
}
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-3",
      "status": "in_progress",
      "_meta": {}
    }
  }
}
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-3",
      "status": "in_progress",
      "_meta": {
        "terminal_output": { "terminal_id": "call-3", "data": "alpha\nbeta\n" }
      }
    }
  }
}
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-3",
      "status": "completed",
      "_meta": {
        "terminal_exit": { "terminal_id": "call-3", "exit_code": 0, "signal": null }
      }
    }
  }
}

// Agent message is collected, then displayed after the turn completes
{
  "method": "session/update",
  "params": {
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "Completed" }
    }
  }
}
// agent_message_chunk repeated until it says:
// Completed: wrote, read, and displayed the specified scratch file.

// After the turn completes, the collected agent-message text is sent together.
```
