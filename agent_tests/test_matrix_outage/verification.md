# HTTP outage verification

Tested against main base `208cfd9`, with the production changes and harness in
this PR, on Node 24 and matrix-js-sdk 42.2.0.

## Findings

A default-factory regression using the actual pinned SDK established that a
30-second HTTP timeout aborts a pre-header stalled send and exposes a retryable
failure. **Timeout alone was insufficient:** calling SDK `sendMessage` again with
the original transaction failed with `addPendingEvent called on an event with
known txnId`. The SDK retains rejected local echoes. The factory now uses the
SDK's `resendEvent` only for an existing `NOT_SENT` event, retaining its transaction
and encrypted event rather than registering another local echo.

## Results

- `npm run check`: 530 tests passed, zero failures/skips; formatting, lint and
  typecheck passed.
- Two independent live encrypted **thread-mode** runs used designated cached test
  devices and their original crypto and completed-event ledgers. Local deterministic
  ACP emitted live activity and final responses; no real agent/model was used.
- Each run completed a healthy exchange, a second exchange interrupted by a
  60-second test-bridge HTTP blackhole, and a subsequent same-room exchange without
  restarting the bridge. Different thread roots exercised the shared room lock.
- Final run: two stalled send attempts rejected after **30,002 ms and 30,004 ms**.
  Both retried with the original transaction identity and eventually succeeded.
- All three prompt/response pairs were `m.room.encrypted` on the wire and decrypted
  successfully, with one matching response and one ACP submission per prompt.
  Existing thread-routing assertions passed. No overlapping outbound HTTP sends.
- Setup, functionality and ownership-aware cleanup all exited 0 on both runs.
  Reusable test devices, tokens, crypto and delivery ledgers were preserved; local
  scripted session mappings were detached. No production service was interrupted.

Private logs remain outside Git/worktrees; no raw credentials, identities, room
IDs or event IDs are included here.

## Limits

This verifies recovery from dropped requests before response headers. It does not
reproduce the exact original incident or prove that every encryption prerequisite
or response-body stall recovers. SDK per-request timeout overrides remain intact.
No queue reset, overlapping replacement send, process restart, new persistence
layer or crash-safe outbox was added. Issue #25's broader cause remains unproven.
