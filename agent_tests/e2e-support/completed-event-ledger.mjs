import { MAX_COMPLETED_EVENT_IDS_PER_ROOM } from "../../dist/bridge-state.js";

export function assertCompletedEventLedger(ids, label) {
  if (
    !Array.isArray(ids) ||
    !ids.every((id) => typeof id === "string" && id.length > 0) ||
    new Set(ids).size !== ids.length ||
    ids.length > MAX_COMPLETED_EVENT_IDS_PER_ROOM
  ) {
    throw new Error(`${label} completed-ID ledger is missing, invalid, duplicate, or unbounded`);
  }
  return ids;
}
