import type { MatrixDeviceId, MatrixUserId } from "./matrix-client.js";

export interface CryptoDeviceKeyFingerprints {
  readonly ed25519Fingerprint: string;
  readonly curve25519Fingerprint: string;
}

export interface CryptoStatePaths {
  readonly databasePath: string;
  readonly manifestPath: string;
}

export type CryptoCommand =
  | { readonly kind: "bootstrap" }
  | { readonly kind: "verify"; readonly deviceId: string };

export type CryptoOperation =
  | "initialize"
  | "restore"
  | "bootstrap"
  | "verify"
  | "encrypt"
  | "decrypt"
  | "close";

export type CryptoFailureReason =
  | "not_initialized"
  | "storage_missing"
  | "storage_unreadable"
  | "storage_corrupt"
  | "identity_mismatch"
  | "fingerprint_mismatch"
  | "decryption_failed"
  | "encryption_failed"
  | "verification_rejected"
  | "verification_cancelled"
  | "timeout"
  | "permission_denied"
  | "unknown";

export interface CryptoFailureClassification {
  readonly operation: CryptoOperation;
  readonly reason: CryptoFailureReason;
  readonly fatal: boolean;
  readonly retryable: boolean;
}

export interface CryptoInitializationOptions {
  readonly state: CryptoStatePaths;
  readonly userId: MatrixUserId;
  readonly deviceId: MatrixDeviceId;
}

export interface MatrixCryptoAdapter {
  initialize(options: CryptoInitializationOptions): Promise<void>;
  getDeviceKeyFingerprints(): Promise<CryptoDeviceKeyFingerprints>;
  close(): Promise<void>;
}
