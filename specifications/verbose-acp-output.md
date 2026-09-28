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

The first sentence is produced before the tool calls but currently displayed at the end. Send the first nonempty `agent_message_chunk` eagerly, then append subsequent chunks to that agent message as they arrive. Render the complete text-so-far as Markdown on every send and edit, using the same safe converter as regular replies; keep the original Markdown in the plain-text `body`. Incomplete Markdown may initially show literal syntax, but a later chunk must re-render completed bold, lists, links, and code. Raw HTML must remain escaped. `messageId` can identify a message but is optional; without it, group consecutive chunks and use tool/agent-message transitions to separate entries. A `"\n\n"` thought chunk is spacing, not another thought.

### Progressive Disclosure via Collapsible Trees

Model the agent's activity as a tree. Each depth reveals more information.

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

Group at most a configurable 10 activity events per Matrix message by default (minimum 1). Each grouped thought and each tool call counts once; status/output updates to a tool do not count again. The newest activity message shows its entries directly. When an eleventh event arrives, wrap the previous ten-event message in a collapsed `<details>` element with a summary such as `Past agent events (10)` and begin a new, expanded message. A new agent message is also a boundary: on its first nonempty chunk, collapse all remaining live activity batches, then show the agent's text eagerly in a separate message. The first ten events stay expanded until event 11 or an agent message; events 11–20 stay expanded until event 21 or an agent message, and so on. Even if an agent message follows immediately, each new batch must first be sent expanded before it is edited into its collapsed form.

While live, edit the same activity message as thoughts stream and tool statuses/results change; correlate updates by `toolCallId`. If a tool in an archived batch is still running, continue updating that batch when its status/output changes, even though this may re-collapse a disclosure someone opened. Tool updates must not be lost or counted as new events. Close a batch early if needed to fit the configured Matrix message-size limit, including HTML and plain-text bodies.

Full commands and results are shown only if their abbreviated versions were truncated.

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
| Tool result (read, write, edit, MCP, or terminal output) | 256 UTF-8 bytes or 3 lines, whichever comes first | 8 KiB UTF-8 |
| Terminal command/title | 160 Unicode characters | 2 KiB UTF-8 |

Show short results directly. For a longer result, put the abbreviated output itself in a closed `<details>` element's `<summary>`; expanding it reveals the detailed `<pre><code>` output. For terminal commands over 160 characters, make the abbreviated status-tinted title its own clickable `<summary>` with the command in `<pre><code>` beneath it. If the source exceeds a detailed-view cap, append ` (truncated)` to that summary. The plain-text `body` contains the previews and any truncation notices, not hidden detailed content.

Read, write, edit, and other tool previews and details start at the beginning of their result. For terminal output, show the most recent 256 UTF-8 bytes or 3 lines, whichever comes first, in the visible summary. When it exceeds 8 KiB, keep the first 6 KiB and last 2 KiB in the expanded view, separated by a blank line; otherwise show all of it. Bound streaming accumulation, avoid splitting UTF-8 characters, and keep old/new edit text identifiable. If ten events exceed the Matrix event-size limit after HTML escaping, roll over early; if one event alone is too large, further shorten its detailed view and mark its summary as truncated.

```html
<details><summary><span data-mx-bg-color="#F2F2F2"><span data-mx-color="#000000">┃</span> <span data-mx-color="#000000">🔧 Execute(python3 -c '…') (truncated)</span></span></summary><pre><code>python3 -c 'print("alpha")'</code></pre></details>
<details><summary><code>recent output…</code> (truncated)</summary><pre><code>first output&#10;&#10;recent output</code></pre></details>
```

## Event Rendering
### Thoughts

Group consecutive chunks of one thought into a single activity event. Keep spacing-only chunks (including `"\n\n"`) within that event rather than discarding them or counting them as another event. Render each paragraph separately with 💭; remove surrounding Markdown `**` or `__` from heading-like paragraphs rather than showing literal markers or bold text. Escape HTML inside paragraphs.

```html
<p>💭 Preparing initial write</p>
```

For source `**First heading**\n\n**Second heading**`, the same one event renders as:

```html
<p>💭 First heading</p>
<p>💭 Second heading</p>
```

### Tool Calls

Treat `tool_call` and subsequent `tool_call_update` notifications with the same `toolCallId` as one evolving tool event. Use a color-coded heavy left rail (`┃`) to indicate the tool-call status. Then use a 🔧  to indicate a tool call. Then include the specific tool call title.

Use color cues where possible to make activity easy to understand at a glance. For example, tool-call status should be gray when pending, black when running, green when completed successfully, and red when failed. For file diffs, red text is old and green text is new.

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

#### MCP and other tools

ACP reports pi-acp's MCP dispatcher as `kind: "other"` with `title: "mcp"`. A search call's `rawInput.search` holds the query; its completed result may be a plain-text list of available tools, not individual tool-call events. Show `MCP(search)` for that call. A schema lookup sends `rawInput.describe` with the named tool and displays `MCP(toolname)`. pi-acp can also report per-server tool calls with titles such as `mcp__example` and `rawInput: { "tool": "list", "args": {} }`; show `MCP(example/list)`. For other calls, show a recognizable name from bounded `rawInput` (`tool`, `toolName`, `name`, or a `call` object); otherwise show `MCP` or the known server name. Do not infer a called tool from search-result text or display arbitrary arguments as a tool name. Keep the same status styling, result preview and expanded cap as other tools.

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

- Streamed agent messages use the same Markdown HTML conversion as regular replies on initial send, subsequent edits, and completion; their plain-text body preserves the original Markdown, and raw HTML stays escaped.
- A text thought chunk followed by `"\n\n"` and another paragraph appears as one live thought event, counts once, and renders separate unbolded 💭 paragraphs rather than a run-on line.
- Different `messageId` values create separate thought entries; repeated IDs append to their existing entries.
- Without IDs, tool and agent-message transitions separate thought runs, while metadata updates and whitespace alone do not. Late chunks do not create entries after turn closure.
- The thought example renders as a single paragraph with 💭 and unbolded text in an HTML-capable Matrix client; its plain-text fallback remains readable when HTML is unavailable.
- One read tool event transitions through pending, running, and either completed or failed; the status-tinted title includes one left rail and `Read(path)`, results use a separate code block without a rail, and the plain-text fallback includes the status.
- Write and edit use the same status progression. A new-file write displays only its returned `newText` with green `+` prefixes; an edit colors the returned `oldText` red with `-` prefixes and `newText` green with `+` prefixes, without labels or synthesized hunk headers. When the result contains full-file text, count its lines into a gutter after the sign and before the text; leave the title unchanged and do not treat optional `locations[].line` as a hunk offset. The plain-text fallback retains the text and line numbers in order.
- A terminal tool event retains streamed output while moving from running to completed or failed, without duplicating output; missing extension metadata does not create invented terminal text.
- Short tool results and commands stay visible. For long results, the abbreviated output is the clickable `<summary>` revealing a detailed view capped at 8 KiB. For long terminal titles, the abbreviated status-tinted `Execute(…)` is a separate clickable `<summary>` revealing command text capped at 2 KiB. A ` (truncated)` suffix appears on either summary only if the source exceeded its expanded-content cap; the plain-text fallback also notes truncation.
- Streaming terminal output preserves a recent visible tail and a bounded head-and-tail detail; older output does not grow bridge memory or Matrix event size without limit. An oversized encoded event shrinks details before its preview while keeping truncation explicit.
- With the default batch size, events 1–10 appear expanded until event 11 collapses that message and starts a new expanded one; event 21 does the same to events 11–20. The first nonempty agent-message chunk collapses every remaining live batch. No batch is first sent collapsed. Tool updates do not count as additional events; a late update edits its archived batch rather than losing the result. Oversized batches roll over early.

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
