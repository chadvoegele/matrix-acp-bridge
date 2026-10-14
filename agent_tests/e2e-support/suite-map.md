# Agent-test grouping

All top-level behavior descriptions follow `../AGENTS.md`: concise human-facing
scenarios, with execution details in subfolders. The full suite is grouped by
behavior, not by harness implementation or authentication mode:

| Behavior             | Technical instructions                                    | Deliberate overlap                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Message exchange     | [Message runners](../test_message/README.md)              | Plaintext and encrypted variants share one behavior description; retain separate crypto/SAS instructions. Both have restart smoke coverage.                                                      |
| Restart and recovery | [Recovery runners](../test_restart_persistence/README.md) | Graceful remembered-context and interrupted-input scenarios share a description and runbook, but remain separate runners because their failure boundaries differ.                                |
| Reset                | [Reset runner](../test_reset/README.md)                   | Room control behavior is independent; thread tests additionally verify reset isolation, steering tests verify reset barriers.                                                                    |
| Steering             | [Steering runners](../steering/README.md)                 | Startup, restart and reset checks protect steering selection and fallback, not a second general persistence suite.                                                                               |
| Thread conversations | [Thread runners](../thread-sessions/README.md)            | Routing and session isolation are independent of basic exchange; encrypted coverage checks relations, while full restart/reset coverage currently uses plaintext.                                |
| Agent activity       | [Activity runners](../test_activity/README.md)            | One rendering behavior across four transport/response profiles; thread and encrypted wrappers add relation and wire assertions. Real metadata coverage remains separate from scripted rendering. |

Authentication, ownership, locks and cleanup remain in the shared harness contract.
Existing transport entry points and independent recovery runners are retained;
consolidating descriptions must not silently remove assertions or equate graceful
shutdown with crash recovery. Historical verification reports remain under their
support folders rather than becoming top-level behavior tests.
