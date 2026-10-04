import { randomBytes } from "node:crypto";

export async function createUnknownThreadRoot(environment, bridgeToken, request = fetch) {
  const roomPath = encodeURIComponent(environment.roomId);
  const transactionId = `mab_unknown_root_${randomBytes(16).toString("hex")}`;
  const response = await request(
    `${environment.homeserver}/_matrix/client/v3/rooms/${roomPath}/send/m.room.message/${transactionId}`,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "m.text", body: "Unknown thread root fixture." }),
      signal: AbortSignal.timeout(35_000),
    },
  );
  if (!response.ok) throw new Error(`Unknown thread root creation failed: HTTP ${response.status}`);
  const body = await response.json();
  if (typeof body.event_id !== "string" || body.event_id.length === 0) {
    throw new Error("Unknown thread root creation did not return an event ID");
  }
  return body.event_id;
}
