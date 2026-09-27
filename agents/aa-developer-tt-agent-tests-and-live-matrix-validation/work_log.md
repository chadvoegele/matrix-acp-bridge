# Work log

2026-09-27

- Validated WAAP state, read the ticket and authoritative verbose-output specification, and rebased the isolated branch onto the shared feature branch before editing. Set the ticket in progress.
- Added an opt-in deterministic ACP emitter and plaintext Matrix wire scenario. The scenario checks raw message/edit events, replacement payloads, HTML disclosure and colors, fallback text, ten-event rollover, eager agent-message boundaries, truncation, bounded event size, and an archived-batch late update.
- Added an encrypted scripted scenario using the existing SAS-verified harness, plus a separate opt-in real-agent scenario that checks exact read/write/edit/bash ACP metadata and Matrix activity. The real-agent scenario reports incomplete metadata coverage and runs a configured scratch cleanup command even on failure.
- Preserved the existing E2E entry points and added safe invocation instructions. Added no credentials or private traces to tracked fixtures.
- Ran `npm ci`, `npm run check` successfully (246 tests), shell syntax checks, Node syntax checks, and a direct scripted ACP protocol smoke test successfully.
- Live Matrix test commands were not run: no test homeserver, room, account credentials, or real ACP command are configured in this worktree, and no ignored environment file is present. These are external prerequisites for the opt-in live tests.
- Created a signed implementation commit and fast-forward merged it into the sole shared feature branch. No PR was created and main was not changed.
