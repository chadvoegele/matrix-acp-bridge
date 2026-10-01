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

- Scoped ESLint auto-fix and Prettier formatting passed with no changes needed.
- Initial `npm run check` passed formatting but stopped at ESLint's existing
  maximum of 32 files using the default TypeScript project. The new selector test
  makes 33; increased only that file-count allowance from 32 to 33 in
  `eslint.config.js`, as required for the added tests. No lint rules changed.
- `waap check` passed; WAAP state resolved to the prescribed central directory.

- Final `npm run check` passed: Prettier check, repository-wide ESLint,
  TypeScript typecheck, build, test compilation, and all 407 tests. Zero failed,
  cancelled, skipped, or todo tests. This includes the four new selector test
  groups, four new delivery-configuration test groups, and existing bridge,
  sync, thread/encryption, persistence, and integration regressions.
  Full local output: `/tmp/matrix-acp-aa-steering-config-exec-check.log`.
- `git diff --check` passed. Reviewed the changed files: the eight unrelated
  test suites have only their required fixture field added. `src/bridge.ts` and
  `src/acp-client.ts` remain unchanged; SDK dependency remains pinned at 1.3.0.
- Rechecked the public [pi-acp PR #115](https://github.com/svkozak/pi-acp/pull/115)
  page (still open) and downloaded its current patch for source inspection.
  Confirmed `_meta.steering.supported = true`, extension method
  `_session/steering`, params `sessionId` and `prompt`, idle opt-in
  `_meta.steering.idleBehavior = "promptRequired"`, idle response
  `promptRequired` / `noRunningTurn`, and `injected` only after awaiting native
  `session.proc.steer(message, images)`. Native steer itself awaits the Pi RPC.
  Without idle opt-in the patch can return `startedNewTurn`. This is a source
  contract review only: no live pi-acp manual validation was performed for this
  configuration/selection ticket, and no server acknowledgement or model
  consumption was asserted experimentally.
- Committed all implementation/tests on branch `aa-steering-config-exec`:
  `3a2dce5` — `aa-steering-config-exec
  tt-steering-delivery-configuration-and-command-selection: add delivery
  defaults and command selector`. The code worktree is clean.
- Initial log-only WAAP commit: `743054b`; final validation/handoff notes are
  committed separately to the same agent log, excluding other WAAP files.

Ready for coordinator integration. No remaining blockers for this ticket's
scope. Ticket deliberately remains `in-progress`; the integration coordinator
alone integrates the committed branch into `feat/message-delivery-steering`
and marks it completed. Runner owns agent status and worktree lifecycle.
