# Codemode ACP fixture

`codemode-acp.ts` contains tool notifications captured from a real, isolated
Pi 1.0.0 codemode execution through the local Chad Pi ACP fork on November 6, 2026. A deterministic localhost OpenAI-compatible endpoint supplied the harmless
`codemode` call; Pi executed it in its sandbox and the adapter emitted the ACP
notifications. No external model, MCP server, Matrix room or production session
was used. Only tool notifications were retained and the session ID was replaced.

The local adapter checkout was clean at
`976f446595da1a2f5ef54d33b791f1ec1e80bf33`; its existing bundle SHA-256 was
`997a3a8d8ae9dbfe890eab66d15588a91823001594f7ff1b14f4a44ec1a366cb`.
That identifies the exercised artifact; it does not prove the bundle was built
from that source revision or identify the deployed remote adapter.

The fixture verifies exact `title: "codemode"`, `kind: "other"`, object
`rawInput.code`, running updates and a completion that omits input. Results are
separate ACP content, not a source fallback. Tests derive malformed/large inputs
and failure updates from this observed shape; those variants were not captured.

Capture used a temporary HOME, agent directory, session directory and workspace.
The Pi wrapper enabled only `builtin:codemode`, disabled extension/skill/context
and prompt-template discovery, and used offline startup. The script called no
nested tools. Its two localhost model requests emitted the call and final text.

Live Matrix validation remains unverified. The canonical ignored test environment
points at a remote Docker/socket adapter; its isolation and artifact provenance
were not established, and real-activity scratch/cleanup settings were absent.
No shared adapter was restarted or changed and no Matrix test messages were sent.
Normalizer/model/renderer tests and bridge tests with a fake Matrix adapter cover
source retention and replacement message budgets separately from live validation.
