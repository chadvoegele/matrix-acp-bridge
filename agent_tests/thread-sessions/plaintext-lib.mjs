import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeConfig as makeRoomConfig, readEnvironment as readRoomEnvironment } from "../unencrypted-e2e/lib.mjs";

export const testDir = dirname(fileURLToPath(import.meta.url));

export const defaultEnvironmentPath = join(testDir, "plaintext-environment.json");

export const readEnvironment = (path = defaultEnvironmentPath) => readRoomEnvironment(path);

export function makeConfig(environment) {
  const config = makeRoomConfig(environment);
  return config.replace('response_mode = "room"', 'response_mode = "thread"');
}

export { readToken, repoRoot, writePrivateFile } from "../unencrypted-e2e/lib.mjs";
