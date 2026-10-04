import { resolve } from "node:path";
import { deviceId, provisionEnvironment, required } from "./common.mjs";

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
  const roomId = process.env.UNENCRYPTED_E2E_ROOM_ID ?? required("E2E_ROOM_ID");
  const bridgeUserId = required("E2E_BRIDGE_USER_ID");
  const senderUserId = required("E2E_SENDER_USER_ID");
  const authMode = selectAuthMode();
  const bridgeAuthentication = roleAuthentication("bridge", authMode);
  const senderAuthentication = roleAuthentication("sender", authMode);
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
        deviceId: deviceId("MABPLAINB"),
        ...bridgeAuthentication,
        displayName: "Matrix ACP plaintext E2E bridge",
        state: true,
        config: true,
      },
      {
        name: "sender",
        userId: senderUserId,
        deviceId: deviceId("MABPLAINS"),
        ...senderAuthentication,
        displayName: "Matrix ACP plaintext E2E sender",
      },
    ],
    makeConfig,
    responseMode,
    transport: "plaintext",
    message: "Prepared two private Matrix test devices.",
  });
}
