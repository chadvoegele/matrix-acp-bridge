# Message exchange

Verify plaintext and encrypted room conversations:

- A prompt reaches the agent once and its response returns to Matrix.
- Plaintext responses preserve Markdown formatting.
- Encrypted prompts and responses stay encrypted on the wire, with no plaintext fallback.
- After restart, another exchange succeeds without replaying completed input;
  encrypted devices retain their keys.
