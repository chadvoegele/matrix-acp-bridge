import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  CRYPTO_MANIFEST_FILE,
  CRYPTO_MANIFEST_SCHEMA_VERSION,
  cryptoStatePaths,
} from "./crypto-runtime.js";
import {
  ConfigurationError,
  validatePrivateStateDirectory,
  validatePrivateStateFileMetadata,
} from "./config.js";
import type { DiagnosticSink } from "./diagnostics.js";
import type {
  CryptoDeviceKeyFingerprints,
  CryptoStatePaths,
} from "./crypto-contracts.js";
import type { MatrixCheckpointIdentity } from "./bridge-state.js";
import { closeQuietly, unlinkQuietly } from "./file-utils.js";
import { isMatrixId, isSafeHomeserver, isValidMatrixDeviceId } from "./matrix-validation.js";
import type { MatrixDeviceId, MatrixUserId } from "./matrix-client.js";
import { hasExactKeys, isNodeError, isRecord } from "./object-validation.js";

export type CryptoStateFaultPoint =
  | "write"
  | "file-fsync"
  | "rename"
  | "directory-fsync"
  | "database-entry-before-stat";

/** Test-only fault boundary; injected failures are sanitized before escaping. */
export type CryptoStateFaultInjector = (
  point: CryptoStateFaultPoint,
) => void | Promise<void>;

export type CryptoStateFailureCategory =
  | "unsafe-path"
  | "permissions"
  | "read"
  | "manifest-corrupt"
  | "unsupported-version"
  | "identity-mismatch"
  | "fingerprint-mismatch"
  | "database-missing"
  | "database-invalid"
  | "manifest-absent"
  | "manifest-incomplete"
  | "verification-required"
  | "invalid-input"
  | "write"
  | "file-fsync"
  | "rename"
  | "directory-fsync";

export type CryptoStateRecoveryAction =
  | "bootstrap"
  | "verify"
  | "restore-backup"
  | "replace-device"
  | "inspect";

/**
 * A sanitized crypto-storage failure.  Error text never includes manifest
 * contents, key fingerprints, SDK errors, or access-token material.
 */
export class CryptoStateError extends Error {
  readonly code = "crypto_state" as const;
  readonly fatal = true as const;
  readonly category: CryptoStateFailureCategory;
  readonly statePath: string;
  readonly recoveryAction: CryptoStateRecoveryAction;
  readonly recoveryGuidance: string;

  constructor(category: CryptoStateFailureCategory, statePath: string) {
    super(`Private crypto state failure (${category}) at ${statePath}`);
    this.name = "CryptoStateError";
    this.category = category;
    this.statePath = statePath;
    this.recoveryAction = recoveryActionFor(category);
    this.recoveryGuidance = recoveryGuidanceFor(this.recoveryAction);
  }
}

export type CryptoStateStatus =
  | "first-use"
  | "resumable-bootstrap"
  | "incomplete-bootstrap"
  | "bootstrapped"
  | "verified";

export interface CryptoManifest extends CryptoDeviceKeyFingerprints {
  readonly schemaVersion: 1;
  readonly homeserver: string;
  readonly userId: MatrixUserId;
  readonly deviceId: MatrixDeviceId;
  readonly bootstrapCompleted: boolean;
  readonly sasVerified: boolean;
}

export interface CryptoStateStoreOptions {
  /** The already validated private state directory. */
  readonly stateDir: string;
  /** Optional configured identity used to fail closed on manifest mismatch. */
  readonly identity?: MatrixCheckpointIdentity;
  /** Optional current SDK public keys used to fail closed on key mismatch. */
  readonly fingerprints?: CryptoDeviceKeyFingerprints;
  readonly diagnostics?: DiagnosticSink;
  readonly faultInjector?: CryptoStateFaultInjector;
}

export interface CryptoStateInspection {
  readonly paths: CryptoStatePaths;
  readonly status: CryptoStateStatus;
  readonly databaseExists: boolean;
  readonly manifest?: CryptoManifest;
}

const NOFOLLOW = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
const DIRECTORY_FLAG = "O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0;
const MANIFEST_FILE_FLAGS = constants.O_RDONLY | NOFOLLOW;
const TEMP_FILE_FLAGS = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW;
const NODE_INDEXEDDB_SNAPSHOT_TEMP_FILE = ".indexeddb.snapshot.tmp";
const DATABASE_VALIDATION_MAX_ATTEMPTS = 3;

/**
 * Open the bridge-owned crypto metadata and validate the SDK database root.
 * This function never creates either path.  Bootstrap must explicitly call
 * `ensureCryptoDatabaseDirectory` before publishing a first manifest.
 */
export async function openCryptoStateStore(
  options: CryptoStateStoreOptions,
): Promise<PrivateCryptoStateStore> {
  const requestedManifestPath = join(options.stateDir, CRYPTO_MANIFEST_FILE);
  let stateDir: string;
  try {
    stateDir = await validatePrivateStateDirectory(options.stateDir);
  } catch (error) {
    const category = error instanceof ConfigurationError ? "unsafe-path" : "read";
    const failure = new CryptoStateError(category, requestedManifestPath);
    emitFailure(options.diagnostics, failure);
    throw failure;
  }

  try {
    const paths = cryptoStatePaths(stateDir);
    assertDerivedPaths(stateDir, paths);
    await discardCrashLeftTemporaryFiles(stateDir);
    const database = await inspectDatabaseDirectory(paths.databasePath, options.faultInjector);
    const manifest = await readManifest(paths.manifestPath);

    if (manifest !== undefined && !database.exists) {
      throw new CryptoStateError("database-missing", paths.databasePath);
    }
    if (manifest !== undefined && options.identity !== undefined) {
      assertManifestIdentity(manifest, options.identity, paths.manifestPath);
    }
    if (manifest !== undefined && options.fingerprints !== undefined) {
      assertManifestFingerprints(manifest, options.fingerprints, paths.manifestPath);
    }

    const store = new PrivateCryptoStateStore(
      stateDir,
      paths,
      options.identity,
      database.exists,
      manifest,
      options.diagnostics,
      options.faultInjector,
    );
    emitDiagnostic(options.diagnostics, "debug", "private-crypto-state-opened", {
      path: paths.manifestPath,
      status: store.status,
      databaseExists: database.exists,
    });
    return store;
  } catch (error) {
    const failure = error instanceof CryptoStateError
      ? error
      : new CryptoStateError("read", requestedManifestPath);
    emitFailure(options.diagnostics, failure);
    throw failure;
  }
}

/**
 * Create the SDK-owned database root for an explicit bootstrap operation.
 * The root is the only database path bridge code creates or interprets.
 */
export async function ensureCryptoDatabaseDirectory(
  stateDir: string,
  diagnostics?: DiagnosticSink,
): Promise<string> {
  let normalized: string;
  try {
    normalized = await validatePrivateStateDirectory(stateDir);
  } catch (error) {
    const failure = new CryptoStateError(
      error instanceof ConfigurationError ? "unsafe-path" : "read",
      join(stateDir, "matrix-crypto"),
    );
    emitFailure(diagnostics, failure);
    throw failure;
  }

  const databasePath = cryptoStatePaths(normalized).databasePath;
  try {
    const current = await fs.lstat(databasePath);
    validateDatabaseRootStat(current, databasePath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      const failure = error instanceof CryptoStateError
        ? error
        : new CryptoStateError("read", databasePath);
      emitFailure(diagnostics, failure);
      throw failure;
    }
    try {
      await fs.mkdir(databasePath, { mode: 0o700 });
      await fs.chmod(databasePath, 0o700);
    } catch (createError) {
      const category = isNodeError(createError, "EACCES") || isNodeError(createError, "EPERM")
        ? "permissions"
        : "unsafe-path";
      const failure = new CryptoStateError(category, databasePath);
      emitFailure(diagnostics, failure);
      throw failure;
    }
    try {
      validateDatabaseRootStat(await fs.lstat(databasePath), databasePath);
    } catch (error) {
      const failure = error instanceof CryptoStateError
        ? error
        : new CryptoStateError("read", databasePath);
      emitFailure(diagnostics, failure);
      throw failure;
    }
  }
  emitDiagnostic(diagnostics, "debug", "private-crypto-database-ready", { path: databasePath });
  return databasePath;
}

/** Run SDK database creation/initialization while the process mask is private. */
export async function withPrivateCryptoCreationMask<T>(operation: () => Promise<T>): Promise<T> {
  const previous = process.umask(0o077);
  try {
    return await operation();
  } finally {
    process.umask(previous);
  }
}

export class PrivateCryptoStateStore {
  readonly statePath: string;
  readonly databasePath: string;
  readonly manifestPath: string;
  readonly paths: CryptoStatePaths;

  readonly #stateDir: string;
  readonly #identity: MatrixCheckpointIdentity | undefined;
  readonly #diagnostics: DiagnosticSink | undefined;
  readonly #faultInjector: CryptoStateFaultInjector | undefined;
  #databaseExists: boolean;
  #manifest: CryptoManifest | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    stateDir: string,
    paths: CryptoStatePaths,
    identity: MatrixCheckpointIdentity | undefined,
    databaseExists: boolean,
    manifest: CryptoManifest | undefined,
    diagnostics: DiagnosticSink | undefined,
    faultInjector: CryptoStateFaultInjector | undefined,
  ) {
    this.#stateDir = stateDir;
    this.paths = paths;
    this.statePath = paths.manifestPath;
    this.databasePath = paths.databasePath;
    this.manifestPath = paths.manifestPath;
    this.#identity = identity === undefined ? undefined : { ...identity };
    this.#databaseExists = databaseExists;
    this.#manifest = manifest;
    this.#diagnostics = diagnostics;
    this.#faultInjector = faultInjector;
  }

  get databaseExists(): boolean {
    return this.#databaseExists;
  }

  get status(): CryptoStateStatus {
    if (this.#manifest === undefined) {
      return this.#databaseExists ? "resumable-bootstrap" : "first-use";
    }
    if (!this.#manifest.bootstrapCompleted) {
      return "incomplete-bootstrap";
    }
    return this.#manifest.sasVerified ? "verified" : "bootstrapped";
  }

  inspect(): CryptoStateInspection {
    const manifest = this.getManifest();
    return {
      paths: { ...this.paths },
      status: this.status,
      databaseExists: this.#databaseExists,
      ...(manifest === undefined ? {} : { manifest }),
    };
  }

  getManifest(): CryptoManifest | undefined {
    return this.#manifest === undefined ? undefined : { ...this.#manifest };
  }

  /** The first-use state is intentionally not a usable daemon state. */
  isFirstUse(): boolean {
    return this.status === "first-use";
  }

  isResumableBootstrap(): boolean {
    return this.status === "resumable-bootstrap" || this.status === "incomplete-bootstrap";
  }

  /**
   * Prove that normal restoration may open the SDK database without asking
   * the SDK to create anything.  Key fingerprints still require a live Rust
   * crypto instance and are checked by the corresponding method below.
   */
  assertReadyForDaemon(fingerprints?: CryptoDeviceKeyFingerprints): CryptoManifest {
    const manifest = this.#assertReady(true);
    if (fingerprints !== undefined) {
      assertManifestFingerprints(manifest, fingerprints, this.manifestPath);
    }
    return manifest;
  }

  /** Require an established bootstrap before a manual SAS attempt. */
  assertReadyForVerification(fingerprints?: CryptoDeviceKeyFingerprints): CryptoManifest {
    const manifest = this.#assertReady(false);
    if (fingerprints !== undefined) {
      assertManifestFingerprints(manifest, fingerprints, this.manifestPath);
    }
    return manifest;
  }

  #assertReady(requireVerification: boolean): CryptoManifest {
    if (this.#manifest === undefined) {
      throw this.#failure("manifest-absent", this.manifestPath);
    }
    if (!this.#databaseExists) {
      throw this.#failure("database-missing", this.databasePath);
    }
    this.#assertIdentity(this.#manifest);
    if (!this.#manifest.bootstrapCompleted) {
      throw this.#failure("manifest-incomplete", this.manifestPath);
    }
    if (requireVerification && !this.#manifest.sasVerified) {
      throw this.#failure("verification-required", this.manifestPath);
    }
    return this.getManifest()!;
  }

  /**
   * Check whether bootstrap can reuse the current identity.  A missing
   * manifest is not an error here: the explicit bootstrap operation may
   * publish one after the SDK exposes stable public keys.
   */
  validateForBootstrap(fingerprints?: CryptoDeviceKeyFingerprints): boolean {
    if (this.#manifest === undefined) {
      return false;
    }
    this.#assertIdentity(this.#manifest);
    if (fingerprints !== undefined) {
      assertManifestFingerprints(this.#manifest, fingerprints, this.manifestPath);
    }
    return this.#manifest.bootstrapCompleted;
  }

  /** Record completed bootstrap after the SDK has exposed the current keys. */
  async recordBootstrap(fingerprints: CryptoDeviceKeyFingerprints): Promise<CryptoManifest> {
    if (this.#identity === undefined) {
      throw this.#failure("invalid-input", this.manifestPath);
    }
    const next: CryptoManifest = {
      schemaVersion: CRYPTO_MANIFEST_SCHEMA_VERSION,
      homeserver: this.#identity.homeserver,
      userId: this.#identity.userId,
      deviceId: this.#identity.deviceId,
      ...fingerprints,
      bootstrapCompleted: true,
      sasVerified: this.#manifest?.sasVerified ?? false,
    };
    await this.writeManifest(next);
    return this.getManifest()!;
  }

  /** Attest only the already matching local key pair after successful SAS. */
  async recordSasVerification(fingerprints: CryptoDeviceKeyFingerprints): Promise<CryptoManifest> {
    if (this.#manifest === undefined || !this.#manifest.bootstrapCompleted) {
      throw this.#failure("manifest-incomplete", this.manifestPath);
    }
    assertManifestFingerprints(this.#manifest, fingerprints, this.manifestPath);
    await this.writeManifest({ ...this.#manifest, sasVerified: true });
    return this.getManifest()!;
  }

  /**
   * Atomically replace the bridge-owned manifest.  This method never creates
   * the SDK database and refuses a manifest that would establish metadata
   * without an existing database.
   */
  async writeManifest(manifest: CryptoManifest): Promise<void> {
    return this.#enqueue(async () => {
      validateManifest(manifest, this.manifestPath);
      const database = await inspectDatabaseDirectory(this.databasePath);
      this.#databaseExists = database.exists;
      if (!database.exists) {
        throw this.#failure("database-missing", this.databasePath);
      }
      if (this.#manifest !== undefined) {
        assertManifestIdentity(manifest, this.#manifest, this.manifestPath);
        assertManifestFingerprints(manifest, this.#manifest, this.manifestPath);
        if (this.#manifest.sasVerified && !manifest.sasVerified) {
          throw this.#failure("fingerprint-mismatch", this.manifestPath);
        }
      }
      if (this.#identity !== undefined) {
        this.#assertIdentity(manifest);
      }
      await this.#persist(manifest);
      this.#manifest = { ...manifest };
    });
  }

  async flush(): Promise<void> {
    await this.#tail;
  }

  #assertIdentity(manifest: CryptoManifest): void {
    if (this.#identity === undefined) {
      return;
    }
    assertManifestIdentity(manifest, this.#identity, this.manifestPath);
  }

  async #persist(manifest: CryptoManifest): Promise<void> {
    const document = `${JSON.stringify(manifest)}\n`;
    const temporaryPath = join(
      this.#stateDir,
      `.${CRYPTO_MANIFEST_FILE}.${randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    let renamed = false;
    let stage: CryptoStateFailureCategory = "write";
    try {
      await assertManifestTargetSafe(this.manifestPath);
      await this.#inject("write");
      handle = await fs.open(temporaryPath, TEMP_FILE_FLAGS, 0o600);
      await handle.chmod(0o600);
      validateManifestStat(await handle.stat(), temporaryPath);
      await handle.writeFile(document, "utf8");
      stage = "file-fsync";
      await this.#inject("file-fsync");
      await handle.sync();
      await closeQuietly(handle);
      handle = undefined;
      stage = "rename";
      await this.#inject("rename");
      await fs.rename(temporaryPath, this.manifestPath);
      renamed = true;
      stage = "directory-fsync";
      await this.#inject("directory-fsync");
      await syncDirectory(this.#stateDir);
    } catch (error) {
      const failure = error instanceof CryptoStateError
        ? error
        : this.#failure(stage, this.manifestPath);
      emitFailure(this.#diagnostics, failure);
      throw failure;
    } finally {
      await closeQuietly(handle);
      if (!renamed) {
        await unlinkQuietly(temporaryPath);
      }
    }
  }

  async #inject(point: CryptoStateFaultPoint): Promise<void> {
    await this.#faultInjector?.(point);
  }

  #failure(category: CryptoStateFailureCategory, path: string): CryptoStateError {
    return new CryptoStateError(category, path);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation, operation);
    this.#tail = run.then(() => {}, () => {});
    return run;
  }
}

function validateManifest(manifest: CryptoManifest, path: string): void {
  try {
    parseManifest(manifest, path);
  } catch (error) {
    if (error instanceof CryptoStateError) {
      throw error;
    }
    throw new CryptoStateError("manifest-corrupt", path);
  }
}

async function readManifest(path: string): Promise<CryptoManifest | undefined> {
  let stat: Stats;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw new CryptoStateError("read", path);
  }
  validateManifestStat(stat, path);

  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(path, MANIFEST_FILE_FLAGS);
    validateManifestStat(await handle.stat(), path);
    const bytes = await handle.readFile();
    let source: string;
    try {
      source = new TextDecoder("utf8", { fatal: true }).decode(bytes);
    } catch {
      throw new CryptoStateError("manifest-corrupt", path);
    }
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      throw new CryptoStateError("manifest-corrupt", path);
    }
    return parseManifest(value, path);
  } catch (error) {
    if (error instanceof CryptoStateError) {
      throw error;
    }
    throw new CryptoStateError("read", path);
  } finally {
    await closeQuietly(handle);
  }
}

function parseManifest(value: unknown, path = "crypto-state.json"): CryptoManifest {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "homeserver",
    "userId",
    "deviceId",
    "ed25519Fingerprint",
    "curve25519Fingerprint",
    "bootstrapCompleted",
    "sasVerified",
  ])) {
    throw new CryptoStateError("manifest-corrupt", path);
  }
  if (value.schemaVersion !== CRYPTO_MANIFEST_SCHEMA_VERSION) {
    throw new CryptoStateError("unsupported-version", path);
  }
  if (
    typeof value.homeserver !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.deviceId !== "string" ||
    typeof value.ed25519Fingerprint !== "string" ||
    typeof value.curve25519Fingerprint !== "string" ||
    typeof value.bootstrapCompleted !== "boolean" ||
    typeof value.sasVerified !== "boolean" ||
    !isSafeFingerprint(value.ed25519Fingerprint) ||
    !isSafeFingerprint(value.curve25519Fingerprint) ||
    !isSafeHomeserver(value.homeserver) ||
    !isMatrixId(value.userId, "@") ||
    !isValidMatrixDeviceId(value.deviceId) ||
    (value.sasVerified && !value.bootstrapCompleted)
  ) {
    throw new CryptoStateError("manifest-corrupt", path);
  }
  return {
    schemaVersion: CRYPTO_MANIFEST_SCHEMA_VERSION,
    homeserver: value.homeserver,
    userId: value.userId,
    deviceId: value.deviceId,
    ed25519Fingerprint: value.ed25519Fingerprint,
    curve25519Fingerprint: value.curve25519Fingerprint,
    bootstrapCompleted: value.bootstrapCompleted,
    sasVerified: value.sasVerified,
  };
}

function assertManifestIdentity(
  manifest: CryptoManifest,
  identity: Pick<MatrixCheckpointIdentity, "homeserver" | "userId" | "deviceId">,
  path: string,
): void {
  if (
    manifest.homeserver !== identity.homeserver ||
    manifest.userId !== identity.userId ||
    manifest.deviceId !== identity.deviceId
  ) {
    throw new CryptoStateError("identity-mismatch", path);
  }
}

function assertManifestFingerprints(
  manifest: CryptoDeviceKeyFingerprints,
  fingerprints: CryptoDeviceKeyFingerprints,
  path: string,
): void {
  if (
    manifest.ed25519Fingerprint !== fingerprints.ed25519Fingerprint ||
    manifest.curve25519Fingerprint !== fingerprints.curve25519Fingerprint
  ) {
    throw new CryptoStateError("fingerprint-mismatch", path);
  }
}

async function inspectDatabaseDirectory(
  path: string,
  faultInjector?: CryptoStateFaultInjector,
): Promise<{ readonly path: string; readonly exists: boolean }> {
  let stat: Stats;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { path, exists: false };
    }
    throw new CryptoStateError("read", path);
  }
  validateDatabaseRootStat(stat, path);
  await validateDatabaseTree(path, path, faultInjector);
  return { path, exists: true };
}

async function validateDatabaseTree(
  path: string,
  root: string,
  faultInjector?: CryptoStateFaultInjector,
  attempt = 1,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(path, { withFileTypes: true });
  } catch {
    throw new CryptoStateError("database-invalid", root);
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (child === join(root, NODE_INDEXEDDB_SNAPSHOT_TEMP_FILE)) {
      await faultInjector?.("database-entry-before-stat");
    }
    let stat: Stats;
    try {
      stat = await fs.lstat(child);
    } catch (error) {
      if (isNodeError(error, "ENOENT") &&
          child === join(root, NODE_INDEXEDDB_SNAPSHOT_TEMP_FILE) &&
          attempt < DATABASE_VALIDATION_MAX_ATTEMPTS) {
        // Node IndexedDB publishes snapshots by renaming this exact temporary
        // path. A directory listing can retain the old entry after that rename
        // and make its subsequent lstat() legitimately return ENOENT. Retry a
        // complete tree snapshot after queued filesystem work settles; every
        // other missing or unreadable entry remains invalid.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await validateDatabaseTree(root, root, faultInjector, attempt + 1);
        return;
      }
      throw new CryptoStateError("database-invalid", root);
    }
    if (stat.isSymbolicLink()) {
      throw new CryptoStateError("unsafe-path", child);
    }
    if (stat.isDirectory()) {
      validatePrivateDirectoryStat(stat, child);
      await validateDatabaseTree(child, root, faultInjector, attempt);
      continue;
    }
    if (!stat.isFile()) {
      throw new CryptoStateError("database-invalid", child);
    }
    validatePrivateDatabaseFileStat(stat, child);
  }
}

function validateDatabaseRootStat(stat: Stats, path: string): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new CryptoStateError("unsafe-path", path);
  }
  validatePrivateDirectoryStat(stat, path);
}

function validatePrivateDirectoryStat(stat: Stats, path: string): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new CryptoStateError("permissions", path);
  }
  if ((stat.mode & 0o7777) !== 0o700) {
    throw new CryptoStateError("permissions", path);
  }
}

function validatePrivateDatabaseFileStat(stat: Stats, path: string): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new CryptoStateError("permissions", path);
  }
  if ((stat.mode & 0o77) !== 0) {
    throw new CryptoStateError("permissions", path);
  }
}

function validateManifestStat(stat: Stats, path: string): void {
  if (stat.isSymbolicLink()) {
    throw new CryptoStateError("unsafe-path", path);
  }
  try {
    validatePrivateStateFileMetadata(stat);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      const category = error.message.includes("regular files") ? "unsafe-path" : "permissions";
      throw new CryptoStateError(category, path);
    }
    throw new CryptoStateError("read", path);
  }
}

async function assertManifestTargetSafe(path: string): Promise<void> {
  try {
    const stat = await fs.lstat(path);
    validateManifestStat(stat, path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    if (error instanceof CryptoStateError) {
      throw error;
    }
    throw new CryptoStateError("unsafe-path", path);
  }
}

function assertDerivedPaths(stateDir: string, paths: CryptoStatePaths): void {
  const expected = cryptoStatePaths(stateDir);
  if (resolve(paths.databasePath) !== resolve(expected.databasePath) ||
      resolve(paths.manifestPath) !== resolve(expected.manifestPath)) {
    throw new CryptoStateError("unsafe-path", paths.manifestPath);
  }
  for (const path of [paths.databasePath, paths.manifestPath]) {
    const within = relative(stateDir, path);
    if (!isAbsolute(path) || within === ".." || within.startsWith(".." + "/") || within.startsWith(".." + "\\")) {
      throw new CryptoStateError("unsafe-path", path);
    }
  }
}

async function discardCrashLeftTemporaryFiles(stateDir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(stateDir);
  } catch {
    return;
  }
  const prefix = `.${CRYPTO_MANIFEST_FILE}.`;
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith(".tmp")) {
      await unlinkQuietly(join(stateDir, name));
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(path, constants.O_RDONLY | DIRECTORY_FLAG);
    await handle.sync();
  } finally {
    await closeQuietly(handle);
  }
}

function isSafeFingerprint(value: string): boolean {
  return value.length > 0 && value.length <= 512 &&
    // eslint-disable-next-line no-control-regex -- fingerprints reject ASCII controls
    !/[\s\u0000-\u001F\u007F]/u.test(value);
}

function recoveryActionFor(category: CryptoStateFailureCategory): CryptoStateRecoveryAction {
  switch (category) {
    case "manifest-absent":
    case "manifest-incomplete": {
      return "bootstrap";
    }
    case "verification-required": {
      return "verify";
    }
    case "database-missing":
    case "fingerprint-mismatch":
    case "identity-mismatch": {
      return "restore-backup";
    }
    case "manifest-corrupt":
    case "unsupported-version":
    case "unsafe-path":
    case "permissions":
    case "database-invalid": {
      return "inspect";
    }
    default: {
      return "inspect";
    }
  }
}

function recoveryGuidanceFor(action: CryptoStateRecoveryAction): string {
  switch (action) {
    case "bootstrap": {
      return "Run crypto bootstrap only after preserving the private state directory.";
    }
    case "verify": {
      return "Run crypto verify with the configured bridge device and an existing trusted device.";
    }
    case "restore-backup": {
      return "Stop the bridge and restore a matching protected crypto backup; do not replace keys automatically.";
    }
    case "replace-device": {
      return "Revoke the lost Matrix device, provision a new device, and bootstrap a new private state directory.";
    }
    case "inspect": {
      return "Stop the bridge, preserve the private state for investigation, and repair or restore it explicitly.";
    }
  }
}

function emitFailure(diagnostics: DiagnosticSink | undefined, failure: CryptoStateError): void {
  emitDiagnostic(diagnostics, "error", "private-crypto-state-failure", {
    path: failure.statePath,
    category: failure.category,
  });
}

function emitDiagnostic(
  diagnostics: DiagnosticSink | undefined,
  level: "debug" | "error",
  event: string,
  fields: Record<string, string | number | boolean>,
): void {
  try {
    diagnostics?.emit(level, event, fields);
  } catch {
    // Diagnostics never alter crypto state semantics.
  }
}
