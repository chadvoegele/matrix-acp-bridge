+++
name = "steering-coordinator-exec"
creation_date = 2026-10-01T20:53:00Z
status = "completed"
session_id = "01a0f93d-eff0-7a81-9b5a-dece2157a801"
system = "codex"
+++

# WAAP steering delivery developer

Implement tt-steering-coordinator-lane-and-lifecycle for the approved matrix-acp-bridge steering implementation. Your unique name is steering-coordinator-exec. Read /home/chad/.pi/agent/skills/waap/SKILL.md and /home/chad/.pi/agent/skills/waap/roles/developer/agent.md completely. WAAP_STATE=/home/chad/.local/state/waap/data/home/chad/code/github.com/chadvoegele/matrix-acp-bridge. Read WAAP_STATE/tickets/tt-steering-coordinator-lane-and-lifecycle/ticket.md entirely, plus specifications/mid-turn-steering.md and docs/message-delivery-implementation-plan.md entirely. These are authoritative. Read other referenced specs and relevant source/tests.

IMPORTANT OVERRIDE of role template: work ONLY in the WAAP launcher-created worktree supplied as your cwd. Never create/remove worktrees. Never rebase onto, switch, merge into, or change main. Never merge any branch yourself, never push or open PRs. The integration coordinator alone integrates your committed branch into feat/message-delivery-steering and marks the ticket completed. Mark this ticket in-progress before changes but DO NOT mark it completed. Do not alter unrelated historical tickets/agents. Runner automatically marks your agent process status.

Implement and test the ticket completely. Include your actual agent ID and ticket ID in code commit messages. Maintain WAAP_STATE/agents/YOUR_AGENT_ID/work_log.md documenting changes, tests, limitations and your branch/commits; commit ONLY that log using git -C WAAP_STATE add agents/YOUR_AGENT_ID/work_log.md then git -C WAAP_STATE commit --only agents/YOUR_AGENT_ID/work_log.md -m '...'. Tolerate concurrent WAAP state changes/locks by retrying, never stage unrelated files. Do not include WAAP state in code commits. Run waap check.

Keep scope bounded to ticket; no unrelated cleanup. Commit all implementation and tests in your agent branch before exit: launcher deletes worktree, branch commits survive. Report actual test results and any blockers honestly in log and final response. Do not restart services or the hosting pi-web daemon. Read git-repositories/password-secrets skills if applicable. Do not silently substitute system/model.

Key behavior: default prompt with /prompt and /steer overrides; one unresolved prompt per conversation, serial bounded steering lane bypasses queued prompts but not reset. Shared waiting bound excludes active prompt. Preserve selection through closed dispatch/setup/permit waiting; first steer becomes prompt, later steer may target it once submitted, including catch-up. injected silently completes its event independently and durably; promptRequired converts once in admission order. Healthy method errors no retry, methodNotFound disables support; malformed/ambiguous failure fail closed. Original collectors/timer/permit remain untouched. Lifecycle must settle outstanding decisions and durable callbacks without deadlock/late misrouting. Thread roots independent; encrypted notices obey byte accounting. SDK pinned 1.3.0. PR #115 open: verify actual wire contract, no fabricated manual validation.

Foundations are integrated and check passed 419 tests. Read docs/steering-acp-transport.md and foundation agent work logs for API contracts. Implement the entire lane/lifecycle acceptance and controlled race tests; especially preserve later steering selections during setup and settle durable callbacks independently.
