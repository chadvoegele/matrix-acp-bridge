+++
status = "draft"
created = 2026-09-24
last_update = 2026-09-25
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

The examples below use `/tmp/output.txt` and substitute IDs. **ACP v1 standard** labels mark protocol-defined structures; **pi-acp extension** labels mark implementation-specific fields. Optional standard fields and exact tool-input shapes are not guaranteed for every agent.

#### Thought chunk

> **ACP v1 standard:** `agent_thought_chunk` carries streamed agent reasoning. Its presence is optional.

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      "sessionUpdate": "agent_thought_chunk",
      "content": { "type": "text", "text": "**Planning tools for text processing**" }
    }
  }
}
```

#### Read tool call

> **ACP v1 standard:** `tool_call` identifies the call; `tool_call_update` patches its status and content. `rawInput` and `rawOutput` are optional, and their internal shapes are tool-specific.

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "call-read",
      "title": "read",
      "kind": "read",
      "status": "pending",
      "rawInput": { "path": "/tmp/output.txt" }
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-read",
      "status": "completed",
      "content": [
        { "type": "content", "content": { "type": "text", "text": "alpha\nbeta\n" } }
      ],
      "rawOutput": { "content": [{ "type": "text", "text": "alpha\nbeta\n" }] }
    }
  }
}
```

#### Edit tool call

> **ACP v1 standard:** `kind: "edit"` covers modifications, including this agent's write operation. A `diff` content block reports the new file (`oldText: null`).

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "call-write",
      "title": "write",
      "kind": "edit",
      "status": "pending",
      "rawInput": { "path": "/tmp/output.txt", "content": "alpha\nbeta\n" }
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-write",
      "status": "completed",
      "content": [
        { "type": "diff", "path": "/tmp/output.txt", "oldText": null, "newText": "alpha\nbeta\n" }
      ]
    }
  }
}
```

#### Execute tool call

> **ACP v1 standard:** `kind: "execute"` and a `terminal` content block describe an executable tool call and terminal reference. `title` is a human-readable label; this agent puts the command there, but ACP does not require that. Standard terminal methods require a negotiated client terminal capability.

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "call-exec",
      "title": "cat -- /tmp/output.txt",
      "kind": "execute",
      "status": "pending",
      "content": [{ "type": "terminal", "terminalId": "terminal-1" }]
    }
  }
}
```

> **pi-acp extension:** The appendix also shows `_meta.terminal_info` on the initial call. This agent streams terminal data and exit information in `_meta.terminal_output` and `_meta.terminal_exit`, rather than standard `terminal/output` responses. ACP permits `_meta`, but does not define these keys or their values.

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-exec",
      "status": "in_progress",
      "_meta": {
        "terminal_output": { "terminal_id": "terminal-1", "data": "alpha\nbeta\n" }
      }
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "example-session",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "call-exec",
      "status": "completed",
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

### Progressive Disclosure via Collapsible Trees

We can model the agent's activity for the UI as a tree. Each level of tree depth progressively displays more information to the user.

1. Past agent activity
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

## Verification


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
