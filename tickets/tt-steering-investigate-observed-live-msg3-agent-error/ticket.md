+++
name = "Steering investigate observed live msg3 agent error"
creation_date = 2026-10-01T23:36:52Z
status = "pending"
depends_on = ["tt-steering-integrated-verification-and-operator-docs"]
+++

# Investigate user-observed live msg3 error

User observed in the designated live Matrix test room:
notchad0: `msg3-ca0e9d690a3f: Reply briefly with msg3-ca0e9d690a3f.`
chadbot0: `No running turn; message queued as a prompt.` followed by `[agent error]`.

This must be explained rather than dismissed as passing scenarios. Live tester aa-fef64b71 branch commit 5cf0c8fd42bcf87eb0d5d64f93cc46f3716a6ddd adds report/harness and passed some room/thread runs, but mode-switch startup recovery and fresh baseline run had unexpected extra sessions/prompts. Raw evidence was in its launcher worktree node_modules and may have been removed. Sanitized report exists on that branch under agent_tests/steering/live-verification-report.md; agent WAAP work_log is preserved. User's concrete msg3 token may identify a failed/recovered/cancelled run omitted from passing counts.

Use WAAP Codex gpt-6.1-sol reasoning medium. Work only own launcher worktree; don't merge main/shared feature or push. Read ticket and live report on agent branch, implementation/spec and live harness. Root canonical .env contains private documented test setup; password-secrets skill/nopass_pass.sh handling mandatory, never print credentials. Locate existing retained logs/session data safely if available. Query live designated test room timeline using existing authorized test credentials/temporary device, correlate exact msg3 token, event relations/timestamps, output errors, startup/recovery/shutdown phase. Record sanitized evidence and clean any temporary device. Do not send new arbitrary messages or delete room history. If reproduction needed, only documented designated test rooms with controlled harness and pi-acp PR115 head d7f9cb2 (or recorded actual head), bounded runs and cleanup.

Determine whether `[agent error]` stems from ACP session/prompt healthy method error, agent/tool/auth issue, cancelled/deleted session race, leftover mode-switch recovery, bridge mapping/lifecycle defect, or test harness error. Don't guess from generic Matrix error. If evidence unavailable, distinguish proven observations from hypotheses and explicitly report uncertainty. Reproduce and fix bridge/harness defect if found with focused regression tests and full npm run check; prevent test harness false passes that ignore pertinent unexpected errors. Preserve README section removal and implicit-vs-explicit idle notice update being concurrently implemented; avoid touching its selector/provenance files unless necessary and document conflicts.

Commit sanitized investigation report and any justified fix/regression test in own agent branch with ticket/agent IDs. Keep targeted WAAP log. Parent integrates after other agents finish, updates PR22 with actual findings; ticket not completed by agent. Deliver exact commits, causal diagnosis or concrete blocker, verification and cleanup status. Do not treat only earlier reported zero ACP errors within passing snapshots as explanation for this observed error.
