# Outbound overflow

When an agent produces output faster than Matrix can accept it, accepted messages
drain and excess messages are dropped. A capacity notice appears in the affected
thread without flooding the conversation. Fresh output resumes when capacity is
available; another thread remains correctly routed without a restart or cancellation.

Check plaintext and encrypted delivery with two threads in one room. Encrypted
output, including the notice, must remain encrypted.

See [runners and coverage boundaries](test_outbound_overflow/harness.md).
