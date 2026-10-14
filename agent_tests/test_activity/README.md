# Activity runners

Follow the shared [authentication and cleanup contract](../e2e-support/README.md).

Run the deterministic activity peer across all four profiles:

```sh
agent_tests/unencrypted-e2e/test-activity.sh
agent_tests/encrypted-e2e/test-activity.sh
agent_tests/thread-sessions/plaintext-test-activity.sh
agent_tests/thread-sessions/encrypted-test-activity.sh
```

The [plaintext harness](../unencrypted-e2e/README.md#verbose-acp-activity-over-plaintext-matrix)
details HTML/fallback formatting, truncation, rollover, eager text and archived
updates. [Thread assertions](../thread-sessions/README.md#scripted-activity)
check roots and fallback targets on originals and replacement `m.new_content`.
Encrypted runners check authenticated decrypted content and encrypted wire types.

For configured-agent metadata rather than deterministic rendering, use
`agent_tests/unencrypted-e2e/test-real-activity.sh`; configure its scratch cleanup
as documented in the plaintext harness. Missing agent fields are reported as
incomplete coverage, not a scripted-test failure or a full real-agent pass.
