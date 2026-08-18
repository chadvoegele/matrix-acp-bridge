import { join } from "node:path";

import type { MatrixConfig } from "./config.js";
import { isValidMatrixDeviceId } from "./matrix-validation.js";

import type {
  CryptoCommand,
  CryptoDeviceKeyFingerprints,
  CryptoFailureClassification,
  CryptoFailureReason,
  CryptoStatePaths,
} from "./crypto-contracts.js";
import type { CryptoManifest } from "./crypto-state.js";

export const SAS_VERIFICATION_METHOD = "m.sas.v1" as const;

export const CRYPTO_DATABASE_DIRECTORY = "matrix-crypto" as const;
export const CRYPTO_MANIFEST_FILE = "crypto-state.json" as const;
export const CRYPTO_MANIFEST_SCHEMA_VERSION = 1 as const;
export const CRYPTO_TTY_PATH = "/dev/tty" as const;

/** Return the only two bridge-defined paths beneath a validated state dir. */
export function cryptoStatePaths(stateDir: string): CryptoStatePaths {
  if (typeof stateDir !== "string" || stateDir.length === 0 || !stateDir.startsWith("/")) {
    throw new TypeError("Crypto state paths require an absolute state directory");
  }
  return {
    databasePath: join(stateDir, CRYPTO_DATABASE_DIRECTORY),
    manifestPath: join(stateDir, CRYPTO_MANIFEST_FILE),
  };
}

export class CryptoContractError extends Error {
  readonly code = "crypto_contract" as const;

  constructor(message: string) {
    super(message);
    this.name = "CryptoContractError";
  }
}

/** Validate a command against the ordinary, already parsed Matrix config. */
export function validateCryptoCommand(command: CryptoCommand, matrix: MatrixConfig): void {
  if (matrix.encryption !== "required") {
    throw new CryptoContractError("Crypto commands require matrix.encryption = \"required\"");
  }
  if (command.kind === "verify") {
    if (!isValidMatrixDeviceId(command.deviceId)) {
      throw new CryptoContractError("The verification target device ID is invalid");
    }
    if (command.deviceId === matrix.deviceId) {
      throw new CryptoContractError("The verification target device must differ from the bridge device");
    }
  }
}

const FATAL_CRYPTO_FAILURES: ReadonlySet<CryptoFailureReason> = new Set([
  "not_initialized",
  "storage_missing",
  "storage_unreadable",
  "storage_corrupt",
  "identity_mismatch",
  "fingerprint_mismatch",
  "encryption_failed",
  "permission_denied",
  "unknown",
]);

const RETRYABLE_CRYPTO_FAILURES: ReadonlySet<CryptoFailureReason> = new Set([
  "decryption_failed",
  "verification_cancelled",
  "timeout",
]);

/**
 * Convert an internal crypto outcome into metadata-only classification.  The
 * function accepts a reason enum rather than an unknown error deliberately,
 * so raw SDK errors cannot leak across the adapter boundary.
 */
export function classifyCryptoFailure(
  operation: CryptoFailureClassification["operation"],
  reason: CryptoFailureReason,
): CryptoFailureClassification {
  return {
    operation,
    reason,
    fatal: FATAL_CRYPTO_FAILURES.has(reason),
    retryable: RETRYABLE_CRYPTO_FAILURES.has(reason),
  };
}

/**
 * Strictly compare a restored local identity with the configured identity and
 * manifest.  The boolean result is useful to storage and lifecycle adapters;
 * callers can choose their own safe recovery category.
 */
export function cryptoManifestMatches(
  manifest: CryptoManifest,
  matrix: Pick<MatrixConfig, "homeserver" | "userId" | "deviceId">,
  fingerprints: CryptoDeviceKeyFingerprints,
): boolean {
  return manifest.schemaVersion === CRYPTO_MANIFEST_SCHEMA_VERSION &&
    manifest.homeserver === matrix.homeserver &&
    manifest.userId === matrix.userId &&
    manifest.deviceId === matrix.deviceId &&
    manifest.ed25519Fingerprint === fingerprints.ed25519Fingerprint &&
    manifest.curve25519Fingerprint === fingerprints.curve25519Fingerprint;
}
