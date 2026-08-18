import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readEnvironment as readSharedEnvironment,
  readToken,
} from "../e2e-support/common.mjs";

export const testDir = dirname(fileURLToPath(import.meta.url));
export const defaultEnvironmentPath = join(testDir, "environment.json");


export const readEnvironment = (path = defaultEnvironmentPath) => readSharedEnvironment(path, {
  roleKeys: {
    bridge: ["userId", "deviceId", "tokenFile", "stateDir", "configFile"],
    helper: ["userId", "deviceId", "tokenFile", "stateDir", "configFile"],
    sender: ["userId", "deviceId", "tokenFile", "stateDir", "configFile"],
  },
});

export function cryptoPaths(stateDir) {
  return {
    databasePath: join(stateDir, "matrix-crypto"),
    manifestPath: join(stateDir, "crypto-state.json"),
  };
}

export function matrixConfig(environment, role) {
  const identity = environment[role];
  const otherUser = role === "sender" ? environment.bridge.userId : environment.sender.userId;
  return {
    homeserver: environment.homeserver,
    userId: identity.userId,
    deviceId: identity.deviceId,
    accessTokenFile: identity.tokenFile,
    allowedRooms: [environment.roomId],
    allowedSenders: [otherUser],
    encryption: "required",
  };
}

export async function createAdapter(environment, role) {
  const [{ createMatrixClientAdapter }, token] = await Promise.all([
    import("../../dist/matrix-client.js"),
    readToken(environment[role].tokenFile),
  ]);
  const adapter = createMatrixClientAdapter(matrixConfig(environment, role), token);
  await adapter.validateIdentity();
  await adapter.initializeCrypto(cryptoPaths(environment[role].stateDir));
  return adapter;
}

export function tomlString(value) {
  return JSON.stringify(value);
}

export function makeConfig(environment, role) {
  const identity = environment[role];
  const allowedSender = role === "sender" ? environment.bridge.userId : environment.sender.userId;
  return `state_dir = ${tomlString(identity.stateDir)}

[matrix]
homeserver = ${tomlString(environment.homeserver)}
user_id = ${tomlString(identity.userId)}
device_id = ${tomlString(identity.deviceId)}
access_token_file = ${tomlString(identity.tokenFile)}
allowed_rooms = [${tomlString(environment.roomId)}]
allowed_senders = [${tomlString(allowedSender)}]
encryption = "required"

[acp]
cwd = ${tomlString(environment.acpCwd)}

[limits]
startup_timeout_seconds = 120
shutdown_grace_seconds = 30
`;
}

export {repoRoot, writePrivateFile, readToken} from "../e2e-support/common.mjs";
