import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { readMatrixRetryAfterMs } from "../../dist/matrix-retry.js";

export async function createUnknownThreadRoot(environment, bridgeToken, request = fetch, wait = setTimeout) {
  const roomPath = encodeURIComponent(environment.roomId);
  const transactionId = `mab_unknown_root_${randomBytes(16).toString("hex")}`;
  const url = `${environment.homeserver}/_matrix/client/v3/rooms/${roomPath}/send/m.room.message/${transactionId}`;
  const deadline = Date.now() + 180_000;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await request(url, {
      method: "PUT",
      headers: { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "m.text", body: "Unknown thread root fixture." }),
      signal: AbortSignal.timeout(35_000),
    });
    const body = (await response.json?.().catch(() => ({}))) ?? {};
    if (response.status === 429 && attempt < 2) {
      const delay = readMatrixRetryAfterMs({ data: body, headers: response.headers }, Date.now());
      if (delay !== undefined && Date.now() + delay < deadline) {
        await wait(Math.max(delay, 1));
        continue;
      }
    }
    if (!response.ok) throw new Error(`Unknown thread root creation failed: HTTP ${response.status}`);
    if (typeof body.event_id !== "string" || body.event_id.length === 0)
      throw new Error("Unknown thread root creation did not return an event ID");
    return body.event_id;
  }
}
