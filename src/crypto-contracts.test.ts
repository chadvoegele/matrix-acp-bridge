import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCryptoFailure,
  cryptoManifestMatches,
  cryptoStatePaths,
  CRYPTO_DATABASE_DIRECTORY,
  CRYPTO_MANIFEST_FILE,
  CRYPTO_MANIFEST_SCHEMA_VERSION,
  CryptoContractError,
  validateCryptoCommand,
} from "./crypto-runtime.js";
import type { MatrixConfig } from "./config.js";
import type { CryptoManifest } from "./crypto-state.js";

const MATRIX: MatrixConfig = {
  homeserver: "https://matrix.example.org",
  userId: "@bridge:example.org",
  deviceId: "BRIDGE01",
  accessTokenFile: "/private/state/token",
  allowedRooms: ["!room:example.org"],
  allowedSenders: ["@operator:example.org"],
  encryption: "required",
};

const FINGERPRINTS = {
  ed25519Fingerprint: "ed25519:fingerprint",
  curve25519Fingerprint: "curve25519:fingerprint",
} as const;

const MANIFEST: CryptoManifest = {
  schemaVersion: CRYPTO_MANIFEST_SCHEMA_VERSION,
  homeserver: MATRIX.homeserver,
  userId: MATRIX.userId,
  deviceId: MATRIX.deviceId,
  ...FINGERPRINTS,
  bootstrapCompleted: true,
  sasVerified: false,
};

void test("derives stable crypto paths beneath state_dir", () => {
  assert.deepEqual(cryptoStatePaths("/private/state"), {
    databasePath: `/private/state/${CRYPTO_DATABASE_DIRECTORY}`,
    manifestPath: `/private/state/${CRYPTO_MANIFEST_FILE}`,
  });
  assert.throws(() => cryptoStatePaths("relative/state"), TypeError);
});

void test("validates crypto command gating without persisting a target device", () => {
  assert.throws(
    () => validateCryptoCommand({ kind: "bootstrap" }, { ...MATRIX, encryption: "disabled" }),
    (error: unknown) => error instanceof CryptoContractError && /require matrix\.encryption/u.test(error.message),
  );
  validateCryptoCommand({ kind: "verify", deviceId: "TRUSTED01" }, MATRIX);
  assert.throws(
    () => validateCryptoCommand({ kind: "verify", deviceId: MATRIX.deviceId }, MATRIX),
    /differ from the bridge device/u,
  );
});

void test("classifies crypto failures with metadata-only stable categories", () => {
  assert.deepEqual(classifyCryptoFailure("restore", "fingerprint_mismatch"), {
    operation: "restore",
    reason: "fingerprint_mismatch",
    fatal: true,
    retryable: false,
  });
  assert.deepEqual(classifyCryptoFailure("decrypt", "decryption_failed"), {
    operation: "decrypt",
    reason: "decryption_failed",
    fatal: false,
    retryable: true,
  });
  assert.deepEqual(classifyCryptoFailure("verify", "verification_rejected"), {
    operation: "verify",
    reason: "verification_rejected",
    fatal: false,
    retryable: false,
  });
});

void test("matches a manifest only for the exact identity and current public keys", () => {
  assert.equal(cryptoManifestMatches(MANIFEST, MATRIX, FINGERPRINTS), true);
  assert.equal(
    cryptoManifestMatches(MANIFEST, { ...MATRIX, deviceId: "OTHER" }, FINGERPRINTS),
    false,
  );
  assert.equal(
    cryptoManifestMatches(MANIFEST, MATRIX, { ...FINGERPRINTS, ed25519Fingerprint: "changed" }),
    false,
  );
  assert.equal(cryptoManifestMatches({ ...MANIFEST, schemaVersion: 1 }, MATRIX, FINGERPRINTS), true);
});
