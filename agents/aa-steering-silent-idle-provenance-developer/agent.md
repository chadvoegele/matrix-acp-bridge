+++
name = "Steering silent idle provenance developer"
creation_date = 2026-10-01T23:36:13Z
status = "completed"
session_id = "01a0f9d3-975c-7913-a4f9-672b00962320"
system = "codex"
+++

# Developer: explicit versus default steering idle fallback

User requires Codex gpt-6.1-sol reasoning effort MEDIUM, never xhigh or a substitute model.

Read completely /home/chad/.pi/agent/skills/waap/SKILL.md and git-repositories skill; repository instructions; ticket /home/chad/.local/state/waap/data/home/chad/code/github.com/chadvoegele/matrix-acp-bridge/tickets/tt-steering-silent-idle-fallback-for-default-delivery/ticket.md; specifications/mid-turn-steering.md; selector/coordinator/integration tests. Implement this ticket in your launcher-created isolated worktree and branch, starting from feature HEAD adb01b26f195b6c90149255046b49d7378744208. Launcher owns worktree creation/removal; commit all intended tracked changes before exit.

STRICT PARALLELISM: Another child is finalizing live-test integration into shared feature. Never modify/merge/push shared worktree /home/chad/code/github.com/chadvoegele/matrix-acp-bridge/worktrees/steering-implementation or main; never push any branch; never post PR comments. Only your isolated branch and targeted WAAP agent work_log.md may change. Do not merge any other agent. Parent integrates after both children finish. Ticket already in-progress: DO NOT mark completed. No live Matrix testing needed. Do not update shared AGENTS.md.

Implement typed explicit/default provenance at message selection and carry it through admission entries, pending setup batches, closed dispatch gates, reset barriers and turn-boundary conversions. Do not infer provenance by reparsing stripped payload or original text at notice time. Explicit /steer idle sends `No running turn; message queued as a prompt.`; unmarked/default-steer idle silently becomes/submits a tracked prompt. ACP promptRequired has same distinction: explicit notice, default silent. All successful injections silent. Unsupported fallback MUST remain visible for both, as existing spec. Errors, usage unchanged. Preserve prompt FIFO and serial steering lane ordering, shared limits, input byte/authorization accounting, same payload/event identity, lifecycle handling, durable completion, no resend. Preserve prior README section removal; do not restore it.

Update specification and add selector and coordinator/integration regressions covering explicit/default idle and promptRequired, setup-batch provenance, unchanged unsupported and error behavior. Run full npm run check and git diff --check (fix failures). Commit only your changes on your own branch, message includes your agent ID and ticket ID. Maintain concise chronological WAAP work_log.md in your own agent state directory with decisions/check results and final branch/head. Do not change others' agent state. Tools run outside sandbox as WAAP supports danger-full-access; bubblewrap startup warning is known nonfatal if tools work, do not retry endlessly. If actually blocked record concrete blocker.

Continue until implementation committed and checks complete or concrete blocker. Final reply and work log must give exact branch, base/head and commit(s), full check result/test counts, changed files, findings and likely integration conflicts (parallel live-test changes). No promise-only completion. Do not mark ticket completed. You may mark your agent completed only on successful committed delivery.
