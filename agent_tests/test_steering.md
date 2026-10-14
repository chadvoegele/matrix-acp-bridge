# Steering

Verify that users can select prompt or steering delivery, including `/prompt`
and `/steer` overrides:

- Steering reaches the running turn without waiting behind queued prompts.
- Ordinary prompts remain ordered; steering does not bypass a reset.
- Idle or unsupported steering falls back to a single ordinary prompt, with
  appropriate notices and visible failures.
- Startup and reset do not lose input or require users to resend it.
- Inputs and responses stay in their own room or thread, including encrypted
  conversations; completed inputs are not replayed after restart.
