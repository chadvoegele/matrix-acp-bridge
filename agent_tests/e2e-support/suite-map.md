# Agent-test grouping

Top-level `test_<name>.md` files describe behavior for humans; each has a matching
`test_<name>/` support folder. Shared transport, authentication, ownership, locks
and cleanup helpers live in `e2e-support/`.

| Behavior             | Support folder                                                    | Coverage boundary                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Encrypted message    | [test_encrypted_message](../test_encrypted_message/README.md)     | Crypto bootstrap, real SAS, persistent device keys and encrypted wire events with no plaintext fallback; exchange/restart assertions are shared with plaintext.          |
| Unencrypted message  | [test_unencrypted_message](../test_unencrypted_message/README.md) | Disabled encryption, plaintext wire events, Markdown and exchange/restart smoke coverage; no crypto setup.                                                               |
| Restart and recovery | [test_restart_persistence](../test_restart_persistence/README.md) | Graceful remembered-context and interrupted-input scenarios share a runbook, but remain separate runners because their failure boundaries differ.                        |
| Reset                | [test_reset](../test_reset/README.md)                             | Room control behavior; thread tests additionally verify reset isolation, steering tests verify reset barriers.                                                           |
| Steering             | [test_steering](../test_steering/README.md)                       | Startup, restart and reset checks protect steering selection and fallback, not a second general persistence suite.                                                       |
| Thread conversations | [test_thread_sessions](../test_thread_sessions/README.md)         | Routing and session isolation; encrypted coverage checks relations, while full restart/reset coverage currently uses plaintext.                                          |
| Agent activity       | [test_activity](../test_activity/README.md)                       | Rendering across four transport/response profiles; thread/encrypted wrappers add relation/wire assertions. Real metadata coverage remains separate from scripted output. |

Profile-specific provisioning, senders, cleanup and activity wrappers live with
their encrypted/plaintext or thread profiles and can be reused by the other tests.
The plaintext profile currently also supplies reset and recovery runners; their
matching support folders document those entry points. Historical reports remain
in support folders, not top-level behavior tests.

Do not equate graceful shutdown with crash recovery, or consolidate away the
encrypted setup and security contract merely because prompt/response behavior overlaps.
