import type { ResolveHook } from "node:module";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";

const MATRIX_SDK_PATH_MARKER = `${sep}node_modules${sep}matrix-js-sdk${sep}`;

interface ErrorWithCode {
  readonly code?: unknown;
}

function isRecord(value: unknown): value is ErrorWithCode {
  return typeof value === "object" && value !== null;
}

function isResolutionError(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return value.code === "ERR_MODULE_NOT_FOUND" || value.code === "ERR_UNSUPPORTED_DIR_IMPORT";
}

function isMatrixSdkModule(url: string | undefined): boolean {
  if (url === undefined || !url.startsWith("file:")) {
    return false;
  }
  try {
    return fileURLToPath(url).includes(MATRIX_SDK_PATH_MARKER);
  } catch {
    return false;
  }
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function withPathSuffix(specifier: string, suffix: string): string {
  const queryOrFragment = specifier.search(/[?#]/u);
  if (queryOrFragment < 0) {
    return `${specifier}${suffix}`;
  }
  return `${specifier.slice(0, queryOrFragment)}${suffix}${specifier.slice(queryOrFragment)}`;
}

/**
 * matrix-js-sdk 42.0.0 has two extensionless relative imports in its
 * published ESM OAuth modules. Node's strict ESM resolver does not infer a
 * directory's index.js, so retry only those SDK-internal resolutions with the
 * explicit targets the package intended.
 */
export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      !isMatrixSdkModule(context.parentURL) ||
      !isRelativeSpecifier(specifier) ||
      !isResolutionError(error)
    ) {
      throw error;
    }

    for (const candidate of [
      withPathSuffix(specifier, "/index.js"),
      withPathSuffix(specifier, ".js"),
    ]) {
      try {
        return await nextResolve(candidate, context);
      } catch (candidateError) {
        if (!isResolutionError(candidateError)) {
          throw candidateError;
        }
      }
    }
    throw error;
  }
};
