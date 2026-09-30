+++
name = "Thread sessions Matrix output and edit routing"
creation_date = 2026-09-30T19:04:32Z
status = "completed"
depends_on = ["tt-thread-sessions-configuration-and-routing-foundations"]
+++

# Thread-scoped agent sessions implementation

## Delivery contract
Approved source of truth: specifications/thread-scoped-agent-sessions.md, merged via GitHub spec PR #13. Repository: github.com/chadvoegele/matrix-acp-bridge. Integrate into feat/thread-scoped-sessions, based on main commit 290091d; target ONE separate implementation PR against main, never merge without the user's approval.

Use isolated agent/ticket worktrees and appropriately named branches. Read relevant source/tests and preceding ticket work logs before editing. Dependency tickets must be integrated into the feature branch before this ticket starts. Commit tested work, integrate it into feat/thread-scoped-sessions (not main), record commit IDs/results in your agent work log, and update ticket status through waap. Coordinate branch integration; never reset/overwrite other agents' work. Tickets that are parallel own separate storage vs outbound areas after shared foundations. Do not launch unrelated agents, expand scope, or create multiple feature PRs.

No changes to ACP session unloading or concurrency semantics: max_concurrent_prompts limits unresolved prompts only and does not count create/load. No aggregate room backlog cap in thread mode. All configured senders are authorized across all configured rooms; mappings confer no authorization. Authorization occurs before session work. Preserve default room behavior.

Verification: npm ci if dependencies are absent; npm run check is the final quality gate (formatting, lint, typecheck, build/test). Add focused tests per ticket and report exact commands/results. Live tests require approved harness setup and truthful disclosure of missing prerequisites. Use relevant skills, keep secrets/private artifacts out of git, mark public comments as Chad's Agent, and do not deploy to production.

## Scope
- Extend text and safe-HTML output contracts to carry optional thread-root metadata. Centralize standards-compliant m.thread content construction, including chosen fallback reply target and is_falling_back semantics. All multipart messages use the same root.
- For edits retain outer m.replace and put the thread relation in m.new_content, with valid fallback presentation. Do not overwrite edit relations with m.thread. Ensure verbose activity, thoughts/tools, eagerly published messages, later revisions and archived activity edits can retain routing context.
- Include relation/edit envelopes in exact full-payload byte accounting wherever existing renderers budget payload bytes. Preserve existing output limits, truncation and deterministic transaction-ID/retry behavior. IDs must not collide across distinct roots/rooms or response kinds.
- Use the existing validated-room send/encryption path for text, HTML, edits and all synthetic thread responses. Required encryption must never fall back to plaintext. Leave room-mode wire content unchanged.
- Support exact synthetic responses `Unknown thread agent session. Please start a new thread.` and unthreaded `Use /reset inside a thread to reset its agent session.` without ACP involvement. Preserve existing busy response wording unless a necessary change is explicitly documented; top-level rejection output may be threaded without creating known identity.

## Files / boundaries
Own src/matrix-message-content.ts, src/response-rendering.ts, src/matrix-client.ts outbound methods and activity rendering/update boundaries plus associated tests. Coordinate normalized inbound/output contracts from the foundation ticket. Do not change bridge scheduling here.

## Acceptance
Test plaintext and encrypted adapter content for originals, edits, split output, synthetic errors/guidance, activity updates, fallback targets and byte-boundary cases. Verify m.replace is intact, all parts retain the root, retry IDs remain stable, and room-mode output is unchanged.
