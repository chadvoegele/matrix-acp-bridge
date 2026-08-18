#!/usr/bin/env node
import { resolve } from "node:path";

import {
  deviceId,
  provisionEnvironment,
  repoRoot,
  required,
  runCommand,
} from "../e2e-support/common.mjs";
import { defaultEnvironmentPath, makeConfig, testDir } from "./lib.mjs";

const homeserver = required("E2E_HOMESERVER").replace(/\/$/u, "");
const roomId = required("E2E_ROOM_ID");
const bridgeUserId = required("E2E_BRIDGE_USER_ID");
const senderUserId = required("E2E_SENDER_USER_ID");
const bridgePassword = required("E2E_BRIDGE_PASSWORD");
const senderPassword = required("E2E_SENDER_PASSWORD");
const acpCwd = resolve(process.env.E2E_ACP_CWD ?? "/tmp");
const acpCommand = JSON.parse(required("E2E_ACP_COMMAND"));
const privateRoot = resolve(process.env.E2E_PRIVATE_ROOT ?? `${testDir}/private`);
const environmentPath = resolve(process.env.E2E_ENVIRONMENT_FILE ?? defaultEnvironmentPath);

await provisionEnvironment({
  homeserver,
  roomId,
  acpCwd,
  acpCommand,
  privateRoot,
  environmentPath,
  roles: [
    {
      name: "bridge",
      userId: bridgeUserId,
      deviceId: deviceId("MABE2EB"),
      password: bridgePassword,
      displayName: "Matrix ACP E2E bridge",
      state: true,
      config: true,
    },
    {
      name: "helper",
      userId: bridgeUserId,
      deviceId: deviceId("MABE2EH"),
      password: bridgePassword,
      displayName: "Matrix ACP E2E SAS helper",
      state: true,
      config: true,
    },
    {
      name: "sender",
      userId: senderUserId,
      deviceId: deviceId("MABE2ES"),
      password: senderPassword,
      displayName: "Matrix ACP E2E sender",
      state: true,
      config: true,
    },
  ],
  makeConfig,
  afterProvision: async (environment) => {
    for (const role of ["bridge", "helper", "sender"]) {
      await runCommand(process.execPath, [
        `${repoRoot}/dist/main.js`,
        "--config",
        environment[role].configFile,
        "crypto",
        "bootstrap",
      ]);
    }
  },
  message: "Provisioned three private Matrix test devices.",
});
