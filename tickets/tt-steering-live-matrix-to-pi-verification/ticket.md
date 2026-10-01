+++
name = "Steering live Matrix-to-Pi verification"
creation_date = 2026-10-01T22:35:51Z
status = "pending"
depends_on = ["tt-steering-integrated-verification-and-operator-docs"]
+++

# Live Matrix-to-Pi steering verification for PR 22

User requests a developer agent to actually test the full live Matrix -> bridge -> real pi-acp/Pi -> Matrix path of https://github.com/chadvoegele/matrix-acp-bridge/pull/22, not merely ACP or hermetic Matrix tests. Delivery feature worktree /home/chad/code/github.com/chadvoegele/matrix-acp-bridge/worktrees/steering-implementation; preserve latest README section removal, don't merge main.

Read skills git-repositories, password-secrets, and docker-service-management if relevant. Inspect existing agent_tests live plaintext/encrypted/thread harnesses and cleanup instructions; reuse temporary test devices and designated rooms. Canonical bare repo root /home/chad/code/github.com/chadvoegele/matrix-acp-bridge/.env already exists and may contain intended test environment/secret lookup expressions: use privately, never print/commit secrets or source blindly without safe inspection. Do not claim credentials unavailable before checking documented local harness setup and password-store entry names. Retrieve credentials via nopass_pass.sh, no plaintext secret outputs. Create only necessary temporary test data/devices; clean using documented order and retain private recovery info if cleanup fails. Never send test messages to arbitrary non-test rooms, delete shared history, or restart production/hosting pi-web services.

Steering requires exact pi-acp PR #115 head; upstream main is not sufficient. Locate existing compatible private build first, or fetch refs/pull/115/head into isolated build/worktree using repository skill; record commit SHA. Current previous tested head d7f9cb2428c992c62aa759919c799c5619a9b10b. Test actual feature bridge production build and actual Matrix homeserver; real-agent-probe alone models Matrix and does not satisfy this ticket.

Required live checks as feasible: prompt sent via Matrix starts a real turn; /steer injected while prompt pending and no success notice; idle steer automatically becomes tracked prompt; explicit /prompt FIFO; default-steer msg1/msg2/msg3 same conversation first prompt then steering; output routes correctly. Include thread follow-up isolation and encrypted thread/room coverage using available documented test rooms. Observe wire RPC acceptance and actual Matrix event IDs without assuming model compliance. Keep startup baseline caveat in mind (don't treat first-sync baseline messages as live). Test unknown-thread/unauthorized only with controlled fixtures if relevant. Save sanitized reproducible report, exact bridge/upstream revisions, commands/scenarios/result counts, and precise limitations; don't leak identifiers/secrets unnecessary to publish.

Fix discovered genuine defects on own WAAP branch with targeted regression tests; rerun full npm run check if code/harness changes. Agent must commit report/tests/fixes and keep WAAP work log, but not merge default or shared feature branch. Coordinator integrates after review, pushes PR22, posts sanitized live results under "Chad's Agent". If a real prerequisite is unavailable, report exact missing capability/config securely and do not represent partial coverage as live success. Ticket only completed after attempted live testing and truthful integrated report; blocked missing credentials is not a successful test.
