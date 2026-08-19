+++
status = "draft"
created = 2026-08-14
last_update = 2026-08-19
+++

# Durable Matrix Rust-crypto storage on Node.js

## Purpose

The bridge uses Matrix's upstream Rust cryptography through `matrix-js-sdk`
and `@matrix-org/matrix-sdk-crypto-wasm`. It does not implement Olm or Megolm.
Because Node.js does not provide the browser IndexedDB API expected by the
WASM crypto store, the bridge must supply `fake-indexeddb` and persist that
in-memory database with a bridge-owned snapshot.

This specification confirms that design as the v0 crypto-storage boundary. It
preserves the Matrix device identity and crypto sessions across ordinary
restarts, fails closed when continuity checks fail, and avoids expanding v0
into a storage-backend project. More durable or maintainable alternatives,
including IndexedDBShim's SQLite-backed IndexedDB implementation, remain
post-v0 work.

## Context

### Upstream cryptography

The TypeScript bridge depends on `matrix-js-sdk`. In required-encryption mode,
the Matrix adapter calls `initRustCrypto()` and uses the SDK's crypto API for
device keys and SAS verification. Ordinary message sends pass clear Matrix
event content to the SDK; the SDK constructs encrypted events.

`matrix-js-sdk` depends on `@matrix-org/matrix-sdk-crypto-wasm`, the Rust
crypto implementation compiled to WebAssembly. The local `crypto-*` modules
own bridge policy and lifecycle, including:

- private state paths and permissions;
- process locking;
- bootstrap and restart continuity;
- the bridge-owned crypto manifest;
- SAS verification orchestration;
- failure classification; and
- shutdown ordering.

They do not implement cryptographic primitives or construct Megolm ciphertext.

### IndexedDB in Node.js

Browsers normally provide IndexedDB as `globalThis.indexedDB`. Node.js does
not. The upstream JavaScript SDK supports a persistent IndexedDB store or an
ephemeral in-memory store. Its documented non-browser fallback,
`useIndexedDB: false`, does not preserve the crypto device across process
restarts and is therefore unsuitable for this daemon.

The native Matrix Rust SDK supports durable native stores such as SQLite, but
that store is not exposed through `matrix-js-sdk`'s Node API. Adopting it
would require a Rust implementation, maintained native binding, or sidecar and
is outside v0.

## Goals

- Use upstream Matrix Rust crypto for all E2EE.
- Preserve the crypto identity, Olm sessions, and Megolm room keys across
  ordinary restarts.
- Restore the crypto store before Rust crypto initialization.
- Keep all crypto state in private files owned by the bridge process.
- Fail closed on missing, corrupt, or identity-mismatched state.
- Provide restart and state-loss test coverage.

## Non-goals

- Implementing Olm or Megolm in the bridge.
- Replacing Matrix SDK encryption with bridge-owned ciphertext construction.
- Moving the bridge to Rust for v0.
- Adopting IndexedDBShim for v0.
- Adding cross-signing, key backup, or secret-storage management beyond
  existing scope.
- Guaranteeing preservation of every crypto update across abrupt power loss.

## Specification

### v0 design

The bridge:

1. creates a private crypto state directory;
2. installs `fake-indexeddb` before Rust crypto initialization;
3. restores the bridge-owned IndexedDB snapshot into memory;
4. calls `initRustCrypto()` with a stable database prefix;
5. captures matching IndexedDB databases after completed transactions;
6. serializes the snapshot with Node's V8 serializer;
7. writes a mode-`0600` temporary file and atomically renames it to
   `.indexeddb.snapshot`; and
8. stops the Matrix client before awaiting a final snapshot flush on shutdown.

The snapshot records database names and versions, object-store schemas,
indexes, keys, values, and key-generator state. It therefore preserves the
opaque SDK-owned Rust crypto database rather than selected bridge-defined
fields.

A separate `crypto-state.json` manifest records the expected homeserver,
Matrix user and device IDs, public-key fingerprints, bootstrap state, and SAS
attestation. The bridge validates this manifest against the restored SDK
identity and fails closed on missing or replaced state. The manifest is not an
Olm/Megolm store.

### Restart behavior

A successfully written snapshot preserves the Rust crypto store as of that
snapshot, including the local crypto identity and the SDK's Olm/Megolm
sessions, room keys, device information, and related crypto metadata.

The guarantee is limited to the last completed snapshot. A process or host
crash can lose newer in-memory changes. A damaged snapshot can make
restoration fail. These are accepted v0 limitations; the bridge must not
silently create a replacement identity under an established manifest.

### Accepted v0 limitations

- A crash may lose crypto updates newer than the last completed snapshot.
- The snapshot has no generation history or checksum envelope.
- Recovery from snapshot corruption is operational rather than automatic.
- Snapshot compatibility depends on Node's V8 serialization format and the
  pinned runtime policy.
- Snapshot capture relies on `fake-indexeddb` implementation details.
- The SDK crypto database is protected by filesystem permissions but is not
  encrypted at rest.
- Cold backup and restore must treat the crypto database and bridge manifest
  as one unit.

These limitations must not weaken the fail-closed rule: absent, corrupt, or
identity-mismatched state must never trigger automatic replacement of an
established Matrix crypto device.

## Rationale

The current `fake-indexeddb` plus atomic snapshot implementation already
provides every required v0 property, listed in the goals. V0 does not require
every durability guarantee. SQLite generations, checksums, migration tooling,
periodic doctor checks, and stronger power-loss behavior are useful
operational improvements but do not justify changing a working and tested
crypto-storage boundary before v0.

## Alternatives considered

### OpenClaw comparison

OpenClaw uses the same fundamental stack for Matrix E2EE:

`matrix-js-sdk` Rust-crypto WASM -> fake IndexedDB -> custom snapshot
persistence

It does not use `@matrix-org/matrix-sdk-crypto-nodejs` as a native SQLite
Olm/Megolm store. That package is used for encrypted media operations.

OpenClaw persists its fake-IndexedDB snapshot in SQLite plugin state and adds
mature operational features:

- account-scoped database names;
- restore before `initRustCrypto()`;
- immediate, periodic, and shutdown snapshots;
- cross-process advisory locking;
- chunked snapshot storage;
- generation-based publication with metadata written last;
- SHA-256 integrity checks; and
- migration and doctor tooling.

These features improve corruption detection, interrupted-write recovery,
multi-process coordination, migration, and diagnostics. They do not remove
the IndexedDB compatibility layer.

The bridge already has stronger fail-closed identity continuity and explicit
manifest durability. Its single-process lock also reduces the need for
OpenClaw's cross-process snapshot coordination.

### IndexedDBShim

[IndexedDBShim](https://github.com/indexeddbshim/IndexedDBShim) is a
maintained third-party IndexedDB implementation that maps IndexedDB operations
to SQLite through a WebSQL compatibility layer. It is not an upstream Matrix
component.

If compatible with Matrix Rust crypto, it could provide transaction-level
durable writes and remove:

- `fake-indexeddb`;
- snapshot capture and restoration;
- shutdown snapshot flushing; and
- reliance on `fake-indexeddb` private internals.

Potential benefits:

- SQLite owns transaction durability.
- Crypto updates need not wait for a periodic or shutdown snapshot.
- The bridge no longer interprets `fake-indexeddb` internals.
- Storage behavior is delegated to a maintained IndexedDB implementation.

Risks and costs:

- It introduces native `better-sqlite3` installation and platform-build
  requirements.
- Its dependency tree is substantially larger than `fake-indexeddb` and
  currently includes `canvas`.
- It documents IndexedDB timing and cross-process limitations.
- Its structured-clone storage encoding has had breaking changes without
  migration paths.
- It is not tested, supported, or endorsed by Matrix for
  `matrix-sdk-crypto-wasm`.
- IndexedDB transaction timing and cloning semantics must match the Rust
  crypto store's expectations.
- IndexedDBShim 17.1.0 requires Node `^22.18.0 || >=24.11.0`, while the
  bridge currently permits earlier Node 22 releases.
- Adopting it would require migration or explicit recovery behavior for
  existing `.indexeddb.snapshot` state.

IndexedDBShim is therefore a plausible post-v0 replacement, not a drop-in v0
dependency.

## Verification

- Restart tests show the device identity, Olm sessions, and Megolm room keys
  survive an ordinary restart and that encrypted history remains readable.
- State-loss tests show missing, corrupt, or identity-mismatched snapshot and
  manifest state fail closed without creating a replacement identity.
- Snapshot tests show atomic replacement, mode-`0600` files, and final
  shutdown flushing.

A post-v0 storage evaluation should compare at least:

1. the current snapshot implementation with integrity and generation
   enhancements;
2. OpenClaw-style chunked SQLite snapshot storage;
3. IndexedDBShim backed by SQLite; and
4. a maintained native Rust SDK binding or sidecar.

An IndexedDBShim spike must use the real pinned Matrix SDK and verify:

- first bootstrap and device-key stability;
- clean and forced restart continuity;
- inbound and outbound encrypted messages;
- persisted Olm sessions and Megolm room keys;
- SAS verification continuity;
- encrypted history after restart;
- transaction abort and process-crash behavior;
- database corruption detection;
- dependency and Node upgrades;
- backup and restore;
- single- and multi-process access behavior; and
- migration from the v0 snapshot format.

No backend should replace the v0 implementation until these tests pass and
recovery behavior is documented.

## Possible incremental improvements

The following changes can be considered independently after v0:

- add a versioned snapshot envelope and checksum;
- retain one previous valid snapshot generation;
- expose safe snapshot age and integrity diagnostics;
- add doctor-assisted validation and migration;
- avoid private `fake-indexeddb` internals where public enumeration is
  sufficient;
- define an explicit runtime-upgrade compatibility policy; and
- evaluate SDK store encryption options for deployments requiring encryption
  at rest.
