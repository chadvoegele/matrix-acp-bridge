# Autonomous-turn message loss (#34)

This characterization test reproduces a rejected request being silently marked completed. It uses the real bridge, ACP wire client, pi-acp agent/session, and bridge state store. Only Matrix delivery and the pi RPC backend are fakes. It requires no credentials, network, or model calls.

```text
Matrix event -> BridgeCoordinator -> ACP wire client -> timed ACP peer
                                                       |
                                                 real PiAcpAgent
                                                       |
                                                 real PiAcpSession
                                                       |
                                                 fake busy pi RPC
                                                       |
Bridge completed-event ledger <- ACP end_turn <- prompt rejection
```

Install this checkout's dependencies and those of a separate pi-acp checkout, then run:

```sh
export PI_ACP_CHECKOUT=/absolute/path/to/pi-acp
node --import "$PI_ACP_CHECKOUT/node_modules/tsx/dist/loader.mjs" \
  --test agent_tests/test_autonomous_turn/reproduce.mjs
```

The test seeds a thread, starts an autonomous agent turn, and submits another Matrix request. The fake pi backend rejects the prompt using pi's busy-agent error. The real adapter converts that rejection to `end_turn`; the bridge records durable completion without an agent-history entry or a Matrix error. After the autonomous turn ends, a later request succeeds.

**A passing test confirms the bug, not correct behavior.** It is intentionally outside the normal test suite. It proves this failure mechanism, not the exact ordering of the original production event. It does not certify the live Matrix or pi runtime.

Verified against bridge `77bb9a1`, pi-acp main `976f446` (30 consecutive runs), and deployed pi-acp revision `3082765`. The latter's `agent.ts` and `session.ts` hashes match the running container. No production code is changed.
