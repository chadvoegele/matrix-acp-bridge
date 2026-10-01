# Prompt and steering implementation plan

Authoritative behavior: [specification](../specifications/mid-turn-steering.md).
Delivery branch: `feat/message-delivery-steering`. Do not merge to `main`.

## Work breakdown

1. **Configuration and command selection**: add the delivery default and a small
   pure command-selection module with tests. Keep default prompt compatibility.
2. **ACP steering adapter** (parallel with 1): inspect upstream PR #115 and SDK
   1.3.0, add capability/result types and an extension request path, validate
   outcomes, and test a response while a prompt request remains unresolved.
3. **Coordinator and lifecycle** (depends on 1 and 2): preserve the prompt FIFO,
   add a bounded serial steering lane, automatic idle conversion, reset barriers,
   per-event completion, silent injection success, and race/shutdown handling.
4. **Integrated verification and operator documentation** (depends on 3): audit
   the entire spec, extend fake-agent/sync tests, add encrypted/thread routing
   coverage, update the README, run the full check gate, and remediate findings.

## Architecture constraints

- One unresolved `session/prompt` per conversation, as today. No extra collectors
  for steering and no concurrent-prompt output correlation work.
- Delivery selection happens at admission; eligibility happens at dispatch.
  Preserve later steering messages while the first prompt starts, including when
  an entire live or catch-up batch arrives before startup/setup completes.
- Shared waiting bound includes queued prompts and unresolved steering; the
  active prompt is excluded. One unresolved steering request per conversation.
- Preserve admission sequence when converting steering to prompt FIFO. Ordinary
  prompt backlog is not a steering barrier; reset is.
- `injected` completes that event independently and silently. `promptRequired`
  becomes a tracked prompt without user resend or premature durable completion.
- Timeout/transport ambiguity never triggers automatic input redelivery.
- Existing startup gates, cancellation, bounded shutdown, typing, output routing,
  privacy, encryption, and deterministic Matrix retry guarantees remain intact.

## Execution and review

Use WAAP developer agents via Codex model `gpt-6.1-sol`, reasoning effort `medium`.
Each agent works only in its WAAP-created worktree and commits its changes.
The coordinator integrates finished agent branches into the delivery branch;
WAAP ticket completion follows integration and verification. Parallel agents
must not race to merge into the shared delivery worktree. Never change `main`.

Review the implementation against every specification requirement and run
`npm run check`. Use controllable fake ACP streams for races rather than model
behavior. Attempt real pi-acp validation only against a revision implementing the
reviewed extension; report unavailable upstream support or credentials honestly.
Create one new GitHub implementation PR, clearly marked "Chad's Agent", with
verification results and remaining limitations. Leave it unmerged for user review.
