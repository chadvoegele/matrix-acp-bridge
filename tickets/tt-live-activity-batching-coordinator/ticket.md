+++
name = "Live activity batching coordinator"
creation_date = 2026-09-27T12:20:07Z
status = "pending"
depends_on = ["tt-acp-activity-html-renderer"]
+++

# Deliver live batched ACP activity and eager agent text

Integrate the transport and renderer on `feat/verbose-acp-output` following `specifications/verbose-acp-output.md`. Do not create the PR.

Scope:
- Stream first nonempty agent-message chunk eagerly, append following chunks without duplicate final messages, and preserve existing turn cancellation, quiet-drain, ordering, session restoration, response errors, initial-sync suppression, and per-room serialization.
- Group thought/tool activity into a configurable maximum of 10 events per Matrix message (minimum 1). Tool updates change the same event; the 11th event starts a new expanded live message and collapses the prior batch. First agent-message chunk also closes the current batch. Keep long command/output disclosure controls closed inside otherwise expanded live events. If a late update belongs to an archived batch, edit that archived batch rather than losing data; do not count it as another event. Accept that this may re-collapse an open disclosure.
- Use Matrix send/edit event IDs with deterministic retry semantics; ensure updates after a turn ends are ignored, but no in-flight data is silently dropped. Bound the combined JSON/HTML/plaintext event size using the configured Matrix message limit; roll over early when needed. Fit single oversized events by further cutting detailed text and marking truncation. Keep memory bounded for terminal streaming. Add config and config tests for the events-per-message limit.
- Add integration tests with fake ACP and fake Matrix for 10→11 rollover, agent-message boundary, late updates, concurrent rooms, failures/retries, restart/cancellation, and compatibility of old behavior.

Acceptance: `npm run check` passes. All sends and edits preserve plaintext fallback and encrypted-room gates. Signed commit if available; rebase and fast-forward merge shared feature branch, not main. No PR.
