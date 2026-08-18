# Purpose

Verify that the bridge can:

- restore persistent Matrix Rust crypto state;
- decrypt an encrypted Matrix prompt;
- forward the clear prompt to ACP exactly once;
- return the ACP response as an encrypted Matrix event; and
- repeat the exchange after a process restart without changing device keys.
