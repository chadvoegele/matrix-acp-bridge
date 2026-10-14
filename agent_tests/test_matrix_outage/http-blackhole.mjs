// Test-only fetch boundary: no production service or network rules are changed.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

const originalFetch = globalThis.fetch;
const flag = process.env.MATRIX_OUTAGE_FLAG;
if (!flag) throw new Error("MATRIX_OUTAGE_FLAG is required");
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const isSend = url.pathname.includes("/send/");
  const blocked = existsSync(flag);
  const transaction = isSend ? createHash("sha256").update(url.pathname).digest("hex") : undefined;
  const report = (stage) => {
    if (isSend)
      process.stderr.write(
        `${JSON.stringify({ event: "outage-http-send", stage, blocked, transaction, time: Date.now() })}\n`,
      );
  };
  report("start");
  try {
    if (!blocked) {
      const response = await originalFetch(input, init);
      report("response");
      return response;
    }
    // A dropped request before headers stays pending until the SDK aborts it.
    // Restoring connectivity does not resolve abandoned requests.
    return await new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("SDK request lacks an abort signal");
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  } catch (error) {
    report("reject");
    throw error;
  }
};
