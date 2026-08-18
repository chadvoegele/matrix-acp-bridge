import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { promises as fs, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, dirname, join, parse as parsePath, resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { Readable, Writable } from "node:stream";

import { parse as parseToml, type TomlTableWithoutBigInt, type TomlValueWithoutBigInt } from "smol-toml";

import { isMatrixId, isValidMatrixDeviceId } from "./matrix-validation.js";
import type { MatrixDeviceId, MatrixRoomId, MatrixUserId } from "./matrix-client.js";
import { isNodeError } from "./object-validation.js";

export type EncryptionMode = "disabled" | "required";

export interface MatrixConfig {
  readonly homeserver: string;
  readonly userId: MatrixUserId;
  readonly deviceId: MatrixDeviceId;
  readonly accessTokenFile: string;
  readonly allowedRooms: readonly MatrixRoomId[];
  readonly allowedSenders: readonly MatrixUserId[];
  readonly encryption: EncryptionMode;
}

export interface AcpConfig {
  readonly cwd: string;
}

export interface BridgeLimits {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxMatrixMessageBytes: number;
  readonly maxQueuedTurnsPerRoom: number;
  readonly maxConcurrentPrompts: number;
  readonly maxTurnSeconds: number;
  readonly shutdownGraceSeconds: number;
  readonly startupTimeoutSeconds: number;
  readonly maxCatchupAgeSeconds: number;
  readonly maxCatchupEventsPerRoom: number;
}

export interface BridgeConfig {
  readonly stateDir: string;
  readonly matrix: MatrixConfig;
  readonly acp: AcpConfig;
  readonly limits: BridgeLimits;
}

/** The largest delay accepted by Node's timer APIs. */
export const MAX_NODE_TIMER_MILLISECONDS = 2 ** 31 - 1;
export const MAX_CONFIGURATION_INTEGER = 2 ** 31 - 1;

export const DEFAULT_LIMITS: BridgeLimits = {
  maxInputBytes: 16_384,
  maxOutputBytes: 262_144,
  maxMatrixMessageBytes: 32_768,
  maxQueuedTurnsPerRoom: 16,
  maxConcurrentPrompts: 4,
  maxTurnSeconds: 1800,
  shutdownGraceSeconds: 30,
  startupTimeoutSeconds: 60,
  maxCatchupAgeSeconds: 900,
  maxCatchupEventsPerRoom: 4,
};

const LIMIT_KEYS = [
  "max_input_bytes",
  "max_output_bytes",
  "max_matrix_message_bytes",
  "max_queued_turns_per_room",
  "max_concurrent_prompts",
  "max_turn_seconds",
  "shutdown_grace_seconds",
  "startup_timeout_seconds",
  "max_catchup_age_seconds",
  "max_catchup_events_per_room",
] as const;

type LimitKey = (typeof LIMIT_KEYS)[number];
type TomlValue = TomlValueWithoutBigInt;
type TomlTable = "" | "matrix" | "acp" | "limits";

const TABLE_KEYS: Readonly<Record<TomlTable, ReadonlySet<string>>> = {
  "": new Set(["state_dir"]),
  matrix: new Set([
    "homeserver",
    "user_id",
    "device_id",
    "access_token_file",
    "allowed_rooms",
    "allowed_senders",
    "encryption",
  ]),
  acp: new Set(["cwd"]),
  limits: new Set(LIMIT_KEYS),
};

const REQUIRED_KEYS: ReadonlyArray<readonly [TomlTable, string]> = [
  ["", "state_dir"],
  ["matrix", "homeserver"],
  ["matrix", "user_id"],
  ["matrix", "device_id"],
  ["matrix", "access_token_file"],
  ["matrix", "allowed_rooms"],
  ["matrix", "allowed_senders"],
  ["matrix", "encryption"],
  ["acp", "cwd"],
];

const NOFOLLOW = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;

export class ConfigurationError extends Error {
  readonly code = "configuration" as const;

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export interface StateLockLike {
  readonly lockPath: string;
  readonly released: boolean;
  release(): Promise<void>;
}

export interface LoadedConfiguration {
  readonly config: BridgeConfig;
  readonly accessToken: string;
  readonly stateLock: StateLockLike;
}

/**
 * A state lock is backed by the operating system's advisory flock.  The
 * small `flock` helper process keeps the descriptor locked and watches a pipe
 * owned by this process.  If this process exits, the pipe closes and the
 * helper releases the lock without leaving a lock file that needs cleanup.
 */
export class StateLock implements StateLockLike {
  readonly lockPath: string;

  private readonly child: ChildProcess;
  private readonly liveness: Writable;
  private readonly exited: Promise<void>;
  private isReleased = false;

  constructor(
    lockPath: string,
    child: ChildProcess,
    liveness: Writable,
    exited: Promise<void>,
  ) {
    this.lockPath = lockPath;
    this.child = child;
    this.liveness = liveness;
    this.exited = exited;
  }

  get released(): boolean {
    return this.isReleased;
  }

  async release(): Promise<void> {
    if (this.isReleased) {
      return;
    }

    this.isReleased = true;
    this.liveness.end();

    await waitForChildExit(this.child, this.exited);
  }
}

/**
 * Parse and validate the non-filesystem portion of the documented TOML
 * configuration.  Secrets are deliberately not part of the result.
 */
export function parseConfigText(source: string): BridgeConfig {
  if (typeof source !== "string") {
    throw new ConfigurationError("Configuration must be UTF-8 text");
  }

  const entries = parseTomlEntries(source);
  for (const [table, key] of REQUIRED_KEYS) {
    if (!entries.has(entryName(table, key))) {
      throw new ConfigurationError(`Missing required configuration key ${entryName(table, key)}`);
    }
  }

  const stateDir = requiredString(entries, "", "state_dir");
  const matrix: MatrixConfig = {
    homeserver: requiredString(entries, "matrix", "homeserver"),
    userId: requiredString(entries, "matrix", "user_id"),
    deviceId: requiredString(entries, "matrix", "device_id"),
    accessTokenFile: requiredString(entries, "matrix", "access_token_file"),
    allowedRooms: requiredStringArray(entries, "matrix", "allowed_rooms"),
    allowedSenders: requiredStringArray(entries, "matrix", "allowed_senders"),
    encryption: requiredEncryption(entries),
  };
  const acp: AcpConfig = {
    cwd: requiredString(entries, "acp", "cwd"),
  };

  const limits = parseLimits(entries);
  validateShape(stateDir, matrix, acp, limits);
  return { stateDir, matrix, acp, limits };
}

/**
 * Validate paths and private files without acquiring the state lock.  The
 * returned paths are normalized once so later session requests can reuse the
 * exact startup values.
 */
export async function validateConfiguration(config: BridgeConfig): Promise<BridgeConfig> {
  validateShape(config.stateDir, config.matrix, config.acp, config.limits);

  const stateDir = await ensurePrivateStateDirectory(config.stateDir);
  const accessTokenFile = await validateAccessTokenPath(config.matrix.accessTokenFile);
  const cwd = await validateCwdPath(config.acp.cwd);

  return {
    stateDir,
    matrix: {
      ...config.matrix,
      accessTokenFile,
    },
    acp: { cwd },
    limits: { ...config.limits },
  };
}

/** Read, parse, validate, and lock a configuration file. */
export async function loadConfiguration(configPath: string): Promise<LoadedConfiguration> {
  const source = await readConfigurationFile(configPath);
  return loadConfigurationText(source);
}

/** Read, parse, validate, and lock configuration supplied as TOML text. */
export async function loadConfigurationText(source: string): Promise<LoadedConfiguration> {
  const parsed = parseConfigText(source);
  const config = await validateConfiguration(parsed);
  const stateLock = await acquireStateLock(config.stateDir);
  try {
    const accessToken = await readAccessTokenFile(config.matrix.accessTokenFile);
    return { config, accessToken, stateLock };
  } catch (error) {
    try {
      await stateLock.release();
    } catch {
      // Preserve the sanitized configuration error from the failed startup.
    }
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("Unable to load the Matrix access token");
  }
}

/**
 * Ensure the state directory is private and acquire its nonblocking OS lock.
 * An existing unlocked `.lock` file is intentionally reused.
 */
export async function acquireStateLock(stateDir: string): Promise<StateLock> {
  const normalizedStateDir = await ensurePrivateStateDirectory(stateDir);
  const lockPath = join(normalizedStateDir, ".lock");

  try {
    const existingLockPath = await fs.lstat(lockPath);
    if (existingLockPath.isSymbolicLink()) {
      throw new ConfigurationError("The private state lock path must not be a symlink");
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    if (!isNotFound(error)) {
      throw new ConfigurationError("Unable to inspect the private state lock path");
    }
  }

  let lockFile: FileHandle;
  try {
    lockFile = await fs.open(lockPath, constants.O_CREAT | constants.O_RDWR | NOFOLLOW, 0o600);
  } catch {
    throw new ConfigurationError("Unable to open the private state lock file");
  }

  try {
    const stat = await lockFile.stat();
    validatePrivateLockFile(stat);
    await lockFile.chmod(0o600);

    const child = spawn(
      "sh",
      [
        "-c",
        "flock -n 3 || exit 1; printf ready >&4; exec cat <&5 >/dev/null",
        "matrix-acp-state-lock",
      ],
      {
        stdio: ["ignore", "ignore", "ignore", lockFile.fd, "pipe", "pipe"],
      },
    );

    // The child owns its duplicate of the lock descriptor.  Closing this
    // descriptor does not release the child's flock.
    await lockFile.close();
    return await waitForLock(child, lockPath);
  } catch (error) {
    await closeFileQuietly(lockFile);
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("Unable to acquire the private state lock");
  }
}

/** Create a new private state file with owner-only read/write permissions. */
export async function openPrivateStateFile(
  stateDir: string,
  fileName: string,
): Promise<FileHandle> {
  const normalizedStateDir = await ensurePrivateStateDirectory(stateDir);
  if (
    typeof fileName !== "string" ||
    fileName.length === 0 ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("\u0000")
  ) {
    throw new ConfigurationError("Private state file name is invalid");
  }

  const filePath = join(normalizedStateDir, fileName);
  let handle: FileHandle;
  try {
    handle = await fs.open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NOFOLLOW,
      0o600,
    );
  } catch {
    throw new ConfigurationError("Unable to create the private state file");
  }

  try {
    await handle.chmod(0o600);
    const stat = await handle.stat();
    validatePrivateStateFile(stat);
    return handle;
  } catch (error) {
    await closeFileQuietly(handle);
    try {
      await fs.unlink(filePath);
    } catch {
      // Do not replace the useful validation error with cleanup failure.
    }
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("Unable to initialize the private state file");
  }
}

/** Read a regular owner-only Matrix access-token file. */
export async function readAccessTokenFile(filePath: string): Promise<string> {
  const normalizedPath = await validateAccessTokenPath(filePath);
  let handle: FileHandle;
  try {
    handle = await fs.open(normalizedPath, constants.O_RDONLY | NOFOLLOW);
  } catch {
    throw new ConfigurationError("Unable to read the Matrix access token file");
  }

  try {
    const stat = await handle.stat();
    validateAccessTokenFile(stat);
    const bytes = await handle.readFile();
    let contents: string;
    try {
      contents = new TextDecoder("utf8", { fatal: true }).decode(bytes);
    } catch {
      throw new ConfigurationError("The Matrix access token file is not valid UTF-8");
    }

    const token = stripTokenTerminator(contents);
    if (token === undefined) {
      throw new ConfigurationError("The Matrix access token file must contain one nonempty token");
    }
    return token;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("Unable to read the Matrix access token file");
  } finally {
    await closeFileQuietly(handle);
  }
}

async function readConfigurationFile(configPath: string): Promise<string> {
  if (typeof configPath !== "string" || configPath.length === 0 || configPath.includes("\u0000")) {
    throw new ConfigurationError("Configuration file path is invalid");
  }

  try {
    return await fs.readFile(resolve(configPath), "utf8");
  } catch {
    throw new ConfigurationError("Unable to read the configuration file");
  }
}

function validateShape(
  stateDir: string,
  matrix: MatrixConfig,
  acp: AcpConfig,
  limits: BridgeLimits,
): void {
  requireAbsolutePath(stateDir, "state_dir");
  requireAbsolutePath(matrix.accessTokenFile, "matrix.access_token_file");
  requireAbsolutePath(acp.cwd, "acp.cwd");
  requireHomeserver(matrix.homeserver);
  requireMatrixId(matrix.userId, "matrix.user_id", "@");
  requireDeviceId(matrix.deviceId);
  requireMatrixIdList(matrix.allowedRooms, "matrix.allowed_rooms", "!");
  requireMatrixIdList(matrix.allowedSenders, "matrix.allowed_senders", "@");
  if (matrix.encryption !== "disabled" && matrix.encryption !== "required") {
    throw new ConfigurationError(
      'matrix.encryption must be either "disabled" or "required"',
    );
  }
  validateLimits(limits);
}

function validateLimits(limits: BridgeLimits): void {
  const values: Readonly<Record<LimitKey, number>> = {
    max_input_bytes: limits.maxInputBytes,
    max_output_bytes: limits.maxOutputBytes,
    max_matrix_message_bytes: limits.maxMatrixMessageBytes,
    max_queued_turns_per_room: limits.maxQueuedTurnsPerRoom,
    max_concurrent_prompts: limits.maxConcurrentPrompts,
    max_turn_seconds: limits.maxTurnSeconds,
    shutdown_grace_seconds: limits.shutdownGraceSeconds,
    startup_timeout_seconds: limits.startupTimeoutSeconds,
    max_catchup_age_seconds: limits.maxCatchupAgeSeconds,
    max_catchup_events_per_room: limits.maxCatchupEventsPerRoom,
  };
  for (const key of LIMIT_KEYS) {
    requireInteger(values[key], `limits.${key}`);
  }
  if (limits.maxOutputBytes < 20) {
    throw new ConfigurationError("limits.max_output_bytes must be at least 20");
  }
  if (limits.maxMatrixMessageBytes < 64) {
    throw new ConfigurationError("limits.max_matrix_message_bytes must be at least 64");
  }
  for (const key of [
    "max_turn_seconds",
    "shutdown_grace_seconds",
    "startup_timeout_seconds",
    "max_catchup_age_seconds",
  ] as const) {
    if (values[key] > Math.floor(MAX_NODE_TIMER_MILLISECONDS / 1000)) {
      throw new ConfigurationError(`limits.${key} exceeds the Node timer bound`);
    }
  }
}

function requireAbsolutePath(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000") ||
    !isAbsolute(value)
  ) {
    throw new ConfigurationError(`${field} must be an absolute path`);
  }
}

function requireHomeserver(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /\s/u.test(value) ||
    value.includes("\\") ||
    // eslint-disable-next-line no-control-regex -- Matrix URLs reject ASCII controls
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new ConfigurationError("matrix.homeserver must be a safe HTTPS URL");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("matrix.homeserver must be a safe HTTPS URL");
  }

  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    value.includes("?") ||
    value.includes("#") ||
    url.hostname.length === 0
  ) {
    throw new ConfigurationError("matrix.homeserver must be an HTTPS URL without credentials, query, or fragment");
  }
}

function requireDeviceId(value: string): void {
  if (!isValidMatrixDeviceId(value)) {
    throw new ConfigurationError("matrix.device_id must be a nonempty identifier");
  }
}

function requireMatrixId(value: string, field: string, prefix: "@" | "!"): void {
  if (!isMatrixId(value, prefix)) {
    throw new ConfigurationError(`${field} must be an exact Matrix ${prefix === "!" ? "room ID" : "user ID"}`);
  }
}

function requireMatrixIdList(
  values: readonly string[],
  field: string,
  prefix: "@" | "!",
): void {
  if (!Array.isArray(values) || values.length === 0) {
    throw new ConfigurationError(`${field} must contain at least one entry`);
  }
  const seen = new Set<string>();
  for (const value of values as readonly string[]) {
    requireMatrixId(value, field, prefix);
    if (seen.has(value)) {
      throw new ConfigurationError(`${field} must not contain duplicate entries`);
    }
    seen.add(value);
  }
}

function parseLimits(entries: ReadonlyMap<string, TomlValue>): BridgeLimits {
  const values = new Map<LimitKey, number>();
  for (const key of LIMIT_KEYS) {
    const value = entries.get(entryName("limits", key));
    const defaultValue = DEFAULT_LIMITS[limitProperty(key)];
    const parsed = value === undefined ? defaultValue : requireInteger(value, `limits.${key}`);
    values.set(key, parsed);
  }

  const maxOutputBytes = values.get("max_output_bytes")!;
  const maxMatrixMessageBytes = values.get("max_matrix_message_bytes")!;
  if (maxOutputBytes < 20) {
    throw new ConfigurationError("limits.max_output_bytes must be at least 20");
  }
  if (maxMatrixMessageBytes < 64) {
    throw new ConfigurationError("limits.max_matrix_message_bytes must be at least 64");
  }

  for (const key of [
    "max_turn_seconds",
    "shutdown_grace_seconds",
    "startup_timeout_seconds",
    "max_catchup_age_seconds",
  ] as const) {
    const seconds = values.get(key)!;
    if (seconds > Math.floor(MAX_NODE_TIMER_MILLISECONDS / 1000)) {
      throw new ConfigurationError(`limits.${key} exceeds the Node timer bound`);
    }
  }

  return {
    maxInputBytes: values.get("max_input_bytes")!,
    maxOutputBytes,
    maxMatrixMessageBytes,
    maxQueuedTurnsPerRoom: values.get("max_queued_turns_per_room")!,
    maxConcurrentPrompts: values.get("max_concurrent_prompts")!,
    maxTurnSeconds: values.get("max_turn_seconds")!,
    shutdownGraceSeconds: values.get("shutdown_grace_seconds")!,
    startupTimeoutSeconds: values.get("startup_timeout_seconds")!,
    maxCatchupAgeSeconds: values.get("max_catchup_age_seconds")!,
    maxCatchupEventsPerRoom: values.get("max_catchup_events_per_room")!,
  };
}

function requireInteger(value: TomlValue, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ConfigurationError(`${field} must be an integer`);
  }
  if (value <= 0 || value > MAX_CONFIGURATION_INTEGER) {
    throw new ConfigurationError(`${field} must be between 1 and ${MAX_CONFIGURATION_INTEGER}`);
  }
  return value;
}

function requiredString(entries: ReadonlyMap<string, TomlValue>, table: TomlTable, key: string): string {
  const value = entries.get(entryName(table, key));
  if (typeof value !== "string") {
    throw new ConfigurationError(`${entryName(table, key)} must be a string`);
  }
  return value;
}

function requiredStringArray(
  entries: ReadonlyMap<string, TomlValue>,
  table: TomlTable,
  key: string,
): string[] {
  const value = entries.get(entryName(table, key));
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigurationError(`${entryName(table, key)} must be an array of strings`);
  }
  return [...value] as string[];
}

function requiredEncryption(entries: ReadonlyMap<string, TomlValue>): EncryptionMode {
  const value = entries.get(entryName("matrix", "encryption"));
  if (typeof value !== "string") {
    throw new ConfigurationError("matrix.encryption must be a string");
  }
  if (value !== "disabled" && value !== "required") {
    throw new ConfigurationError(
      'matrix.encryption must be either "disabled" or "required"',
    );
  }
  return value;
}

function limitProperty(key: LimitKey): keyof BridgeLimits {
  const properties: Readonly<Record<LimitKey, keyof BridgeLimits>> = {
    max_input_bytes: "maxInputBytes",
    max_output_bytes: "maxOutputBytes",
    max_matrix_message_bytes: "maxMatrixMessageBytes",
    max_queued_turns_per_room: "maxQueuedTurnsPerRoom",
    max_concurrent_prompts: "maxConcurrentPrompts",
    max_turn_seconds: "maxTurnSeconds",
    shutdown_grace_seconds: "shutdownGraceSeconds",
    startup_timeout_seconds: "startupTimeoutSeconds",
    max_catchup_age_seconds: "maxCatchupAgeSeconds",
    max_catchup_events_per_room: "maxCatchupEventsPerRoom",
  };
  return properties[key];
}

async function validateAccessTokenPath(filePath: string): Promise<string> {
  requireAbsolutePath(filePath, "matrix.access_token_file");
  const normalized = await validateExistingPath(filePath, "matrix.access_token_file", "file");
  try {
    validateAccessTokenFile(await fs.lstat(normalized));
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("Unable to inspect the Matrix access token file");
  }
  return normalized;
}

async function validateCwdPath(cwd: string): Promise<string> {
  requireAbsolutePath(cwd, "acp.cwd");
  try {
    const resolvedCwd = await fs.realpath(resolve(cwd));
    const stat = await fs.stat(resolvedCwd);
    if (!stat.isDirectory()) {
      throw new ConfigurationError("acp.cwd must be an existing directory");
    }
    return resolvedCwd;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("acp.cwd must be an existing directory");
  }
}

async function validateExistingPath(
  rawPath: string,
  field: string,
  expected: "file" | "directory",
): Promise<string> {
  const normalized = resolve(rawPath);
  await walkPathComponents(rawPath, field, false);
  let stat: Stats;
  try {
    stat = await fs.lstat(normalized);
  } catch {
    throw new ConfigurationError(`${field} does not exist`);
  }
  if (stat.isSymbolicLink()) {
    throw new ConfigurationError(`${field} must not contain symlink components`);
  }
  if (expected === "file" && !stat.isFile()) {
    throw new ConfigurationError(`${field} must be a regular file`);
  }
  if (expected === "directory" && !stat.isDirectory()) {
    throw new ConfigurationError(`${field} must be an existing directory`);
  }
  return normalized;
}

async function ensurePrivateStateDirectory(rawPath: string): Promise<string> {
  requireAbsolutePath(rawPath, "state_dir");
  const normalized = resolve(rawPath);
  await walkPathComponents(rawPath, "state_dir", true);

  let stat: Stats;
  try {
    stat = await fs.lstat(normalized);
  } catch {
    throw new ConfigurationError("state_dir could not be created");
  }
  if (!stat.isDirectory()) {
    throw new ConfigurationError("state_dir must be a directory");
  }
  requireServiceOwner(stat, "state_dir");
  if ((stat.mode & 0o7777) !== 0o700) {
    throw new ConfigurationError("state_dir must be owned by the service user with mode 0700");
  }
  return normalized;
}

/** Validate and normalize the already-configured private state directory. */
export async function validatePrivateStateDirectory(rawPath: string): Promise<string> {
  return ensurePrivateStateDirectory(rawPath);
}

async function walkPathComponents(
  rawPath: string,
  field: string,
  createMissing: boolean,
): Promise<void> {
  const root = parsePath(rawPath).root;
  let current = root;
  const remainder = rawPath
    .slice(root.length)
    .split(/[\\/]/u)
    .filter((component) => component.length > 0 && component !== ".");

  for (const [index, component] of remainder.entries()) {
    if (component === "..") {
      current = dirname(current);
      continue;
    }

    current = join(current, component);
    let stat: Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (!createMissing || !isNotFound(error)) {
        throw new ConfigurationError(`${field} has a missing or inaccessible path component`);
      }
      try {
        await fs.mkdir(current, { mode: 0o700 });
        await fs.chmod(current, 0o700);
        stat = await fs.lstat(current);
      } catch (createError) {
        if (isAlreadyExists(createError)) {
          try {
            stat = await fs.lstat(current);
          } catch {
            throw new ConfigurationError(`${field} has an inaccessible path component`);
          }
        } else {
          throw new ConfigurationError(`${field} could not create its private path`);
        }
      }
    }

    if (stat.isSymbolicLink()) {
      throw new ConfigurationError(`${field} must not contain symlink components`);
    }
    if (index < remainder.length - 1 && !stat.isDirectory()) {
      throw new ConfigurationError(`${field} has a non-directory path component`);
    }
  }
}

function validateAccessTokenFile(stat: Stats): void {
  if (!stat.isFile()) {
    throw new ConfigurationError("matrix.access_token_file must be a regular file");
  }
  requireServiceOwner(stat, "matrix.access_token_file");
  const mode = stat.mode & 0o7777;
  if ((mode & ~0o600) !== 0 || (mode & 0o400) === 0) {
    throw new ConfigurationError("matrix.access_token_file must be owner-readable with no group or world access");
  }
}

function validatePrivateLockFile(stat: Stats): void {
  if (!stat.isFile()) {
    throw new ConfigurationError("The private state lock path must be a regular file");
  }
  requireServiceOwner(stat, "state lock");
}

function validatePrivateStateFile(stat: Stats): void {
  if (!stat.isFile()) {
    throw new ConfigurationError("Private state files must be regular files");
  }
  requireServiceOwner(stat, "private state file");
  if ((stat.mode & 0o7777) !== 0o600) {
    throw new ConfigurationError("Private state files must have mode 0600");
  }
}

/** Validate metadata for a private state file opened without following links. */
export function validatePrivateStateFileMetadata(stat: Stats): void {
  validatePrivateStateFile(stat);
}

function requireServiceOwner(stat: Stats, field: string): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new ConfigurationError(`${field} must be owned by the service user`);
  }
}

function stripTokenTerminator(contents: string): string | undefined {
  let token = contents;
  if (token.endsWith("\n")) {
    token = token.slice(0, -1);
  }
  if (token.length === 0 || /\s/u.test(token)) {
    return undefined;
  }
  return token;
}

async function waitForLock(child: ChildProcess, lockPath: string): Promise<StateLock> {
  const streams = child.stdio as unknown as Array<Readable | Writable | null | undefined>;
  const ready = streams[4] as Readable | null | undefined;
  const liveness = streams[5] as Writable | null | undefined;
  if (ready == undefined || liveness == undefined) {
    child.kill("SIGTERM");
    throw new ConfigurationError("Unable to initialize the private state lock");
  }

  let exitResolve!: () => void;
  const exited = new Promise<void>((resolveExit) => {
    exitResolve = resolveExit;
  });
  child.once("exit", () => exitResolve());

  return await new Promise<StateLock>((resolveLock, rejectLock) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      rejectLock(new ConfigurationError("Timed out acquiring the private state lock"));
    }, 5000);

    const reject = (message: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      rejectLock(new ConfigurationError(message));
    };

    ready.on("data", (chunk: Buffer | string) => {
      if (settled || !String(chunk).includes("ready")) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      ready.resume();
      resolveLock(new StateLock(lockPath, child, liveness, exited));
    });
    child.once("error", () => reject("Advisory state locking is unavailable"));
    child.once("exit", (code, signal) => {
      if (settled) {
        return;
      }
      if (code === 1 && signal === null) {
        reject("The private state directory is already locked");
      } else {
        reject("Unable to acquire the private state lock");
      }
    });
  });
}

async function waitForChildExit(child: ChildProcess, exited: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, 2000);
  try {
    await Promise.race([
      exited,
      new Promise<void>((resolveRace) => {
        timer.unref();
        setTimeout(resolveRace, 2000).unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise<void>((resolveRace) => setTimeout(resolveRace, 1000).unref())]);
  }
}

function entryName(table: TomlTable, key: string): string {
  return table.length === 0 ? key : `${table}.${key}`;
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error, "EEXIST");
}

async function closeFileQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // The original configuration error is more useful and remains sanitized.
  }
}

function parseTomlEntries(source: string): ReadonlyMap<string, TomlValue> {
  let document: TomlTableWithoutBigInt;
  try {
    document = parseToml(source.startsWith("\uFEFF") ? source.slice(1) : source, { integersAsBigInt: false });
  } catch {
    throw new ConfigurationError("Invalid TOML configuration");
  }

  const entries = new Map<string, TomlValue>();
  for (const [key, value] of Object.entries(document)) {
    if (key === "matrix" || key === "acp" || key === "limits") {
      if (!isTomlTable(value)) {
        throw new ConfigurationError(`${key} must be a TOML table`);
      }
      addTomlTableEntries(entries, key, value);
      continue;
    }
    if (!TABLE_KEYS[""].has(key)) {
      throw new ConfigurationError("Unknown configuration key");
    }
    entries.set(key, value);
  }
  return entries;
}

function addTomlTableEntries(
  entries: Map<string, TomlValue>,
  table: Exclude<TomlTable, "">,
  values: TomlTableWithoutBigInt,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (!TABLE_KEYS[table].has(key)) {
      throw new ConfigurationError("Unknown configuration key");
    }
    entries.set(entryName(table, key), value);
  }
}

function isTomlTable(value: TomlValue): value is TomlTableWithoutBigInt {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}
