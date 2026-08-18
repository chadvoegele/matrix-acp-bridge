# Purpose

Verify that the bridge can:

- start in disabled-encryption mode without crypto setup;
- accept an unencrypted Matrix prompt;
- forward the prompt to ACP exactly once;
- return the ACP response as an unencrypted Matrix event; and
- repeat the exchange after a process restart.
