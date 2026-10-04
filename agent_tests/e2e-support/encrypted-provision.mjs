import { resolve } from "node:path";
import { deviceId, provisionEnvironment, repoRoot, required, runCommand } from "./common.mjs";

import { roleAuthentication, selectAuthMode } from "./auth.mjs";

export async function provisionHarness({
  defaultEnvironmentPath,
  makeConfig,
  testDir,
  environmentVariable,
  privateRootVariable,
  privateRootSuffix = "private",
  responseMode = "room",
}) {
  const homeserver = required("E2E_HOMESERVER").replace(/\/$/u, "");
  const roomId = required("E2E_ROOM_ID");
  const bridgeUserId = required("E2E_BRIDGE_USER_ID");
  const senderUserId = required("E2E_SENDER_USER_ID");
  const authMode = selectAuthMode();
  const bridgeAuthentication = roleAuthentication("bridge", authMode);
  const senderAuthentication = roleAuthentication("sender", authMode);
  const helperAuthentication = roleAuthentication("helper", authMode);
  const acpCwd = resolve(process.env.E2E_ACP_CWD ?? "/tmp");
  const acpCommand = JSON.parse(required("E2E_ACP_COMMAND"));
  const privateRoot = resolve(process.env[privateRootVariable] ?? `${testDir}/${privateRootSuffix}`);
  const environmentPath = resolve(process.env[environmentVariable] ?? defaultEnvironmentPath);

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
        ...bridgeAuthentication,
        displayName: "Matrix ACP E2E bridge",
        state: true,
        config: true,
      },
      {
        name: "helper",
        userId: bridgeUserId,
        deviceId: deviceId("MABE2EH"),
        ...helperAuthentication,
        displayName: "Matrix ACP E2E SAS helper",
        state: true,
        config: true,
      },
      {
        name: "sender",
        userId: senderUserId,
        deviceId: deviceId("MABE2ES"),
        ...senderAuthentication,
        displayName: "Matrix ACP E2E sender",
        state: true,
        config: true,
      },
    ],
    makeConfig,
    responseMode,
    transport: "encrypted",
    afterProvision: async (environment) => {
      for (const role of ["bridge", "helper", "sender"]) {
        if (environment[role].ownership === "reusable") continue;
        await runCommand(process.execPath, [
          `${repoRoot}/dist/main.js`,
          "--config",
          environment[role].configFile,
          "crypto",
          "bootstrap",
        ]);
      }
    },
    message: "Prepared three private Matrix test devices.",
  });
}
