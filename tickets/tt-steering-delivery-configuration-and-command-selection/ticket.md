+++
name = "Steering delivery configuration and command selection"
creation_date = 2026-10-01T20:30:17Z
status = "pending"
+++

# Delivery configuration and command selection

Implement phase 1 of docs/message-delivery-implementation-plan.md and the command/configuration sections of specifications/mid-turn-steering.md on feat/message-delivery-steering.

Scope: src/config.ts and its tests, config.toml.example, a new small pure message-delivery selector module and tests. Do not modify src/bridge.ts or src/acp-client.ts (owned by other tickets).

Add matrix.default_message_delivery = prompt | steer, omission prompt, strict invalid-value validation, normalized BridgeConfig delivery field and test fixtures as required. Build a typed pure selector that distinguishes prompt/steer payloads, empty-command usage failures, exact /reset, and unprefixed/default or other slash-command text. Preserve non-command payload text; strip only recognized prefix and separating whitespace. Leave authorization/input byte accounting before selection to coordinator integration. /prompt /reset must yield prompt payload /reset, not reset.

Acceptance: table-driven tests for configuration default, both values, invalid types/values, override precedence, whitespace, empty payload, /reset independent of default, unrelated slash commands, multiline payload. Export a simple stable API and document it in work log for downstream coordinator. Run format/lint/typecheck and relevant tests; avoid unrelated fixture churn. Commit on your WAAP branch and hand off, do not merge default branch or delivery worktree yourself.
