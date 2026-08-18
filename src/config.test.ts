import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireStateLock,
  ConfigurationError,
  DEFAULT_LIMITS,
  loadConfigurationText,
  openPrivateStateFile,
  parseConfigText,
  readAccessTokenFile,
  validateConfiguration,
} from "./config.js";

async function withTemporaryRoot<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "matrix-acp-config-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function validConfigText(
  root: string,
  options: {
    readonly stateDir?: string;
    readonly tokenFile?: string;
    readonly cwd?: string;
  } = {},
): string {
  const stateDir = options.stateDir ?? join(root, "state");
  const tokenFile = options.tokenFile ?? join(root, "access-token");
  const cwd = options.cwd ?? root;
  return [
    `state_dir = ${tomlString(stateDir)}`,
    "",
    "[matrix]",
    'homeserver = "https://matrix.example.test"',
    'user_id = "@bridge:example.test"',
    'device_id = "BRIDGEDEVICE"',
    `access_token_file = ${tomlString(tokenFile)}`,
    'allowed_rooms = ["!room:example.test"]',
    'allowed_senders = ["@alice:example.test", "@bob:example.test"]',
    'encryption = "disabled"',
    "",
    "[acp]",
    `cwd = ${tomlString(cwd)}`,
  ].join("\n");
}

async function expectConfigurationError(action: () => unknown): Promise<ConfigurationError> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof ConfigurationError, `expected ConfigurationError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected a ConfigurationError");
}

async function writeToken(path: string, content: string | Uint8Array, mode = 0o400): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch {
    // The file may not exist yet.
  }
  await writeFile(path, content);
  await chmod(path, mode);
}

void test("parses the documented shape and applies every default limit", () => {
  const config = parseConfigText(validConfigText("/tmp/matrix-acp-config-state"));

  assert.deepEqual(config.limits, DEFAULT_LIMITS);
  assert.equal(config.stateDir, "/tmp/matrix-acp-config-state/state");
  assert.deepEqual(config.matrix.allowedRooms, ["!room:example.test"]);
  assert.deepEqual(config.matrix.allowedSenders, ["@alice:example.test", "@bob:example.test"]);
});

void test("parses operator-supplied limits and TOML comments", () => {
  const source = `${validConfigText("/tmp/matrix-acp-config-state")}\n\n[limits]\nmax_input_bytes = 1_000 # byte limit\nmax_output_bytes = 20\nmax_matrix_message_bytes = 64\nmax_queued_turns_per_room = 2\nmax_concurrent_prompts = 1\nmax_turn_seconds = 2_147_483\nshutdown_grace_seconds = 1\nstartup_timeout_seconds = 120\nmax_catchup_age_seconds = 120\nmax_catchup_events_per_room = 3\n`;
  const config = parseConfigText(source);

  assert.deepEqual(config.limits, {
    maxInputBytes: 1000,
    maxOutputBytes: 20,
    maxMatrixMessageBytes: 64,
    maxQueuedTurnsPerRoom: 2,
    maxConcurrentPrompts: 1,
    maxTurnSeconds: 2_147_483,
    shutdownGraceSeconds: 1,
    startupTimeoutSeconds: 120,
    maxCatchupAgeSeconds: 120,
    maxCatchupEventsPerRoom: 3,
  });
});

void test("sanitizes malformed TOML parser failures", async () => {
  const secret = "super-secret-config-value";
  const error = await expectConfigurationError(() =>
    parseConfigText(`state_dir = "${secret}\n`),
  );

  assert.equal(error.message, "Invalid TOML configuration");
  assert.doesNotMatch(error.message, new RegExp(secret));
});

void test("rejects duplicate and unknown TOML structure", async () => {
  const valid = validConfigText("/tmp/matrix-acp-config-state");
  const duplicateKey = valid.replace(
    `state_dir = ${tomlString("/tmp/matrix-acp-config-state/state")}\n`,
    `state_dir = ${tomlString("/tmp/matrix-acp-config-state/state")}\nstate_dir = "/tmp/other"\n`,
  );

  for (const source of [
    duplicateKey,
    `${valid}\n[matrix]\n`,
    `${valid}\n[unknown]\nkey = "value"\n`,
    `${valid}\nunknown_key = true\n`,
    `${valid.replace('encryption = "disabled"', 'encryption = 1')}`,
    `${valid.replace('allowed_rooms = ["!room:example.test"]', 'allowed_rooms = ["!room:example.test", 1]')}`,
    `${valid}\n[limits]\nmax_input_bytes = "16384"\n`,
  ]) {
    await expectConfigurationError(() => parseConfigText(source));
  }
});

void test("accepts both encryption modes and rejects invalid identifiers or modes", async () => {
  const valid = validConfigText("/tmp/matrix-acp-config-state");
  assert.equal(
    parseConfigText(valid.replace('encryption = "disabled"', 'encryption = "required"')).matrix.encryption,
    "required",
  );
  const invalidSources = [
    valid.replace('user_id = "@bridge:example.test"', 'user_id = "Bridge"'),
    valid.replace('allowed_rooms = ["!room:example.test"]', 'allowed_rooms = ["#room:example.test"]'),
    valid.replace('allowed_senders = ["@alice:example.test", "@bob:example.test"]', 'allowed_senders = []'),
    valid.replace(
      'allowed_senders = ["@alice:example.test", "@bob:example.test"]',
      'allowed_senders = ["@alice:example.test", "@alice:example.test"]',
    ),
    valid.replace('device_id = "BRIDGEDEVICE"', 'device_id = "device id"'),
    valid.replace('encryption = "disabled"', 'encryption = "future-mode"'),
  ];

  for (const source of invalidSources) {
    await expectConfigurationError(() => parseConfigText(source));
  }
});

void test("rejects TOML dates where the configuration schema requires scalar values", async () => {
  const valid = validConfigText("/tmp/matrix-acp-config-state");
  const invalidSources = [
    valid.replace(
      `state_dir = ${tomlString("/tmp/matrix-acp-config-state/state")}`,
      "state_dir = 2024-01-01",
    ),
    valid.replace('homeserver = "https://matrix.example.test"', "homeserver = 2024-01-01"),
    valid.replace('allowed_rooms = ["!room:example.test"]', "allowed_rooms = [2024-01-01]"),
    valid.replace('encryption = "disabled"', "encryption = 2024-01-01"),
    `${valid}\n\n[limits]\nmax_input_bytes = 2024-01-01\n`,
  ];

  for (const source of invalidSources) {
    await expectConfigurationError(() => parseConfigText(source));
  }
});

void test("accepts safe homeserver URLs and rejects unsafe URL forms", async () => {
  const valid = validConfigText("/tmp/matrix-acp-config-state");
  const invalidUrls = [
    "http://matrix.example.test",
    "https://user:password@matrix.example.test",
    "https://matrix.example.test?access_token=secret",
    "https://matrix.example.test/#fragment",
    String.raw`https://matrix.example.test\evil`,
    "not a URL",
  ];

  for (const homeserver of invalidUrls) {
    await expectConfigurationError(() =>
      parseConfigText(valid.replace('homeserver = "https://matrix.example.test"', `homeserver = ${tomlString(homeserver)}`)),
    );
  }
});

void test("enforces positive integer, minimum byte, and Node timer bounds", async () => {
  const valid = `${validConfigText("/tmp/matrix-acp-config-state")}\n\n[limits]\n`;
  const invalidValues = [
    "max_input_bytes = 0",
    "max_input_bytes = 2147483648",
    "max_input_bytes = 1.5",
    "max_output_bytes = 19",
    "max_matrix_message_bytes = 63",
    "max_turn_seconds = 2147484",
    "shutdown_grace_seconds = 2147484",
    "startup_timeout_seconds = 2147484",
    "max_catchup_age_seconds = 0",
    "max_catchup_age_seconds = 2147484",
    "max_catchup_events_per_room = 0",
    "max_catchup_age_seconds = -1",
    "max_catchup_events_per_room = -1",
    "max_catchup_age_seconds = 1.5",
    "max_catchup_events_per_room = 1.5",
    "max_catchup_age_seconds = 9007199254740992",
    "max_catchup_events_per_room = 9007199254740992",
    "max_catchup_events_per_room = 2147483648",
  ];

  for (const value of invalidValues) {
    await expectConfigurationError(() => parseConfigText(`${valid}${value}\n`));
  }

  const maxTimerSource = `${valid}max_turn_seconds = 2147483\nshutdown_grace_seconds = 2147483\nstartup_timeout_seconds = 2147483\nmax_catchup_age_seconds = 2147483\n`;
  assert.equal(parseConfigText(maxTimerSource).limits.maxTurnSeconds, 2_147_483);
  assert.equal(parseConfigText(maxTimerSource).limits.maxCatchupAgeSeconds, 2_147_483);
});

void test("creates a private state directory and resolves existing ACP cwd once", async () => {
  await withTemporaryRoot(async (root) => {
    const stateDir = join(root, "nested", "state");
    const tokenFile = join(root, "access-token");
    await writeToken(tokenFile, "matrix-token\n");

    const config = await validateConfiguration(parseConfigText(validConfigText(root, { stateDir, tokenFile })));
    assert.equal(config.stateDir, stateDir);
    assert.equal(config.acp.cwd, root);
    assert.equal(config.matrix.accessTokenFile, tokenFile);

    assert.equal((await lstat(stateDir)).mode & 0o7777, 0o700);
    assert.equal((await lstat(tokenFile)).mode & 0o7777, 0o400);
    if (typeof process.getuid === "function") {
      assert.equal((await lstat(stateDir)).uid, process.getuid());
      assert.equal((await lstat(tokenFile)).uid, process.getuid());
    }
  });
});

void test("rejects insecure state, token, and path-component configurations", async () => {
  await withTemporaryRoot(async (root) => {
    const stateDir = join(root, "state");
    const tokenFile = join(root, "access-token");
    await mkdir(stateDir, { mode: 0o700 });
    await writeToken(tokenFile, "matrix-token\n");

    await chmod(stateDir, 0o750);
    await expectConfigurationError(() => validateConfiguration(parseConfigText(validConfigText(root, { stateDir, tokenFile }))));
    await chmod(stateDir, 0o700);

    await chmod(tokenFile, 0o640);
    await expectConfigurationError(() => validateConfiguration(parseConfigText(validConfigText(root, { stateDir, tokenFile }))));
    await chmod(tokenFile, 0o400);

    const symlinkParent = join(root, "token-link-parent");
    const realParent = join(root, "real-token-parent");
    await mkdir(realParent, { mode: 0o700 });
    await writeToken(join(realParent, "token"), "matrix-token\n");
    await symlink(realParent, symlinkParent);
    await expectConfigurationError(() =>
      validateConfiguration(parseConfigText(validConfigText(root, { stateDir, tokenFile: join(symlinkParent, "token") }))),
    );

    const realState = join(root, "real-state");
    const stateLink = join(root, "state-link");
    await mkdir(realState, { mode: 0o700 });
    await symlink(realState, stateLink);
    await expectConfigurationError(() =>
      validateConfiguration(parseConfigText(validConfigText(root, { stateDir: stateLink, tokenFile }))),
    );
  });
});

void test("requires an existing regular private access-token file", async () => {
  await withTemporaryRoot(async (root) => {
    const stateDir = join(root, "state");
    const tokenFile = join(root, "access-token");
    await mkdir(stateDir, { mode: 0o700 });

    await expectConfigurationError(() => readAccessTokenFile(tokenFile));
    await writeFile(tokenFile, "matrix-token\n");
    await chmod(tokenFile, 0o400);
    assert.equal(await readAccessTokenFile(tokenFile), "matrix-token");

    await rm(tokenFile);
    await mkdir(tokenFile, { mode: 0o700 });
    await expectConfigurationError(() => readAccessTokenFile(tokenFile));
  });
});

void test("accepts only one nonempty token with an optional final LF and redacts failures", async () => {
  await withTemporaryRoot(async (root) => {
    const tokenFile = join(root, "access-token");
    const invalidContents: Array<string | Uint8Array> = [
      "",
      "\n",
      "token\n\n",
      "token with spaces",
      "token\t",
      "token\r\n",
      new Uint8Array([0xFF, 0xFE]),
    ];

    for (const [index, content] of invalidContents.entries()) {
      await writeToken(tokenFile, content);
      const error = await expectConfigurationError(() => readAccessTokenFile(tokenFile));
      assert.match(error.message, /Matrix access token file|token/iu, `unexpected error for case ${index}`);
    }

    await writeToken(tokenFile, "very-secret-token ");
    const redacted = await expectConfigurationError(() => readAccessTokenFile(tokenFile));
    assert.doesNotMatch(redacted.message, /very-secret-token/u);

    await expectConfigurationError(() =>
      loadConfigurationText(validConfigText(root, { stateDir: join(root, "state"), tokenFile })),
    );
    const releasedAfterFailure = await acquireStateLock(join(root, "state"));
    await releasedAfterFailure.release();

    await writeToken(tokenFile, "token-without-newline");
    assert.equal(await readAccessTokenFile(tokenFile), "token-without-newline");
    await writeToken(tokenFile, "token-with-final-newline\n");
    assert.equal(await readAccessTokenFile(tokenFile), "token-with-final-newline");
  });
});

void test("creates 0600 state files and exposes reusable lock release", async () => {
  await withTemporaryRoot(async (root) => {
    const stateDir = join(root, "state");
    const first = await acquireStateLock(stateDir);
    try {
      const stateFile = await openPrivateStateFile(stateDir, "session.json");
      try {
        assert.equal((await lstat(join(stateDir, "session.json"))).mode & 0o7777, 0o600);
        await stateFile.writeFile("private");
      } finally {
        await stateFile.close();
      }

      await expectConfigurationError(() => acquireStateLock(stateDir));

      const independent = await acquireStateLock(join(root, "other-state"));
      await independent.release();
    } finally {
      await first.release();
    }

    assert.equal(first.released, true);
    await expectConfigurationError(() => openPrivateStateFile(stateDir, "session.json"));
    const second = await acquireStateLock(stateDir);
    await second.release();
  });
});

void test("reuses an unlocked stale lock file and redacts lock failures", async () => {
  await withTemporaryRoot(async (root) => {
    const stateDir = join(root, "state");
    const tokenFile = join(root, "access-token");
    await writeToken(tokenFile, "super-secret-token\n");

    const first = await acquireStateLock(stateDir);
    await first.release();
    assert.equal((await lstat(join(stateDir, ".lock"))).isFile(), true);

    const second = await acquireStateLock(stateDir);
    try {
      const error = await expectConfigurationError(() =>
        loadConfigurationText(validConfigText(root, { stateDir, tokenFile })),
      );
      assert.doesNotMatch(error.message, /super-secret-token/u);
    } finally {
      await second.release();
    }

    const stale = await readFile(join(stateDir, ".lock"));
    assert.equal(stale.length, 0);
  });
});
