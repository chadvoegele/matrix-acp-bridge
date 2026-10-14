# Thread conversations

Verify that top-level messages start independent agent conversations and that
follow-ups and responses stay in their originating thread, in plaintext and
encrypted rooms.

After restart, only the requested conversation is restored. If the agent cannot
restore sessions, old follow-ups are rejected. Unknown threads never start an
agent conversation. Resetting one thread leaves other conversations unchanged
and keeps subsequent replies in the reset thread.
