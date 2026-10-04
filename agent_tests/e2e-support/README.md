# Live test authentication and ownership

All room/thread, plaintext/encrypted shell entry points share this contract.
Use only designated test accounts, joined test rooms and private test state.
`test*.sh` holds `/tmp/matrix-acp-bridge-steering-live.lock` with nonblocking
`flock` across setup, tests and cleanup. Manual operations must hold that same
process-held lock across the entire sequence, including recovery. Do not set
`E2E_LIVE_LOCK_HELD=1` unless the parent holds the lock. This flag lets a serial
controller call shell entry points without taking its own lock twice.

## Persistent cache (default)

With no explicit authentication settings, `cache` mode stores profiles beneath
`$HOME/.local/state/matrix-acp-bridge/test-cache`, outside Git and disposable
worktrees. Override with an absolute `E2E_CACHE_DIR`; repository paths are refused.
`E2E_CACHE_PROFILE=default` selects a named set. A digest of homeserver, room,
transport and response mode isolates plaintext/encrypted room/thread state.
Accounts and roles are bound in each private profile manifest. Change the profile
name when intentionally provisioning a new account set; never copy tokens/stores.

Absent roles log in once using designated `E2E_BRIDGE_PASSWORD` or
`E2E_SENDER_PASSWORD` from trusted private configuration/pass; helper uses the test
bridge password. Tokens/device IDs and crypto remain paired in 0700 directories
with 0600 files. Password bytes are never written. Subsequent runs authenticate
with `whoami` and reuse tokens without password login. Cached devices are reusable,
so automatic cleanup never logs them out or removes their stores.

`profile.json` records credential issuance, public-CLI crypto bootstrap and actual
SAS completion separately. New encrypted devices run the public bootstrap CLI and
compare/confirm real decimal and emoji SAS. Functional reuse validates retained
crypto snapshots/server keys and uses that verified state, without repeating initial
setup. The initialized completed-event ledger is retained across scenarios.

An exclusive `bootstrap.lock` serializes creation; existing per-store leases exclude
active/interrupted runs. HTTP429 retains the same proposed device and a `retryAt`
boundary; invocation before that time is blocked without another login. Retry only
after the legitimate window. Missing passwords report `SETUP BLOCKED`. Uncertain
issuance, malformed/partial manifests, missing tokens, identity/key mismatch or lost
state never silently trigger replacement login/crypto. Preserve the profile and
private evidence; restore its original state or explicitly recover the known issued
device under the live lock. An interrupted crypto bootstrap requires inspection and
public-CLI recovery of the same store, never deletion to simulate first use. Only
remove an interrupted bootstrap lock after confirming its process has stopped.

## Separate setup and functional reports

After `npm ci && npm run check`, source the trusted private test configuration and
run the aggregate serial entry point:

```sh
node agent_tests/e2e-support/live-all.mjs
```

Optional positional case names select cases, for example
`fresh-crypto-setup plaintext-room-normal encrypted-thread-activity`.
`E2E_LIVE_REPORT_DIR` selects a new private evidence directory outside worktrees.
The default is under `$HOME/.local/state/matrix-acp-validation/`. The runner holds
the shared lock, runs a separate disposable fresh public-CLI bootstrap/SAS test,
then cached room/thread normal/activity/steering and plaintext reset, persistence,
completed-ID recovery, real activity and initialized startup/reset tests. Configure
an isolated real ACP command supporting load/delete/steering; real activity also
requires the documented scratch cleanup command. Never point it at production
sessions. Owned fresh devices are revoked; cached devices remain.

Each result has independent `setup`, `function` and `cleanup` fields. A blocked
fresh setup does not stop independent cached/plaintext tests. Exit 0 means all
selected cases passed; 2 means blocked setup/skipped functionality; 1 means failed
setup/function or retained cleanup resources. Inspect private `suite.log` for the
precise cause; logs may contain private identifiers. Do not publish raw evidence.
The runner groups cases by transport/mode and warms dormant profiles through normal
production recovery before strict assertions. Inputs sent by another test mode in
the same room are actually handled and terminally recorded, never hidden by deleting
or replacing a ledger. Warm-up sessions are explicitly tracked/deleted; the ledger
and crypto remain. Failed functional cases require another warm-up before reuse.
Per-case results are durable even if a later case fails. A prior historical pass
never counts as verification of the final code. The existing shell entry points
remain supported for individual scenarios and report their setup errors directly.

The [final persistent-cache verification report](cache-live-verification-report.md)
records the tested revision, separate fresh setup, functional results and cleanup.

## Token mode

Set `E2E_AUTH_MODE=token`. Supplying any role token/device/state variable (even an empty value) also selects token mode
when the mode is unset. Explicit password mode with any configured token fails;
missing/expired/mismatched tokens never fall back to password authentication.
Token mode uses authenticated `GET /account/whoami` and `GET /devices/{deviceId}`
and never calls `/login` (including `m.login.token`). Matrix tokens authenticate
a particular device: they cannot be assigned an arbitrary new device ID.
See the [Matrix authentication specification](https://spec.matrix.org/latest/client-server-api/#relationship-between-access-tokens-and-devices).
We do not assume support for a device-creation API or use admin/production tokens.

For each role export the following (see [`../.env.example`](../.env.example)):

| Role                 | Variables                                                                      |
| -------------------- | ------------------------------------------------------------------------------ |
| Bridge               | `E2E_BRIDGE_ACCESS_TOKEN_FILE`, `E2E_BRIDGE_DEVICE_ID`, `E2E_BRIDGE_STATE_DIR` |
| Sender               | `E2E_SENDER_ACCESS_TOKEN_FILE`, `E2E_SENDER_DEVICE_ID`, `E2E_SENDER_STATE_DIR` |
| Encrypted SAS helper | `E2E_HELPER_ACCESS_TOKEN_FILE`, `E2E_HELPER_DEVICE_ID`, `E2E_HELPER_STATE_DIR` |

Existing user/room/homeserver/ACP variables remain required. Helper is a distinct
device on the test bridge account. Tokens are private regular files (0600), with
private parent directories (0700); state directories are 0700, all owned by the
current user and canonical absolute paths, without symlinks. Retrieve approved
test tokens using `nopass_pass.sh` into a protected file, never console output.
Do not silently add entries to pass or edit the private `.env`.

Supply separate profiles/devices for plaintext/encrypted and room/thread modes.
Each token gets an adjacent `*.e2e-device-binding.json` tying it to its user,
device, role, room, transport, response mode and canonical state directory.
Keep that binding with the token; never copy a used token to bypass it.
Roles use distinct devices and separate stores. Bridge token profiles also
require their initialized `bridge-state.json` with the original completed-event
ledger. First-use baseline establishment belongs to one-time operator provisioning
of a genuinely new test device; used devices require restoration of their original
state. Fresh-start probes requiring absent state use disposable password devices;
initialized restart/recovery probes can use token profiles. Run roots/config/environment files
must be separate from credential/state paths. No global shared crypto store is
used. Do not replace delivery state or the completed-event ledger on a used
device: doing so can replay history even when crypto keys are preserved.
Initialized recovery probes deliberately keep the original profile and ledger.
Use separate profiles for real versus scripted ACP agents, or finish successful
session cleanup before changing agents; failure requires the original ACP
command for recovery.

Encrypted token mode requires the original, already bootstrapped stores for all
three devices (`crypto-state.json` and `matrix-crypto/`). It validates identity,
database and nonempty device-snapshot presence and the manifest's public fingerprints against authenticated
`POST /keys/query`. It never bootstraps fresh crypto on a reusable device.
Restore missing state from its matching protected backup; a token alone is not
enough. Provisioning a new device/store is a separate operator action. Normal
setup still performs actual `m.sas.v1` comparison and confirmation through the
public CLI and helper, and live tests retain encrypted-wire assertions.
An existing SAS flag does not bypass this exchange.

## Cleanup and recovery

Environment records explicitly distinguish `owned` password-created devices
from `reusable` supplied devices before resource creation. Setup refuses to
replace an existing environment or private root. Partial provisioning leaves
issued tokens and the environment for ownership-aware cleanup, including when
a later password login is rate limited. No automatic login retries occur.

Before inspecting persistent state, token mode rejects existing active claims.
Under the shared live lock, token mode claims a per-store `e2e-active-environment.json` with exclusive creation.
An existing claim means an active/interrupted run: recover its referenced private
environment instead of clearing the claim and starting over. Keep evidence and
recovery environments outside disposable worktrees, with directories 0700 and
files 0600. Never run cleanup while clients or bridges still use those stores.

Cleanup first deletes harness ACP sessions (including detached IDs retained by
reset/thread tests). For reusable profiles it then atomically detaches session
mappings through the production state store, preserving initialized status and
completed-event ledgers. This lets another invocation create new ACP sessions
without replaying old inputs or loading deleted sessions. Detached-session lists
are cleared only after deletion succeeds. Crypto databases, manifests, tokens,
device bindings and their parent directories are preserved. Automatic cleanup
NEVER logs out or deletes a reusable device, resets its crypto, or removes its
state directory. Only disposable devices issued by that run are logged out.
The run's generated configs/environment/root and its own store claims are removed
on success. Matrix room events remain.

If session deletion/revocation fails, preserve environment, tokens, lists, store
claims and evidence and retry using the original ACP command. Cleanup fails
closed for missing/unknown ownership. Legacy recovery must first verify that the
old environment was generated by the interrupted test run and every device was
owned by it, then record `privateRoot`, role `ownership = "owned"`, and
`tokenIssued = true` privately before invoking the documented cleanup script.
Never apply that migration to supplied or production credentials. Lost stores
or mismatched keys require operator recovery, not an automatic reset.

## Password compatibility

Legacy password mode is selected explicitly with `E2E_AUTH_MODE=password`. It creates fresh owned
random devices/stores and revokes/removes them on cleanup. Passwords remain
in memory, never the environment record. Each login is attempted once; HTTP429
stops provisioning with retained cleanup evidence. Prefer token mode for repeated
live suites. One-time operator bootstrap may still require a server-supported
login and must respect its rate limits.
