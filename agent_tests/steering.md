# Purpose

Verify that the bridge can:

- select prompt or steering delivery through `matrix.default_message_delivery`,
  with `/prompt` and `/steer` overriding the default;
- inject steering into a running turn through the advertised ACP extension,
  silently completing the steering event independently of the original prompt;
- preserve one running prompt per conversation and prompt FIFO ordering while
  a bounded serial steering lane bypasses waiting prompts but not reset barriers;
- convert idle steering, including ACP `promptRequired` responses, into exactly
  one tracked prompt whose completion follows the `session/prompt` promise;
- show idle-fallback notices only for explicit `/steer`, while keeping
  unsupported-agent fallback notices and errors visible for either selection;
- preserve explicit/default selection through startup, session setup, catch-up,
  and reset, without requiring users to resend input;
- isolate steering and responses by conversation in room and thread modes,
  including authenticated encrypted content and encrypted wire events;
- retain completed input across restart without replaying it, and avoid automatic
  redelivery after ambiguous steering failures; and
- preserve authorization, input limits, cancellation, timeout, and bounded
  shutdown behavior without extra prompt collectors or timer resets.
