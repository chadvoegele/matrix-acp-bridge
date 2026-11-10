export const overflowCases = ["plaintext", "encrypted"].map((transport) => ({
  name: `${transport}-thread-overflow`,
  transport,
  mode: "thread",
  prefix: "test_thread_sessions",
  runner: "../test_outbound_overflow/run.mjs",
  scriptedPeer: "agent_tests/test_outbound_overflow/peer.mjs",
  selectionOnly: true,
}));
