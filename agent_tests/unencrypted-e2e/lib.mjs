import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readEnvironment as readSharedEnvironment,
} from "../e2e-support/common.mjs";

export const testDir = dirname(fileURLToPath(import.meta.url));
export const defaultEnvironmentPath = join(testDir, "environment.json");


export const readEnvironment = (path = defaultEnvironmentPath) => readSharedEnvironment(path, {
  roleKeys: {
    bridge: ["userId", "deviceId", "tokenFile", "stateDir", "configFile"],
    sender: ["userId", "deviceId", "tokenFile"],
  },
});

export function makeConfig(environment) {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- helper is local to config rendering
  const string = (value) => JSON.stringify(value);
  return `state_dir = ${string(environment.bridge.stateDir)}

[matrix]
homeserver = ${string(environment.homeserver)}
user_id = ${string(environment.bridge.userId)}
device_id = ${string(environment.bridge.deviceId)}
access_token_file = ${string(environment.bridge.tokenFile)}
allowed_rooms = [${string(environment.roomId)}]
allowed_senders = [${string(environment.sender.userId)}]
encryption = "disabled"

[acp]
cwd = ${string(environment.acpCwd)}

[limits]
startup_timeout_seconds = 120
shutdown_grace_seconds = 30
`;
}

export {readToken, repoRoot, writePrivateFile} from "../e2e-support/common.mjs";
