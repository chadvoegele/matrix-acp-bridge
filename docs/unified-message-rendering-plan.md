# Historical unified message rendering implementation plan

This completed initial plan predates the collector refactor. See the [current collector evidence](collector-rendering-verification.md).

Implement `specifications/unified-message-rendering.md` on `feat/unified-message-rendering`, leaving main unchanged until review.

## Ticket sequence

1. **Buffering foundation:** add validated flush settings and a focused session/message text-buffer component with deterministic-clock tests. Cover ID transitions, safe incremental publication, output caps, serialized/coalesced edits, and bounded pending work. Reuse existing rendering/transport primitives.
2. **Bridge text integration:** route identified chunks independently of prompts; bind sessions to existing authorized rooms/threads; remove identified-message prompt-drain ownership while preserving ID-less compatibility, errors, replay filtering, reset and shutdown. Cover solicited/unsolicited streams and restart behavior.
3. **Session activity integration:** move thought/tool ownership to sessions; preserve existing presentation and ordering; handle parallel calls and unsolicited terminal updates. Retire mappings after terminal publication and batch collapse, not merely assistant ID changes. Exercise failures and bounded state.
4. **Integrated verification and PR:** audit all spec requirements, complete missing tests/docs, run full checks and isolated E2E. Add a scripted ACP-peer scenario producing identified unsolicited text/tools (including progressive edits), room/thread coverage, and encrypted coverage where feasible. Open an implementation PR with accurate evidence and remaining limits.

Each ticket depends on its predecessor to avoid concurrent edits to bridge ownership. Developers use WAAP-isolated worktrees, integrate committed results into the feature worktree only, and leave main and production services untouched.

## Review and verification

After developers finish, the coordinating agent reviews the implementation against the specification and CODE.md, independently runs checks and E2E, and creates remediation tickets for defects. Do not conflate scripted ACP integration with a live Pi/Matrix pass. pi-acp message IDs are an external prerequisite; do not implement unrelated pi-acp execution fixes. A live Pi adapter without IDs cannot establish the identified-message contract.

Use disposable test sessions/devices/state and follow agent_tests instructions. Never expose tokens, private messages, crypto keys, or personal configuration in commits, PRs, or reports. Do not deploy or merge the implementation PR without user approval.
