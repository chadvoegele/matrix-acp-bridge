+++
status = "draft"
created = 2026-09-24
last_update = 2026-09-26
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

"""
I’ll create only the specified scratch file at its explicit /tmp path, verify its contents, then display it with the exact allowed cat -- command. No other files or commands will be touched.Completed: wrote, read, and displayed the specified scratch file.
"""

The first sentence is produced before the tool calls but only displayed at the end. We should display the message chunk when the agent finished writing. We can tell in this case because the tool calls start after.

Whitespace is another possible boundary heuristic: after joining chunks, a double newline can indicate a paragraph break. It is not an ACP end-of-message marker. In a separate five-tool probe, the agent sent two `agent_thought_chunk` updates—a heading and a `\n\n` chunk—which together formed one thought, not two. It also sent agent-message text before each tool call, with no double newlines or `messageId` in those text runs. Tool-call transitions helped segment that trace; whitespace alone would not have. In a harder six-tool arithmetic probe, four thought chunks formed two thought runs after tool results: each run contained text followed by a `\n\n` chunk. Type transitions (`tool_call_update` → thought → agent message) helped group those runs, but neither they nor whitespace signaled the end of an agent message reliably; the agent-message runs still had no double newlines or `messageId`. Eager messages should remain provisional when boundaries are inferred this way.

### Identifying and displaying thought events

The UI should display thought text in its own entries, separate from agent messages and tool calls. Group ACP chunks into those entries using these rules, in priority order:

1. Only `session/update` notifications with `sessionUpdate: "agent_thought_chunk"` are thought chunks. Do not infer thoughts from an `agent_message_chunk`'s wording or Markdown.
2. When a thought chunk has a `messageId`, append chunks with that ID to the same thought entry; a different ID starts another. ACP v1 permits IDs but does not require them.
3. Without an ID, join consecutive thought chunks for the active turn into one entry. A whitespace-only chunk, including `"\n\n"`, does not create or increment a thought entry. Render it as spacing within the entry if useful; a double newline alone is not an ACP end marker.
4. Without IDs, an agent-message or tool-call transition closes the provisional thought entry; a later thought chunk starts a new one. Do not split solely on unrelated session metadata or usage updates. These are UI heuristics, not guaranteed ACP message boundaries.
5. Render an entry incrementally while its chunks arrive. Count grouped thought entries, not individual chunk notifications, in **Past Agent Events**. A late update after the turn closes must not create a new visible thought for that turn.

In the GPT-6 Luna probe, `"**Preparing initial write**"` followed by `"\n\n"` formed one entry; after intervening activity, `"**Summing file integers**"` followed by `"\n\n"` formed another. The four chunks therefore represented two visible thought entries.

### Thought event rendering

Render each grouped thought as a standalone, single-paragraph entry: a thought-bubble emoji followed by the thought text. For the first observed thought, the proposed Matrix `formatted_body` is:

```html
<p>💭 Preparing initial write</p>
```

The corresponding plain-text `body` is `💭 Preparing initial write`. For this heading-like thought, omit the source's surrounding Markdown `**` rather than displaying bold text; trailing `\n\n` is spacing, not another thought. Escape thought text before producing HTML. Keep the entry independent so it can later be nested in the progressive-disclosure tree. A single paragraph does not guarantee no visual wrapping in every Matrix client.

### Read tool call rendering

Treat `tool_call` and subsequent `tool_call_update` notifications with the same `toolCallId` as one evolving tool event. Prefix its label with 🔧 and show `Read(path)`; the label's color indicates status without status text in the HTML. Use `rawInput.path` when present, falling back to a path in `locations`. Escape the path and output as HTML. The following are `formatted_body` snapshots of **one** call, not four separate messages to retain in the room:

1. **Pending — gray (`#808080`):**

   ```html
   <p><span data-mx-color="#808080">🔧 Read(/tmp/output.txt)</span></p>
   ```

2. **Running — black (`#000000`):**

   ```html
   <p><span data-mx-color="#000000">🔧 Read(/tmp/output.txt)</span></p>
   ```

3. **Completed successfully — green (`#008000`), with output:**

   ```html
   <p><span data-mx-color="#008000">🔧 Read(/tmp/output.txt)</span></p>
   <pre><code>alpha&#10;beta&#10;</code></pre>
   ```

4. **Failed — red (`#C00000`), with an illustrative error if available:**

   ```html
   <p><span data-mx-color="#C00000">🔧 Read(/tmp/output.txt)</span></p>
   <pre><code>Permission denied</code></pre>
   ```

The plain-text `body` should name the status, path, and available result without relying on color. Use the displayable `content` once; do not duplicate it from `rawOutput`. Additional or missing status updates must not break the evolving event. These blocks can later become children of the progressive-disclosure tree.

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

## Verification

- A text thought chunk followed by `"\n\n"` appears as one live thought entry and counts once.
- Different `messageId` values create separate thought entries; repeated IDs append to their existing entries.
- Without IDs, tool and agent-message transitions separate thought runs, while metadata updates and whitespace alone do not. Late chunks do not create entries after turn closure.
- The thought example renders as a single paragraph with 💭 and unbolded text in an HTML-capable Matrix client; its plain-text fallback remains readable when HTML is unavailable.
- One read tool event transitions through pending, running, and either completed or failed; the label includes `Read(path)`, result text is not duplicated, and the plain-text fallback includes the status.

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
