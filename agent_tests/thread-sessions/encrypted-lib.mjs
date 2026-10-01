import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeConfig as makeRoomConfig, readEnvironment as readRoomEnvironment } from "../encrypted-e2e/lib.mjs";

export const testDir = dirname(fileURLToPath(import.meta.url));

export const defaultEnvironmentPath = join(testDir, "encrypted-environment.json");

export const readEnvironment = (path = defaultEnvironmentPath) => readRoomEnvironment(path);

export function makeConfig(environment, role) {
  const config = makeRoomConfig(environment, role);
  return role === "bridge" ? config.replace('response_mode = "room"', 'response_mode = "thread"') : config;
}

export { readToken, repoRoot, writePrivateFile, createAdapter } from "../encrypted-e2e/lib.mjs";
