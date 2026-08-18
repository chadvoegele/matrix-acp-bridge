import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CRYPTO_MANIFEST_FILE,
  CRYPTO_MANIFEST_SCHEMA_VERSION,
} from "./crypto-runtime.js";
import { acquireStateLock } from "./config.js";
import {
  CryptoStateError,
  ensureCryptoDatabaseDirectory,
  openCryptoStateStore,
} from "./crypto-state.js";

const identity = {
  homeserver: "https://matrix.example",
  userId: "@bridge:example",
  deviceId: "BRIDGEDEVICE",
} as const;

const fingerprints = {
  ed25519Fingerprint: "ed25519:fingerprint",
  curve25519Fingerprint: "curve25519:fingerprint",
} as const;

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: CRYPTO_MANIFEST_SCHEMA_VERSION,
    ...identity,
    ...fingerprints,
    bootstrapCompleted: true,
    sasVerified: false,
    ...overrides,
  };
}

async function makeStateDir(): Promise<string> {
  const stateDir = await mkdtemp(join(tmpdir(), "matrix-acp-crypto-"));
  await chmod(stateDir, 0o700);
  return stateDir;
}

async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await makeStateDir();
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function writeRawManifest(stateDir: string, value: unknown): Promise<void> {
  const path = join(stateDir, CRYPTO_MANIFEST_FILE);
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  await chmod(path, 0o600);
}

async function expectCryptoError(
  action: () => Promise<unknown>,
  category: CryptoStateError["category"],
): Promise<CryptoStateError> {
  let rejected: unknown;
  await assert.rejects(action, (error: unknown) => {
    rejected = error;
    assert.ok(error instanceof CryptoStateError, `expected CryptoStateError, got ${String(error)}`);
    assert.equal(error.category, category);
    assert.equal(error.code, "crypto_state");
    assert.equal(error.fatal, true);
    return true;
  });
  assert.ok(rejected instanceof CryptoStateError);
  return rejected;
}

void test("first use and interrupted bootstrap expose private, distinct storage states", async () => {
  await withStateDir(async (stateDir) => {
    const first = await openCryptoStateStore({ stateDir, identity });
    assert.equal(first.status, "first-use");
    assert.equal(first.databaseExists, false);
    assert.equal(first.getManifest(), undefined);

    const databasePath = await ensureCryptoDatabaseDirectory(stateDir);
    assert.equal(first.status, "first-use");
    assert.equal((await lstat(databasePath)).mode & 0o7777, 0o700);

    const resumed = await openCryptoStateStore({ stateDir, identity });
    assert.equal(resumed.status, "resumable-bootstrap");
    assert.equal(resumed.databaseExists, true);
    assert.equal(resumed.isResumableBootstrap(), true);

    const completed = await resumed.recordBootstrap(fingerprints);
    assert.deepEqual(completed, {
      schemaVersion: 1,
      ...identity,
      ...fingerprints,
      bootstrapCompleted: true,
      sasVerified: false,
    });
    assert.equal(resumed.status, "bootstrapped");
    await resumed.recordSasVerification(fingerprints);
    assert.equal(resumed.status, "verified");
    assert.equal((await lstat(resumed.manifestPath)).mode & 0o7777, 0o600);

    const raw = JSON.parse(await readFile(resumed.manifestPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(raw).sort(), [
      "bootstrapCompleted",
      "curve25519Fingerprint",
      "deviceId",
      "ed25519Fingerprint",
      "homeserver",
      "sasVerified",
      "schemaVersion",
      "userId",
    ]);
    for (const forbidden of ["accessToken", "privateKey", "roomKey", "sas", "transcript", "syncToken"]) {
      assert.equal(Object.hasOwn(raw, forbidden), false);
    }

    const reopened = await openCryptoStateStore({ stateDir, identity, fingerprints });
    assert.equal(reopened.status, "verified");
    assert.deepEqual(reopened.getManifest(), { ...manifest(), sasVerified: true });
  });
});

void test("manifest parsing is strict, versioned, and fail-closed", async () => {
  const cases: Array<{ readonly value: unknown; readonly category: CryptoStateError["category"] }> = [
    { value: manifest({ extra: true }), category: "manifest-corrupt" },
    { value: manifest({ schemaVersion: 2 }), category: "unsupported-version" },
    { value: manifest({ userId: "not-an-mxid" }), category: "manifest-corrupt" },
    { value: manifest({ ed25519Fingerprint: "" }), category: "manifest-corrupt" },
    { value: manifest({ sasVerified: true, bootstrapCompleted: false }), category: "manifest-corrupt" },
    { value: "{\"schemaVersion\":1,", category: "manifest-corrupt" },
  ];

  for (const { value, category } of cases) {
    await withStateDir(async (stateDir) => {
      await ensureCryptoDatabaseDirectory(stateDir);
      await writeRawManifest(stateDir, value);
      const error = await expectCryptoError(() => openCryptoStateStore({ stateDir, identity }), category);
      assert.equal(error.message.includes("fingerprint"), false);
      assert.equal(error.message.includes("accessToken"), false);
    });
  }
});

void test("identity and public-key fingerprints are bound without leaking metadata", async () => {
  await withStateDir(async (stateDir) => {
    await ensureCryptoDatabaseDirectory(stateDir);
    await writeRawManifest(stateDir, manifest({ userId: "@other:example" }));
    const identityError = await expectCryptoError(
      () => openCryptoStateStore({ stateDir, identity }),
      "identity-mismatch",
    );
    assert.equal(identityError.message.includes("@other:example"), false);

    await writeRawManifest(stateDir, manifest());
    const fingerprintError = await expectCryptoError(
      () => openCryptoStateStore({ stateDir, identity, fingerprints: { ...fingerprints, ed25519Fingerprint: "changed" } }),
      "fingerprint-mismatch",
    );
    assert.equal(fingerprintError.message.includes("changed"), false);
  });
});

void test("missing established database and unverified state cannot satisfy daemon restoration", async () => {
  await withStateDir(async (stateDir) => {
    await writeRawManifest(stateDir, manifest());
    await expectCryptoError(() => openCryptoStateStore({ stateDir, identity }), "database-missing");
  });

  await withStateDir(async (stateDir) => {
    await ensureCryptoDatabaseDirectory(stateDir);
    const store = await openCryptoStateStore({ stateDir, identity });
    await expectCryptoError(async () => store.assertReadyForDaemon(fingerprints), "manifest-absent");
    await store.recordBootstrap(fingerprints);
    await expectCryptoError(async () => store.assertReadyForDaemon(fingerprints), "verification-required");
    await store.recordSasVerification(fingerprints);
    assert.equal(store.assertReadyForDaemon(fingerprints).deviceId, identity.deviceId);
  });
});

void test("database validation rejects symlinks, insecure modes, and non-regular entries", async () => {
  await withStateDir(async (stateDir) => {
    const databasePath = await ensureCryptoDatabaseDirectory(stateDir);
    const child = join(databasePath, "store.db");
    await writeFile(child, "opaque sdk bytes");
    await chmod(child, 0o640);
    await expectCryptoError(() => openCryptoStateStore({ stateDir }), "permissions");
    await chmod(child, 0o600);

    const outside = join(stateDir, "outside.db");
    await writeFile(outside, "not part of the database");
    await symlink(outside, join(databasePath, "linked.db"));
    await expectCryptoError(() => openCryptoStateStore({ stateDir }), "unsafe-path");
  });

  await withStateDir(async (stateDir) => {
    const databasePath = await ensureCryptoDatabaseDirectory(stateDir);
    await chmod(databasePath, 0o750);
    await expectCryptoError(() => openCryptoStateStore({ stateDir }), "permissions");
  });
});

void test("database validation retries a disappearing Node IndexedDB snapshot temporary", async () => {
  await withStateDir(async (stateDir) => {
    const databasePath = await ensureCryptoDatabaseDirectory(stateDir);
    const temporaryPath = join(databasePath, ".indexeddb.snapshot.tmp");
    await writeFile(temporaryPath, "snapshot bytes");
    await chmod(temporaryPath, 0o600);

    let removed = false;
    const store = await openCryptoStateStore({
      stateDir,
      faultInjector: async (point) => {
        if (point === "database-entry-before-stat" && !removed) {
          removed = true;
          await rm(temporaryPath);
        }
      },
    });

    assert.equal(removed, true);
    assert.equal(store.databaseExists, true);
  });
});

void test("manifest writes are serialized, atomic, private, and clean up interrupted temporaries", async () => {
  await withStateDir(async (stateDir) => {
    await ensureCryptoDatabaseDirectory(stateDir);
    const store = await openCryptoStateStore({ stateDir, identity });
    await Promise.all([
      store.recordBootstrap(fingerprints),
      store.recordBootstrap(fingerprints),
    ]);
    assert.equal(store.status, "bootstrapped");
    assert.equal((await readdir(stateDir)).filter((name) => name.endsWith(".tmp")).length, 0);

    const raw = await readFile(store.manifestPath, "utf8");
    assert.equal(raw.endsWith("\n"), true);
    assert.equal(raw.includes("private"), false);
  });
});

void test("write, file-fsync, rename, and directory-fsync failures are sanitized", async () => {
  const points = ["write", "file-fsync", "rename", "directory-fsync"] as const;
  for (const point of points) {
    await withStateDir(async (stateDir) => {
      await ensureCryptoDatabaseDirectory(stateDir);
      let enabled = false;
      const store = await openCryptoStateStore({
        stateDir,
        identity,
        faultInjector: (faultPoint) => {
          if (enabled && faultPoint === point) {
            throw new Error("raw access token and room key");
          }
        },
      });
      await store.recordBootstrap(fingerprints);
      enabled = true;
      const error = await expectCryptoError(
        () => store.writeManifest({ ...store.getManifest()!, sasVerified: true }),
        point,
      );
      assert.equal(error.message.includes("raw access token"), false);
      assert.equal(store.getManifest()?.sasVerified, false);
      assert.equal((await lstat(store.manifestPath)).mode & 0o7777, 0o600);
      assert.equal((await readdir(stateDir)).some((name) => name.endsWith(".tmp")), false);
    });
  }
});

void test("interrupted bootstrap temporary files are ignored and never parsed", async () => {
  await withStateDir(async (stateDir) => {
    await writeFile(join(stateDir, `.${CRYPTO_MANIFEST_FILE}.crash.tmp`), "token and truncated manifest");
    await chmod(join(stateDir, `.${CRYPTO_MANIFEST_FILE}.crash.tmp`), 0o600);
    const store = await openCryptoStateStore({ stateDir, identity });
    assert.equal(store.status, "first-use");
    assert.equal((await readdir(stateDir)).some((name) => name.endsWith(".tmp")), false);
  });
});

void test("recovery guidance is stable metadata and contains no state contents", async () => {
  await withStateDir(async (stateDir) => {
    await ensureCryptoDatabaseDirectory(stateDir);
    await writeRawManifest(stateDir, manifest({ userId: "@secret-user:example" }));
    const error = await expectCryptoError(() => openCryptoStateStore({ stateDir, identity }), "identity-mismatch");
    assert.equal(error.recoveryAction, "restore-backup");
    assert.match(error.recoveryGuidance, /matching protected crypto backup/u);
    assert.equal(error.recoveryGuidance.includes("@secret-user:example"), false);
  });
});

void test("a manifest without a database is never created by a normal state open", async () => {
  await withStateDir(async (stateDir) => {
    const store = await openCryptoStateStore({ stateDir, identity });
    await assert.rejects(
      store.writeManifest({
        ...manifest(),
        homeserver: identity.homeserver,
        userId: identity.userId,
        deviceId: identity.deviceId,
      } as never),
      (error: unknown) => error instanceof CryptoStateError && error.category === "database-missing",
    );
    assert.equal((await readdir(stateDir)).includes("matrix-crypto"), false);
  });
});

void test("crypto storage reuses the existing process-lifetime state lock", async () => {
  await withStateDir(async (stateDir) => {
    const lock = await acquireStateLock(stateDir);
    try {
      await ensureCryptoDatabaseDirectory(stateDir);
      const store = await openCryptoStateStore({ stateDir, identity });
      assert.equal(store.status, "resumable-bootstrap");
      assert.equal((await readdir(stateDir)).filter((name) => name.endsWith(".lock")).length, 1);
      await assert.rejects(() => acquireStateLock(stateDir));
    } finally {
      await lock.release();
    }
  });
});
