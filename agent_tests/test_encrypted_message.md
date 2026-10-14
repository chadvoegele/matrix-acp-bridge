# Purpose

Verify that the bridge can:

- restore persistent Matrix Rust crypto state;
- decrypt an encrypted Matrix prompt;
- forward the clear prompt to ACP exactly once;
- return the ACP response as an encrypted Matrix event; and
- repeat the exchange after a normal initial-sync process restart without
  submitting the completed first prompt to ACP again or changing device keys.
