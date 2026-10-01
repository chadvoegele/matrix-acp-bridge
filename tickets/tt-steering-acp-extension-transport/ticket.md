+++
name = "Steering ACP extension transport"
creation_date = 2026-10-01T20:30:17Z
status = "completed"
+++

# ACP steering extension transport

Implement phase 2 of docs/message-delivery-implementation-plan.md and capability/wire/error behavior from specifications/mid-turn-steering.md. Work on the feature base; do not change coordinator or configuration files owned by other tickets.

Inspect pi-acp PR #115's current actual contract (public GitHub endpoints or gh with approved credential handling) and pinned SDK 1.3.0. Add steering capability exposed only for response._meta.steering.supported === true while preserving loadSession. Add a typed AcpClient steering method/result API; optional interface method is acceptable for old test doubles, but production must implement it. Issue concurrent extension requests over shared SDK connection with sessionId, prompt text block, and mandatory _meta.steering.idleBehavior=promptRequired. Valid results injected and promptRequired/reason=noRunningTurn; malformed/unknown/startedNewTurn is fatal protocol error. Healthy method errors nonfatal and distinguish method-not-found so coordinator can disable support. Preserve diagnostics privacy and wire ID tracking. Steering must not overwrite active prompt collectors/cancellation.

Define where bounded steering timeout is enforced and ensure a lost response is treated as fatal/ambiguous with no automatic retry. Existing startup_timeout_seconds is the bound, not a new setting. Minimize dependency changes; upgrade SDK only if proved necessary.

Acceptance: fake-stream tests capability shapes, exact wire request, concurrent outstanding prompt+steering, injected, idle opt-in result, method errors/method-not-found, malformed results and transport failure; prompt result remains intact. Inspect updated interface use to preserve existing doubles. Run appropriate checks and full adapter tests. Record API and findings for coordinator ticket. Commit on WAAP branch; do not merge delivery or main yourself.
