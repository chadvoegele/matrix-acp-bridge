+++
status = "final"
created = 2026-08-09
last_update = 2026-08-12
+++

# Milestone 3 — minimum required E2EE

Status: accepted (2026-08-04)

This document defines the minimum accepted Milestone 3 needed to run the bridge
in end-to-end encrypted Matrix rooms. It supersedes the Milestone 3 and E2EE
sections of [m1-plaintext-matrix.md](m1-plaintext-matrix.md).

Milestone 3 builds on the reduced Milestone 2 in [m2-persistence.md](m2-persistence.md), not the older
durable-inbox design still described in `m1-plaintext-matrix.md`. Its restart and delivery
semantics remain best effort.

## Goal

Add one strict encrypted mode that:

- persists the Matrix Rust crypto identity beneath `state_dir`;
- receives only successfully decrypted messages from encrypted configured
  rooms;
- sends encrypted responses through `matrix-js-sdk`;
- restores the same cryptographic device after restart; and
- fails closed rather than silently replacing a missing device identity or
  falling back to plaintext.

This milestone is deliberately not a general Matrix key-management tool.

## Reduced scope

Milestone 3 includes:

- `matrix.encryption = "required"`;
- the Node Rust crypto backend supplied by the pinned `matrix-js-sdk`;
- a persistent local crypto database;
- a small manifest binding that database to the configured Matrix identity and
  device public-key fingerprints;
- a first-use `crypto bootstrap` command;
- manual SAS verification with one existing trusted device;
- encrypted send, receive, restart, and bounded offline catch-up; and
- explicit backup and loss-recovery documentation.

Milestone 3 does **not** include:

- QR verification;
- creating, resetting, importing, exporting, caching, or otherwise managing
  cross-signing private keys;
- secret storage, key backup, recovery keys, dehydrated devices, or operator
  commands for historical key import/export;
- Matrix passwords or UIA;
- verification of every sender or recipient device;
- per-room encryption modes or plaintext fallback; or
- stronger delivery guarantees than Milestone 2.

An existing trusted client may cross-sign the bridge device as a consequence
of its own verification behavior. The bridge neither requires access to those
cross-signing private keys nor invokes cross-signing management APIs.

## Configuration and modes

The only encryption values are `"disabled"` and `"required"`.

- `disabled` retains Milestone-2 behavior. Rust crypto is not initialized, and
  every configured room must be unencrypted.
- `required` enables this milestone. Rust crypto must initialize successfully,
  and every configured room must be encrypted.

There is no mixed mode. A configured-room mismatch is a startup failure. A
runtime encryption-state change that violates the configured mode is fatal.
Room encryption is normally irreversible, but the bridge still validates the
observed state rather than relying on that property.

No new TOML keys are required. The configured homeserver, user ID, device ID,
access-token file, and private `state_dir` remain the identity and storage
inputs.

## Local crypto state

Required mode reserves these paths beneath `state_dir`:

```text
<state_dir>/matrix-crypto/       SDK-owned Rust crypto database files
<state_dir>/crypto-state.json    bridge-owned crypto manifest
```

The exact files beneath `matrix-crypto` are owned by the pinned Matrix SDK and
must not be interpreted or edited by bridge code. The bridge passes a stable
path or database prefix rooted there whenever it initializes Rust crypto.

The existing process-lifetime `state_dir/.lock` also excludes concurrent
bootstrap, verification, daemon, backup, and recovery operations. All crypto
commands acquire it before opening the database. They fail if another bridge
process owns it.

The state directory remains mode `0700`. Bridge-created files use mode `0600`
and directories use mode `0700`. Before use, bridge-owned paths and existing
SDK database paths must be beneath `state_dir`, must not traverse symlinks, and
must be owned by the service user without group or world permissions. Run Rust
crypto initialization under a private file-creation mask. Failure to establish
or validate private storage is fatal.

The SDK database is not additionally encrypted with a passphrase in M3. The
service account, filesystem permissions, host protection, and protected backup
are the storage boundary. Adding another encryption secret is deferred.

### Crypto manifest

`crypto-state.json` is strict, versioned, and atomically replaced using the
same private-file, file-fsync, rename, and directory-fsync rules as
`bridge-state.json`. It contains only:

- schema version;
- homeserver URL;
- verified Matrix user ID;
- verified Matrix device ID;
- the device's public Ed25519 key fingerprint;
- the device's public Curve25519 key fingerprint;
- whether bootstrap completed; and
- whether this exact key fingerprint completed the bridge's SAS verification
  flow.

It contains no access token, private key, room key, SAS data, or verification
transcript.

After every Rust crypto restoration, obtain the current device public keys
from the SDK and compare them with the manifest. Missing, malformed,
incompatible, identity-mismatched, or fingerprint-mismatched state fails
closed with metadata-only recovery guidance.

Normal required-mode startup never creates a missing manifest or a missing
crypto database. This prevents accidental replacement of an established
Matrix device's cryptographic identity. An interrupted bootstrap may be
resumed only by `crypto bootstrap`, never by normal daemon startup.

## Command line

The accepted forms are:

```text
matrix-acp-bridge --config <config-file>
matrix-acp-bridge --config <config-file> crypto bootstrap
matrix-acp-bridge --config <config-file> crypto verify --device <device-id>
```

Unknown commands, reordered arguments, missing values, and additional values
are errors. Crypto commands require `matrix.encryption = "required"`. They
parse and validate the ordinary configuration, token, private paths, and state
lock, but do not initialize ACP.

Interactive input and verification output use a separately opened `/dev/tty`.
They never read ACP stdin or write ACP stdout. Failure to open `/dev/tty`, tty
EOF, rejection, cancellation, timeout, or a second termination signal fails
the command without marking verification complete. Metadata-only diagnostics
may still use stderr.

A first SIGINT or SIGTERM cancels an active Matrix verification, stops Matrix,
closes the crypto store, releases the lock, and exits nonzero. A second signal
exits immediately with the conventional signal exit code.

The existing `startup_timeout_seconds` bounds bootstrap startup and each
verification attempt, including Matrix readiness and operator interaction. A
successful one-shot command stops Matrix, closes storage, releases the lock,
and exits zero.

## Bootstrap command

`crypto bootstrap` prepares crypto for the Matrix device already represented
by the configured access token. It does not create a Matrix login or choose a
new device ID.

The command:

1. validates configuration and acquires `state_dir/.lock`;
2. creates `matrix-crypto` privately when absent;
3. creates the Matrix client with the configured homeserver, user ID, device
   ID, and access token;
4. initializes the Node Rust crypto backend before sync;
5. calls `whoami` and requires the configured user and device IDs;
6. starts sync with event intake disabled and waits for Matrix readiness;
7. waits for the SDK to publish the current device keys;
8. obtains the device's public Ed25519 and Curve25519 keys;
9. atomically records the completed manifest with SAS verification false; and
10. cleanly stops and exits.

If a completed manifest exists and its identity and fingerprints match, the
command reports that bootstrap is already complete and exits successfully. It
must not rotate keys.

If the database exists without a completed manifest, bootstrap may resume only
when Rust crypto can open it and expose a stable current-device identity. It
then completes publication and writes the manifest. If a manifest exists but
the database is absent or exposes different keys, bootstrap fails with
recovery guidance. It never creates replacement keys under an established
manifest.

Bootstrap does not create or reset cross-signing, secret storage, or key
backup.

## SAS verification command

`crypto verify --device <device-id>` performs SAS verification with one
existing trusted device owned by the configured Matrix user. The target device
ID is explicit, must differ from the bridge device ID, and is not persisted as
an authorization rule.

The command requires a completed, matching bootstrap manifest. It initializes
and restores Rust crypto, verifies `whoami`, starts Matrix sync with ordinary
room-event intake disabled, and requests a to-device SAS verification with
exactly the specified device. It never accepts an independently initiated
verification request.

The command:

1. rejects verification traffic from another user or device;
2. offers only the Matrix SAS method supported by the pinned SDK;
3. displays the protocol-provided emoji and decimal SAS on `/dev/tty`;
4. identifies the configured local and target device IDs;
5. asks the local operator to confirm that the SAS matches the trusted client;
6. confirms through the SDK only after an explicit local `yes`;
7. treats every other answer as rejection and cancels the request;
8. waits for successful protocol completion; and
9. atomically sets the manifest's SAS-verified flag only after completion and
   after reconfirming the local public-key fingerprints.

A verification command does not mark another device with an SDK bypass such as
`setDeviceVerified` merely to force success. It completes the interactive SAS
protocol. It does not invoke cross-signing bootstrap, reset, import, export,
secret-storage, or key-backup APIs.

Normal required-mode daemon startup requires the matching manifest's
SAS-verified flag. This flag attests that this exact local device-key pair
completed the bridge's manual SAS flow. M3 does not require the bridge to own
or restore the account's cross-signing private keys.

Re-running verification is allowed and replaces only the boolean attestation
after another successful flow.

## Required-mode daemon startup

After configuration validation and lock acquisition, required-mode startup is:

1. require a completed and SAS-verified crypto manifest and an existing crypto
   database;
2. create the Matrix client and initialize Rust crypto from the stable database
   path before sync;
3. call `whoami` and require the configured user and device IDs;
4. compare the restored device public keys with the manifest;
5. register listeners with bridge intake and ACP dispatch closed;
6. start the SDK's normal initial sync with the configured timeline limit;
7. perform ordinary first-run suppression or bounded completed-ID recovery;
8. query current configured-room membership and encryption state;
9. require every configured room to be joined and encrypted; and
10. open intake and ACP dispatch using the existing M2 ordering.

Crypto initialization, manifest validation, identity validation, initial Matrix
readiness, and room validation are all covered by
`startup_timeout_seconds`. Failure closes Matrix and ACP, flushes accepted M2
state where applicable, releases the lock, and exits 1.

Disabled-mode startup remains unchanged and does not require crypto state.

## Encrypted inbound events

The Matrix adapter distinguishes:

- whether the wire event was `m.room.encrypted`; and
- whether the SDK successfully produced authenticated clear type and content.

In required mode, an event is eligible for ordinary authorization only when it
was encrypted on the wire and was successfully decrypted by the SDK. Policy
then evaluates the decrypted event type, content, sender, room ID, event ID,
redaction state, relation, body, and size using the existing M1/M2 rules.

A plaintext `m.room.message` received in required mode is rejected even if it
appears in an encrypted room. An encrypted event received in disabled mode is
rejected. Ciphertext, encrypted content fields, decryption errors, and raw
crypto errors are never passed to authorization, ACP, user-facing responses,
or logs.

The Matrix adapter emits each successfully decrypted event to the bridge at
most once. It must not place an event in the bridge's processed-event FIFO
merely because ciphertext was observed; doing so would suppress a later
successful decryption. It may maintain a separate bounded in-memory registry
of encrypted events awaiting or completing decryption.

### Late decryption and catch-up

M3 retains M2's best-effort completed-ID contract:

- the SDK may advance its in-process sync position while an encrypted event
  remains undecryptable;
- while the process remains alive, a live event that later decrypts
  successfully may be admitted once under the normal policy and queue limits;
- a restart may lose such an unresolved event after it was absent from the
  completed-ID ledger;
  and
- no ciphertext or pending-decryption record is persisted by bridge code.

For the first initialized initial-sync response, only events successfully
decrypted by the time that batch is classified are candidates for M2's age and
newest-event admission selection. An unresolved event is omitted, receives no
busy or error response, and is not admitted if it decrypts after startup
selection closes. Emit a metadata-only omission diagnostic. This preserves the
bounded recovery contract without retaining message ciphertext or extending
startup indefinitely.

First-run history remains suppressed whether it is plaintext, ciphertext, or
successfully decrypted during initial sync.

A decryption failure diagnostic may contain timestamp, room ID, sender MXID,
event ID, catch-up/live classification, and a stable bridge-defined reason. It
must not contain ciphertext, clear content, session keys, device keys, key IDs,
verification data, SDK error text, or request details. Repeated diagnostics use
the existing per-room/reason rate limiter. A later successful live decryption
may still be processed once.

## Outbound encryption

In required mode, all existing response kinds, transaction IDs, multipart
rules, room mutexes, retries, and M2 ephemeral operations are unchanged. The
Matrix adapter sends through the initialized SDK in a room already validated as
encrypted and lets the SDK construct `m.room.encrypted` wire events.

The bridge never manually constructs Megolm ciphertext and never falls back to
sending `m.room.message` plaintext after an encryption failure. Crypto or send
failures use the existing Matrix transient/permanent classification where the
SDK provides a safe classification. An inability to encrypt because crypto is
uninitialized, corrupt, or identity-mismatched is fatal.

M3 adds no policy requiring every sender or recipient device to be verified.
Authorization remains based on the authenticated room ID and sender MXID after
successful decryption. Recipient-device selection and room-key sharing use the
pinned SDK's default Rust crypto behavior. The bridge does not disable
encryption merely because another room member has an unknown or unverified
device.

Typing indicators and read receipts remain Matrix ephemeral events and retain
M2 behavior; they are not application-message plaintext fallback.

## Shutdown

Graceful daemon shutdown follows M2. Stop Matrix event intake before cancelling
turns. Stop Matrix sync and close Rust crypto before releasing the state lock.
The crypto database and manifest are never deleted during shutdown.

The existing shutdown grace deadline includes Matrix and crypto closure. A
forced shutdown may leave SDK-managed transactional files, which the Rust
backend must recover or reject on the next open.

## Backup and loss recovery

A protected backup is a cold backup. Stop the daemon and all crypto commands,
then copy together:

- `matrix-crypto`;
- `crypto-state.json`;
- `bridge-state.json`, when present; and
- the separately protected access-token file if it is needed for complete host
  recovery.

Protect the backup at least as strongly as `state_dir`. Restoring only some
crypto database files, combining files from different backups, or restoring a
manifest without its matching database is unsupported. After restore, startup
must still verify Matrix identity and public-key fingerprints.

If the crypto database is lost, first restore a matching cold backup. If none
exists, M3 does not recreate crypto automatically under the old manifest or
configured device ID. Explicit recovery is:

1. stop the bridge;
2. preserve the failed state for investigation;
3. revoke the lost Matrix device/access token using a trusted Matrix client;
4. provision a new dedicated Matrix device and access token with a new stable
   device ID;
5. configure a new empty `state_dir` or explicitly archive the old state;
6. run `crypto bootstrap` and SAS verification; and
7. restart the daemon.

Old messages whose room keys existed only in the lost store may remain
undecryptable. After the replacement device is SAS-verified, another client for
the same account may satisfy ordinary Matrix room-key requests for sessions it
still holds. The bridge permits this SDK-managed key forwarding, but does not
initiate a bulk transfer, guarantee recovery, paginate or replay old history,
or forward recovered historical messages to ACP. M3 provides no key import or
backup recovery command.

## Verification

Unit tests must cover:

- strict parsing of both encryption modes and exact crypto command forms;
- disabled-mode compatibility and required-mode crypto gating;
- private crypto paths, lock exclusion, manifest schema, atomic writes, and
  identity/fingerprint mismatch;
- bootstrap creation, interrupted-bootstrap resume, idempotent bootstrap, and
  refusal to replace missing or mismatched established state;
- SAS target filtering, display, explicit confirmation, rejection, timeout,
  cancellation, successful attestation, and no cross-signing management calls;
- required-mode startup ordering, missing store, unverified manifest,
  successful restoration, and changed device keys;
- transport-plaintext rejection in required mode;
- ciphertext suppression, successful clear-content normalization, one-time
  late decryption, and metadata-only undecryptable diagnostics;
- first-sync suppression and bounded catch-up selection with encrypted events;
- encrypted outbound sends with no plaintext fallback; and
- clean and forced crypto shutdown.

Hermetic integration tests must prove:

1. bootstrap persists one stable local crypto identity;
2. SAS verification marks only that identity as verified;
3. a live encrypted message is decrypted, sent once to ACP, and receives an
   encrypted Matrix response;
4. a short restart restores the same device and processes a decryptable bounded
   offline event;
5. first-sync encrypted history is suppressed;
6. plaintext configured rooms fail required-mode startup;
7. transport-plaintext messages are rejected in required mode;
8. an undecryptable event is never forwarded and produces no plaintext reply;
9. an unverified manifest fails daemon startup;
10. a verified-device restart preserves key fingerprints; and
11. missing or replaced crypto state fails closed without generating a new
    identity.

Tests must use hermetic Matrix and crypto boundaries. A manual homeserver test
may supplement them but is not required for the automated suite.

## Acceptance boundary

M3 is complete when the bridge can be bootstrapped and SAS-verified once, can
restart with the same Rust crypto identity, and can exchange ordinary bridge
messages only as encrypted room events without plaintext fallback.

QR, bridge-managed cross-signing keys, secret storage, key backup, recovery-key
handling, historical key import, and stronger crash delivery are later work.
