+++
name = "Steering coordinator lane and lifecycle"
creation_date = 2026-10-01T20:30:24Z
status = "completed"
depends_on = ["tt-steering-delivery-configuration-and-command-selection", "tt-steering-acp-extension-transport"]
+++

# Coordinator steering lane and lifecycle

Implement phase 3 of docs/message-delivery-implementation-plan.md using integrated configuration/selector and ACP transport foundations. Read specifications/mid-turn-steering.md completely. Scope mainly src/bridge.ts, response rendering and tests; reuse foundations rather than changing their contract casually.

Retain one prompt active through current turn/drain/delivery and ordinary FIFO. Add per-conversation serial steering lane with one unresolved steering RPC. Explicit commands override global default. Eligible steering bypasses normal waiting prompts, not queued reset. Preserve original admission sequence for converted prompt insertion and reset barriers. Local waiting bound is queued prompts plus pending/unresolved steering, excluding active prompt.

Critical behavior: preserve steering-selected entries while dispatch gates are closed or first prompt is setting up/waiting permit. In an idle conversation first steering becomes prompt; later steering waits for that prompt to start then injects. Do not convert every entry in same live/catch-up batch to prompt before setup completes. Default steer top-level thread roots each create an independent prompt; follow-ups alone share a conversation.

On injected: free steering waiting capacity, independently invoke durable terminal callback, no Matrix success message. On promptRequired: transfer same entry to ordinary FIFO in original admission order, keep completion pending until prompt terminal boundary, visible fixed fallback notice. Unsupported agent uses ordinary FIFO and visible notice. Healthy steering method errors terminally complete with fixed error without resubmission; method-not-found disables future steering for connection. Fatal/malformed/ambiguous timeout follows fail-closed path. No new permit/collector/active turn timer reset.

Settle in-flight steering decision before next prompt/reset starts after original prompt completion. Reevaluate unsent steering at dispatch. Track late responses, cancellation, shutdown grace, waitForIdle, run finalization, durable state errors and output delivery independently. Avoid deadlocks from shared outbound mutex, drain or capacity release. Preserve existing receipt/dedup/typing/encryption/output/thread behavior and startup gates.

Acceptance tests must cover msg1/msg2/msg3 steer-default batch startup, sequential steering during open prompt, ordinary prompt bypass, reset barrier, ordered fallback, prompt completion before steering response, shared full queue, active-permit exclusion, no timer reset, cancellation/shutdown/late result, independent durable callbacks, silence on injected, errors and missing capability, per-thread isolation. Use fake clocks/controlled promises rather than timing guesses. Run repository full npm run check, remediate regressions. Commit on WAAP branch and hand off; do not merge main/delivery yourself.
