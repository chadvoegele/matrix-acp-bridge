`agent_tests` are end-to-end tests run by the agent. Choose no bugs.

Before live tests, read the complete [shared setup contract](e2e-support/README.md),
including the configured Pi fork artifact and message/thought ID preflight.
Complete that preflight before the long aggregate suite; scripted peers do not
certify the configured real adapter.

Top-level test_${name}.md files describe application behavior. These are for humans; keep prose concise, assume audience is familiar with messaging clients and matrix specifications, and permit ambiguitiy at a techincal level.

Sub-folders contain whatever you need to run the tests. Be as techical as you want.
