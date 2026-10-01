+++
name = "Steering silent idle fallback for default delivery"
creation_date = 2026-10-01T23:34:45Z
status = "pending"
depends_on = ["tt-steering-integrated-verification-and-operator-docs"]
+++

# Silent idle prompt fallback for implicit steering

User-approved behavior update for PR22: explicit `/steer <msg>` while idle retains `No running turn; message queued as a prompt.`; an unprefixed message selecting steer through matrix.default_message_delivery must silently become and submit a tracked prompt while idle. Explicit /prompt remains unchanged. Successful injected steering remains silent. Unsupported-agent fallback stays visible as current specification (not part of this request). Actual errors and usage guidance remain visible.

Work from feature feat/message-delivery-steering, preserve README section removal. Read specifications/mid-turn-steering.md and selector/coordinator tests. Track selection provenance explicitly in a typed form, not by reparsing stripped payload or matching original text at notice time. Carry explicit/default provenance through gates, setup, pending steering, reset barriers and promptRequired boundary conversion. Suppress ONLY steering_idle notices for default-selected steering, in both local idle conversion and ACP promptRequired conversion. Preserve queue accounting, original payload/input byte authorization, event identity, dispatch ordering, durable terminal completion, and no user resend.

Update specification to reflect distinction; don't restore removed README section. Add selector tests and coordinator/integration coverage: explicit /steer idle notice, implicit steer-default idle silence and prompt, implicit steering promptRequired silence, explicit steering promptRequired notice, pending batch provenance during setup, unchanged unsupported notice/error behavior. Run full npm run check and git diff --check.

Execute WAAP developer via Codex gpt-6.1-sol reasoning effort medium (NOT xhigh). Agent works only launcher-managed branch, commits with agent/ticket IDs and maintains targeted WAAP work log. Do not merge main/shared feature or push; parent coordinator integrates committed branch after current live-test coordinator integration to avoid racing shared worktree changes. Return exact branch/commits/checks. No live room access required for this small update.
