import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { repoRoot } from "./common.mjs";
import test from "node:test";

import { makeConfig as roomPlain } from "../unencrypted-e2e/lib.mjs";
import { makeConfig as roomEncrypted } from "../encrypted-e2e/lib.mjs";
import { makeConfig as threadPlain, defaultEnvironmentPath as plainPath } from "../thread-sessions/plaintext-lib.mjs";
import {
  makeConfig as threadEncrypted,
  defaultEnvironmentPath as encryptedPath,
} from "../thread-sessions/encrypted-lib.mjs";
import { runSenderHarness as plainSender } from "./plaintext-sender.mjs";
import { runSenderHarness as encryptedSender } from "./encrypted-sender.mjs";

const environment = {
  homeserver: "https://matrix.invalid",
  roomId: "!room:invalid",
  acpCwd: "/tmp",
  bridge: { stateDir: "/bridge/state", userId: "@bridge:invalid", deviceId: "B", tokenFile: "/bridge/token" },
  sender: { stateDir: "/sender/state", userId: "@sender:invalid", deviceId: "S", tokenFile: "/sender/token" },
  helper: { stateDir: "/helper/state", userId: "@bridge:invalid", deviceId: "H", tokenFile: "/helper/token" },
};

test("room configs ignore inherited thread mode; dedicated configs select only the bridge", () => {
  const previous = process.env.E2E_RESPONSE_MODE;
  process.env.E2E_RESPONSE_MODE = "thread";
  try {
    assert.match(roomPlain(environment), /response_mode = "room"/u);
    for (const role of ["bridge", "helper", "sender"]) {
      assert.match(roomEncrypted(environment, role), /response_mode = "room"/u);
      assert.match(
        threadEncrypted(environment, role),
        new RegExp(`response_mode = "${role === "bridge" ? "thread" : "room"}"`, "u"),
      );
    }
    assert.match(threadPlain(environment), /response_mode = "thread"/u);
    assert.match(threadPlain(environment), /encryption = "disabled"/u);
    assert.match(threadEncrypted(environment, "bridge"), /encryption = "required"/u);
    assert.notEqual(plainPath, encryptedPath);
    assert.match(plainPath, /thread-sessions\/plaintext-environment.json$/u);
    assert.match(encryptedPath, /thread-sessions\/encrypted-environment.json$/u);
  } finally {
    if (previous === undefined) delete process.env.E2E_RESPONSE_MODE;
    else process.env.E2E_RESPONSE_MODE = previous;
  }
});

test("room senders reject thread flags before reading credentials or contacting Matrix", async () => {
  const previous = process.argv;
  try {
    for (const flag of ["--thread-root", "--expect-thread"]) {
      process.argv = ["node", "sender", flag, "$root"];
      for (const sender of [plainSender, encryptedSender]) {
        await assert.rejects(sender({ readEnvironment: () => assert.fail("environment read") }), /room sender/u);
      }
    }
  } finally {
    process.argv = previous;
  }
});

test("thread entry points use dedicated setup, cleanup, paths and explicit harness mode", async () => {
  for (const label of ["plaintext", "encrypted"]) {
    for (const suffix of ["test", "test-activity"]) {
      const script = await readFile(new URL(`../thread-sessions/${label}-${suffix}.sh`, import.meta.url), "utf8");
      for (const part of [
        `THREAD_${label.toUpperCase()}_ENVIRONMENT_FILE`,
        `${label}-environment.json`,
        `${label}-cleanup.mjs`,
        `${label}-setup.sh`,
      ])
        assert(script.includes(part));
      assert(!script.includes("E2E_RESPONSE_MODE"));
    }
    for (const name of ["sender", "activity-wire"]) {
      const wrapper = await readFile(new URL(`../thread-sessions/${label}-${name}.mjs`, import.meta.url), "utf8");
      assert(wrapper.includes("threadMode: true"));
      assert(wrapper.includes(`../e2e-support/${label}-${name}.mjs`));
    }
    const cleanup = await readFile(new URL(`../thread-sessions/${label}-cleanup.mjs`, import.meta.url), "utf8");
    assert(cleanup.includes("e2e-session-ids.json"), "detached reset sessions must be cleaned up");
  }
});

test("relocated plaintext scenario retains restart/reset isolation assertions", async () => {
  const runner = await readFile(new URL("../thread-sessions/plaintext-run.mjs", import.meta.url), "utf8");
  for (const assertion of [
    "restart eagerly loaded thread sessions",
    "restart did not lazily load only the requested thread",
    "resetting the first thread changed the second thread's session",
    "thread reset reused its previous ACP session",
    "unknown thread loaded an ACP session",
  ])
    assert(runner.includes(assertion));
  assert(runner.includes("durable sessionless identity"));
});

test("cleanup wrapper shares an absolute environment path across setup, runner, and failure cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "thread-suite-shell-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "calls");
  const setup = join(directory, "setup.sh");
  await writeFile(
    setup,
    '#!/bin/sh\nprintf "%s\\n" "$THREAD_TEST_ENVIRONMENT_FILE" > "$CALLS"\nprintf "{}" > "$THREAD_TEST_ENVIRONMENT_FILE"\n',
    { mode: 0o700 },
  );
  // No real Node child, credentials, provisioning, or network operations.
  await writeFile(
    join(directory, "node"),
    '#!/bin/sh\nprintf "%s\\n" "$2" >> "$CALLS"\ncase "$1" in */runner.mjs) exit 7;; esac\n',
    { mode: 0o700 },
  );
  await assert.rejects(
    promisify(execFile)(
      join(repoRoot, "agent_tests/e2e-support/run-with-cleanup.sh"),
      [
        "THREAD_TEST_ENVIRONMENT_FILE",
        "unused-default.json",
        relative(repoRoot, join(directory, "cleanup.mjs")),
        relative(repoRoot, setup),
        relative(repoRoot, join(directory, "runner.mjs")),
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          CALLS: log,
          THREAD_TEST_ENVIRONMENT_FILE: "relative-environment.json",
        },
      },
    ),
    (error) => error.code === 7,
  );
  const calls = await readFile(log, "utf8");
  assert.deepEqual(
    calls.trim().split("\n"),
    Array.from({ length: 3 }, () => join(directory, "relative-environment.json")),
  );
});
