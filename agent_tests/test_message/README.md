# Message exchange runners

Use the [plaintext procedure](../test_unencrypted_message/README.md) and
[encrypted procedure](../test_encrypted_message/README.md) for the two variants
of [message exchange](../test_message.md). Their separate technical instructions
retain the crypto bootstrap/SAS and wire assertions needed only for encryption.

```sh
agent_tests/unencrypted-e2e/test.sh
agent_tests/encrypted-e2e/test.sh
```

Both include a restart smoke check. Stronger retained-context and interrupted-input
assertions belong to [restart and recovery](../test_restart_persistence/README.md).
Thread-specific session lifecycle belongs to [thread sessions](../thread-sessions/README.md);
activity rendering belongs to [activity](../test_activity/README.md).
