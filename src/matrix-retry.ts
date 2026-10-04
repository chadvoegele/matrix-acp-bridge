import { clampTimerMilliseconds } from "./clock.js";
import { isRecord, numberProperty, stringProperty } from "./object-validation.js";
import type { MatrixFailureClassification } from "./matrix-client.js";

/** Read server timing hints without retaining headers or exposing error content. */
export function readMatrixRetryAfterMs(error: unknown, now: number): number | undefined {
  if (!isRecord(error)) return;
  const direct = numberProperty(error, "retryAfterMs");
  if (direct !== undefined && direct >= 0) return direct;
  // HTTP timing takes precedence over deprecated JSON hints. Parse dates
  // here so SDK getters cannot substitute their wall clock for the caller's.
  const header = readRetryAfterHeader(error.httpHeaders ?? error.headers, now);
  if (header !== undefined) return header;
  if (typeof error.getRetryAfterMs === "function") {
    try {
      const hint = error.getRetryAfterMs.call(error) as unknown;
      if (typeof hint === "number" && Number.isFinite(hint) && hint >= 0) return hint;
    } catch {
      // Invalid SDK hints fall through to deprecated JSON hints.
    }
  }
  const legacy = numberProperty(error, "retry_after_ms");
  if (legacy !== undefined && legacy >= 0) return legacy;
  const data = numberProperty(error.data, "retry_after_ms");
  return data !== undefined && data >= 0 ? data : undefined;
}

function readRetryAfterHeader(headers: unknown, now: number): number | undefined {
  if (!isRecord(headers) || typeof headers.get !== "function") return;
  try {
    const header = headers.get.call(headers, "Retry-After") as unknown;
    if (typeof header !== "string" || header.length === 0) return;
    if (/^\d+$/u.test(header)) {
      const seconds = Number(header);
      return Number.isSafeInteger(seconds) ? seconds * 1000 : undefined;
    }
    const timestamp = Date.parse(header);
    return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - now);
  } catch {
    return;
  }
}

function readBooleanProperty(value: unknown, ...names: readonly string[]): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }
  return undefined;
}

function normalizeFailureClassification(value: unknown): MatrixFailureClassification | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value.failure ?? value.classification ?? value;
  if (!isRecord(candidate)) {
    return undefined;
  }
  const kind = candidate.kind;
  const retryable = candidate.retryable;
  if ((kind !== "transient" && kind !== "permanent") || typeof retryable !== "boolean") {
    return undefined;
  }
  const retryAfterMs = numberProperty(candidate, "retryAfterMs", "retry_after_ms");
  const sdkRetryable = readBooleanProperty(candidate, "sdkRetryable", "sdk_retryable") ?? false;
  const httpStatus = numberProperty(candidate, "httpStatus", "status", "statusCode");
  const errcode = stringProperty(candidate, "errcode", "errorCode");
  return {
    kind,
    retryable,
    sdkRetryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(errcode === undefined ? {} : { errcode }),
  };
}

export function classifyDeliveryFailure(error: unknown, now: number): MatrixFailureClassification {
  const explicit = normalizeFailureClassification(error);
  if (explicit !== undefined) {
    return explicit;
  }

  const status = numberProperty(error, "httpStatus", "status", "statusCode");
  const effectiveRetryAfter = readMatrixRetryAfterMs(error, now);
  const data = isRecord(error) ? error.data : undefined;
  const transientStatus = status === 408 || status === 429 || (status !== undefined && status >= 500 && status < 600);
  const code = stringProperty(error, "code");
  const name = stringProperty(error, "name");
  const message = stringProperty(error, "message")?.toLowerCase() ?? "";
  const networkFailure =
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    message.includes("network") ||
    message.includes("socket") ||
    message.includes("connection") ||
    message.includes("fetch") ||
    message.includes("timed out");
  const sdkRetryable = readBooleanProperty(error, "sdkRetryable", "isRetryable", "retryable") === true;
  const errcode = stringProperty(error, "errcode", "errorCode") ?? stringProperty(data, "errcode") ?? name;
  const permanentStatus = status !== undefined && status >= 300 && status < 500 && status !== 408 && status !== 429;
  const permanentCode =
    errcode !== undefined &&
    ["M_UNKNOWN_TOKEN", "M_MISSING_TOKEN", "M_UNAUTHORIZED", "M_FORBIDDEN", "M_TOO_LARGE"].includes(errcode);
  const retryable = !permanentStatus && !permanentCode && (transientStatus || networkFailure || sdkRetryable);
  return {
    kind: retryable ? "transient" : "permanent",
    retryable,
    sdkRetryable,
    ...(effectiveRetryAfter === undefined ? {} : { retryAfterMs: effectiveRetryAfter }),
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(errcode === undefined ? {} : { errcode }),
  };
}

export function calculateRetryDelay(
  failure: MatrixFailureClassification,
  attempt: number,
  random: () => number,
): number {
  const retryCapsMs = [1000, 2000, 4000, 8000, 16_000, 30_000] as const;
  if (failure.retryAfterMs !== undefined && Number.isFinite(failure.retryAfterMs)) {
    return clampTimerMilliseconds(Math.max(0, failure.retryAfterMs));
  }
  const cap = retryCapsMs[Math.min(attempt, retryCapsMs.length - 1)] ?? retryCapsMs.at(-1)!;
  let sample = 0.5;
  try {
    sample = random();
  } catch {
    sample = 0.5;
  }
  if (!Number.isFinite(sample)) {
    sample = 0.5;
  }
  return Math.floor(cap * Math.min(1, Math.max(0, sample)));
}
