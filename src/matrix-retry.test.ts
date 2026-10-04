import assert from "node:assert/strict";
import test from "node:test";
import { MatrixError } from "matrix-js-sdk";
import { classifyMatrixError } from "./matrix-client.js";
import { calculateRetryDelay, classifyDeliveryFailure, readMatrixRetryAfterMs } from "./matrix-retry.js";

void test("permanent HTTP and Matrix authentication failures override network text and retry flags", () => {
  for (const error of [
    { status: 401, message: "network connection failed", retryable: true },
    { status: 403, message: "fetch failed" },
    { status: 302, code: "ECONNRESET" },
    { data: { errcode: "M_UNKNOWN_TOKEN" }, code: "ETIMEDOUT" },
    { errcode: "M_FORBIDDEN", isRetryable: true },
    { name: "M_TOO_LARGE", message: "network failure" },
  ]) {
    assert.equal(classifyDeliveryFailure(error, 0).retryable, false);
  }
  for (const error of [{ status: 408 }, { status: 429 }, { status: 503 }, { code: "ECONNRESET" }]) {
    assert.equal(classifyDeliveryFailure(error, 0).retryable, true);
  }
});

void test("delivery respects normalized adapter classifications instead of guessing from their wrapper", () => {
  assert.equal(
    classifyDeliveryFailure({ failure: { kind: "permanent", retryable: false }, message: "network" }, 0).retryable,
    false,
  );
  assert.equal(
    classifyDeliveryFailure({ classification: { kind: "transient", retryable: true, retryAfterMs: 123 } }, 0)
      .retryAfterMs,
    123,
  );
});

void test("server retry hints fall back safely and dates use an explicit current time", () => {
  const now = Date.UTC(2020, 0, 1);
  const headers = new Headers({ "Retry-After": "Wed, 01 Jan 2020 00:00:02 GMT" });
  assert.equal(readMatrixRetryAfterMs({ headers }, now), 2000);
  assert.equal(readMatrixRetryAfterMs({ headers }, now + 3000), 0);
  assert.equal(readMatrixRetryAfterMs({ headers: new Headers({ "Retry-After": "3" }) }, now), 3000);
  assert.equal(readMatrixRetryAfterMs({ retryAfterMs: -1, data: { retry_after_ms: 20 } }, now), 20);
  assert.equal(readMatrixRetryAfterMs({ getRetryAfterMs: () => 50 }, now), 50);
  assert.equal(
    readMatrixRetryAfterMs(
      {
        getRetryAfterMs: () => {
          throw new Error("private");
        },
        headers,
      },
      now,
    ),
    2000,
  );
  for (const error of [
    null,
    { retryAfterMs: Number.NaN },
    { headers: new Headers({ "Retry-After": "invalid" }) },
    {
      headers: {
        get: () => {
          throw new Error("private");
        },
      },
    },
  ]) {
    assert.equal(readMatrixRetryAfterMs(error, now), undefined);
  }
});

void test("Retry-After overrides deprecated body hints for raw and SDK errors", () => {
  const now = Date.UTC(2020, 0, 1);
  const data = { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 1000 };
  const headers = new Headers({ "Retry-After": "60" });
  const sdkError = new MatrixError(data, 429, undefined, undefined, headers);
  assert.equal(readMatrixRetryAfterMs({ data, headers }, now), 60_000);
  assert.equal(readMatrixRetryAfterMs(sdkError, now), 60_000);
  assert.equal(classifyMatrixError(sdkError).retryAfterMs, 60_000);
  headers.set("Retry-After", "Wed, 01 Jan 2020 00:01:00 GMT");
  assert.equal(readMatrixRetryAfterMs(sdkError, now), 60_000);
  for (const value of ["invalid", ""]) {
    headers.set("Retry-After", value);
    assert.equal(readMatrixRetryAfterMs(sdkError, now), 1000);
  }
  headers.delete("Retry-After");
  assert.equal(readMatrixRetryAfterMs(sdkError, now), 1000);
});

void test("full jitter has bounded exponential caps and safe entropy fallback", () => {
  const failure = { kind: "transient", retryable: true, sdkRetryable: false } as const;
  assert.deepEqual(
    Array.from({ length: 8 }, (_, attempt) => calculateRetryDelay(failure, attempt, () => 1)),
    [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000],
  );
  assert.equal(
    calculateRetryDelay(failure, 0, () => -1),
    0,
  );
  assert.equal(
    calculateRetryDelay(failure, 0, () => 2),
    1000,
  );
  assert.equal(
    calculateRetryDelay(failure, 0, () => Number.NaN),
    500,
  );
  assert.equal(
    calculateRetryDelay(failure, 0, () => {
      throw new Error("entropy unavailable");
    }),
    500,
  );
  assert.equal(
    calculateRetryDelay({ ...failure, retryAfterMs: Number.MAX_SAFE_INTEGER }, 0, () => 0),
    2_147_483_647,
  );
});
