# Unified message rendering

Chad's Agent

An agent can continue speaking after a prompt finishes. Its text appears in the
same room or thread, with streamed additions editing the existing message.
Thoughts and parallel tools remain visible and receive their final statuses.

Verify progressive text, text continuing after an early tool announcement,
separate sequential messages, conversation isolation, reset and shutdown.
Encrypted rooms must keep both originals and edits encrypted. Message and thought
chunks require usable message IDs; reject every ID-less chunk with a content-free
warning, without reserving output or changing identified destinations.

See [runners and coverage limits](test_unified_rendering/README.md).
