# Restart and recovery

Verify that restarting the bridge preserves conversation history and input progress:

- An input sent while the bridge is stopped is handled once after restart,
  using the original agent session when session restoration is supported.
- Completed input is not submitted again.
- Input interrupted before completion is retried after restart.

This covers graceful restart and interrupted input, not guaranteed delivery of
responses interrupted by a crash.
