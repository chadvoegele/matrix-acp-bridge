# Purpose

Verify that the bridge in thread-response mode can:

- give concurrent top-level Matrix messages independent ACP sessions;
- keep follow-ups and responses in their originating thread;
- lazily restore only the requested thread after restart when ACP supports
  session loading, or reject old follow-ups without forwarding them to ACP;
- handle `/reset` in one thread without changing another thread's session,
  retaining the reset thread's identity across restart and creating a fresh
  session for its next prompt when session loading is supported;
- reject unknown thread follow-ups without creating, loading, or prompting an
  ACP session;
- reuse one ACP session for an encrypted root and follow-up, verifying thread
  relations in authenticated decrypted content and encrypted wire events; and
- preserve thread routing on text, thought/tool activity, and replacement edits
  in both plaintext and encrypted scripted activity tests.
