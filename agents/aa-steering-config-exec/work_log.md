# aa-steering-config-exec work log

Ticket: `tt-steering-delivery-configuration-and-command-selection`
Branch: `aa-steering-config-exec`
Worktree: `/home/chad/code/github.com/chadvoegele/matrix-acp-bridge/worktrees/steering-implementation/worktrees/aa-steering-config-exec`

## 2026-10-01

- Read the assigned agent instructions, WAAP skill and developer role, ticket,
  steering specification and implementation plan, related thread-session,
  persistence and verbose-output specs, and relevant configuration,
  authorization and test fixtures. No applicable AGENTS.md files were present.
- Marked the assigned ticket in progress with the WAAP CLI before code changes.
  Kept all code work in the launcher-created branch/worktree. No merging,
  rebasing, pushing, service restarts, or ACP/bridge implementation edits.
- Installed locked dependencies with `npm ci` for local checks.
- Added `matrix.default_message_delivery` parsing, default `prompt`, strict
  validation, normalized required `matrix.defaultMessageDelivery`, and a
  `MessageDelivery = "prompt" | "steer"` type exported from `src/config.ts`.
  Added the setting to `config.toml.example`; minimally updated eight existing
  typed configuration fixtures with their default `prompt` field.
- Added pure command selection and table-driven tests for defaults, overrides,
  exact reset, usage errors, prefix boundaries, whitespace, preserved text,
  multiline/Unicode payloads, and nonrecursive command payload handling.

## Downstream selector API

Import `selectMessageDelivery` and type `MessageDeliverySelection` from
`src/message-delivery.ts`; import type `MessageDelivery` from `src/config.ts`.

`selectMessageDelivery(body: string, defaultDelivery: MessageDelivery)` returns:

- `{ kind: "prompt" | "steer", payload: string }`: selected agent input.
- `{ kind: "reset" }`: exact `/reset` bridge control.
- `{ kind: "usage", delivery: "prompt" | "steer", message: string }`: no agent
  input, with exact `Usage: /prompt <message>` or `Usage: /steer <message>` text.

Call with the authorized normalized body and
`config.matrix.defaultMessageDelivery`. Authorization and byte accounting must
precede selection and use the original normalized body. The selector removes
only a recognized prefix at the beginning and all separating whitespace;
remaining payload text, including trailing whitespace, is preserved.
`/prompt /reset` yields prompt payload `/reset`, and payloads are not reparsed.
The selector only chooses delivery: dispatch eligibility, steering support,
queue admission, notices, and lifecycle behavior belong to coordinator work.

## Validation and handoff

Checks in progress. Code commits and actual outcomes will be recorded before exit.
Ticket completion and integration are reserved for the integration coordinator.
