# Unified rendering verification

Chad's Agent audited the implementation against
`specifications/unified-message-rendering.md`, the four-phase implementation plan,
and the mandatory CODE.md guidelines. Tested implementation revision:
`aeb7da5f9474e7a98132bb1a20a8b4b7beb08649`. The subsequent report-only commit
does not change tested code. No deployment or merge into main is authorized by
these results.

## Environment and results

Linux, Node 26.11.1, npm 12.2.0, pinned Matrix JS SDK 42.2.0 and ACP SDK 1.3.0.
All new subprocess state is disposable under a unique private temporary directory.
Loopback HTTPS tests use an ephemeral OpenSSL certificate trusted through a
subprocess-only `NODE_EXTRA_CA_CERTS`; TLS verification stays enabled.

| Command / scope                                                                        | Result                                                                 |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `npm ci`                                                                               | Passed                                                                 |
| Baseline `npm run check`                                                               | Passed: 566 tests, 0 failures/skips                                    |
| Final `npm run check`                                                                  | Passed: formatting, lint, typecheck/build; 570 tests, 0 failures/skips |
| `node --test agent_tests/e2e-support/unified-wire.test.mjs`                            | Passed: 2 tests, 0 failures/skips; real bridge/ACP/SDK subprocesses    |
| `node --test --test-name-pattern='post-prompt parallel' dist-test/integration.test.js` | Passed: 1 test, four mode/transport combinations                       |
| `agent_tests/e2e-support/test-unified.sh plaintext room`                               | SETUP BLOCKED: `E2E_HOMESERVER is required`                            |
| Same wrapper: `plaintext thread`, `encrypted room`, `encrypted thread`                 | Each SETUP BLOCKED by the same missing setting                         |

Live totals: 0 functional passes, 4 blocked setups; no live devices, rooms or ACP
sessions created. No designated test environment or retained test cache is
available in this execution environment. Existing historical live reports do
not verify this revision. Do not interpret the HTTPS protocol fixture as a real
Matrix server or the hermetic crypto adapter as real encryption/SAS coverage.

Real Pi E2E was not run. Per the prerequisite recorded for this work, installed
pi-acp lacks the required assistant message IDs. Stable IDs per Pi response,
non-interleaving, and IDs on unsolicited text must be validated in the separate
adapter work. The scripted peer proves the bridge's behavior under that contract.
No pi-acp changes, production restarts, production credentials, crypto resets or
trust bypasses were used.

## Specification acceptance audit

Each row maps a Verification criterion in specification order to executable
coverage. Buffer/activity tests use deterministic clocks or gated publications.
The added SDK-isolation test uses production ACP parsing and delivery with
hermetic SDK/crypto boundaries. Only the subprocess scenarios use real SDK HTTP.

| Criterion                                                        | Evidence                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unsolicited output after completion, no extra prompt             | `bridge.test.ts`: identified prompt completion; `integration.test.ts`: identified unsolicited continuations; scripted stream observes ACP response before updates and exact prompt count        |
| Same identified solicited/unsolicited behavior                   | Same tests and subprocess progressive prefix/continuation                                                                                                                                       |
| Repeated/distinct IDs; session isolation                         | Buffer repeated-delta tests; new SDK room/thread isolation with shared text/tool IDs; two scripted thread roots                                                                                 |
| Quiet tail flush and later same-event edit                       | Buffer quiet-flush test; subprocess Markdown prefix, suffix and continuation replacements                                                                                                       |
| Transition ordering and mapping retirement                       | Buffer transition, slow-send and retired-identity tests; twelve sequential scripted IDs                                                                                                         |
| Byte/max-interval triggers, bounded calls/timers                 | Buffer UTF-8 size/pacing, continuous deltas and timer-cleanup tests; config bounds/default tests                                                                                                |
| Slow transport serialization/coalescing                          | Buffer slow-send tests; bridge identified publication in flight; session-activity slow terminal/collapse test                                                                                   |
| Prompt completion independent of draining, no duplicate/fallback | Bridge identified prompt completion test; subprocess exact original count and post-response updates                                                                                             |
| Only current bounded block retained                              | Buffer retired-identity and bounded pending tests; bridge sequential assistant IDs                                                                                                              |
| Early tool announcement then same-ID text                        | Dedicated bridge test, new SDK-isolation test and subprocess same-target edit after tools                                                                                                       |
| Many IDs, bounded backpressure, observable failure               | Buffer retired identities/capacity/failure; bridge sequential IDs/capacity/publication failure; subprocess sequential IDs                                                                       |
| Restart discards mappings/history                                | Bridge restored-session replay test; integration restart/catch-up regressions                                                                                                                   |
| Text/activity ordering; whitespace/tools do not finalize         | Buffer transitions; bridge thought grouping, early tool and unsolicited tool tests; subprocess preceding text and expanded/collapsed activity                                                   |
| Pi ID prerequisite                                               | EXTERNAL BLOCKER: not established by scripted tests; separate pi-acp work required                                                                                                              |
| Unsolicited tool terminal/result updates                         | Bridge unsolicited parallel tools and activity rollover/result tests; subprocess terminal statuses after response                                                                               |
| Parallel tools survive transitions/completion                    | Session-activity independent batches; bridge unsolicited parallel tools; new SDK-isolation test; subprocess                                                                                     |
| Closed batches released after terminal/collapse, no index growth | Session-activity slow terminal, parallel batches and 100 sequential closed batches                                                                                                              |
| Reset/subprocess failure/transport failure clean up activity     | Session-activity transport/lifecycle failure; bridge reset and ACP subprocess failure; subprocess reset deliberately delivers stale text and terminal frames                                    |
| Safe Markdown, encoded limits and explicit truncation            | Buffer safe incremental Markdown, continuation, late truncation and event-budget tests; existing Markdown/packing/output tests; subprocess safe formatted replacements and encoded event budget |
| Unknown/stale/loading sessions; shutdown/failure cleanup         | Bridge reset/replay/unknown/failure tests; buffer reset/capacity timer tests; subprocess stale reset and buffered shutdown with abandonment diagnostic                                          |
| ID-less compatibility and bounded diagnostic                     | Existing solicited ID-less bridge regressions; dedicated ID-less unsolicited diagnostic test                                                                                                    |

No acceptance criterion was relaxed. Actual live encrypted transport and Pi
adapter validation remain explicit coverage limits. The encrypted wrapper is
reproducible with authorized devices and retains existing SAS/decryption gates.

## CODE.md audit

| Guideline group  | Assessment                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture     | Flow fits eight components: ACP wire, authorized session routing, text buffer, activity model, conversation publication queue, delivery policy, Matrix SDK, durable routing store. Buffer/activity share queue ownership and lifecycle.           |
| Structure        | Existing functional modules retained; new peer, observations and runner have separate roles. Explicit static mode selection; early validation; no metaprogramming or runtime source rewriting.                                                    |
| Debt             | Empty identified-ID transitions now reach the buffer and flush preceding text, with a focused regression. No second prompt-final identified publisher; ID-less compatibility remains scoped. No unrelated refactor or package dependency changes. |
| Abstractions     | Rendering stays behind buffer/activity publication interfaces. Test fixture is a narrow protocol boundary; it does not leak into production.                                                                                                      |
| Scoping          | Per-session state and per-run observation maps; no historical renderer cache or global test state shared between modes.                                                                                                                           |
| Naming           | Existing message/session/tool/batch terminology; named publication settings; bounded test counts and timeout constants describe scenarios.                                                                                                        |
| Responsibilities | ACP peer emits deltas, observations assert content, runner owns clients/processes. Production routing, buffering, transport retry and persistence retain separate contracts.                                                                      |
| Comments         | Comments explain adapter concurrency, deliberate stale frames, fixture limits and SDK handle cleanup. Work history remains in WAAP state.                                                                                                         |
| Dependencies     | No package dependency additions. Test TLS certificate generation uses the system OpenSSL executable, documented as a test prerequisite.                                                                                                           |
| Logging/errors   | Production diagnostics remain bounded and content-safe. Harness writes a concise test result; private operational errors remain subject to existing sanitization. No tokens/transcripts enter reports or commits.                                 |
| Feel/cleanup     | Existing composable components reused. Local subprocess groups, HTTPS server/connections and private files are retired; live wrappers retain exact session/device ownership cleanup and interrupted-run evidence.                                 |
| Testing          | Unit-heavy suite retained; added focused integration plus two actual subprocess/SDK HTTPS scenarios. Crypto doubles and external blockers are distinguished from live E2E.                                                                        |

## Review status

The implementation remains on `feat/unified-message-rendering` for review.
No merge into main or deployment was performed. Live Matrix verification and
separate Pi adapter validation remain required before claiming those passes.
