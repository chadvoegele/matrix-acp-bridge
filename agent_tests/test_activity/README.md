# Activity runners

Follow the shared [authentication and cleanup contract](../e2e-support/README.md).

Run the deterministic activity peer across all four profiles:

```sh
agent_tests/test_unencrypted_message/test-activity.sh
agent_tests/test_encrypted_message/test-activity.sh
agent_tests/test_thread_sessions/plaintext-test-activity.sh
agent_tests/test_thread_sessions/encrypted-test-activity.sh
```

The [plaintext harness](../test_unencrypted_message/README.md#verbose-acp-activity-over-plaintext-matrix)
details HTML/fallback formatting, truncation, rollover, eager text and archived
updates. [Thread assertions](../test_thread_sessions/README.md#scripted-activity)
check roots and fallback targets on originals and replacement `m.new_content`.
Encrypted runners check authenticated decrypted content and encrypted wire types.

For configured-agent metadata rather than deterministic rendering, use
`agent_tests/test_unencrypted_message/test-real-activity.sh`; configure its scratch cleanup
as documented in the plaintext harness. Missing agent fields are reported as
incomplete coverage, not a scripted-test failure or a full real-agent pass.
