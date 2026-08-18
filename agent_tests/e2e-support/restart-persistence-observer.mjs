import { readFileSync } from "node:fs";

function hasOwn(value, property) {
  return value !== null && typeof value === "object" && Object.hasOwn(value, property);
}

function normalizeLoadOutcome(message) {
  if (hasOwn(message, "result")) return { kind: "success" };
  if (hasOwn(message, "error")) {
    const code = message.error?.code;
    return Number.isInteger(code) ? { kind: "error", code } : { kind: "error" };
  }
  return { kind: "invalid" };
}

export function describeLoadFailure(outcome) {
  if (outcome === undefined) return "session/load response was not observed";
  if (outcome.kind === "error") {
    return outcome.code === undefined
      ? "session/load returned a JSON-RPC error without a numeric code"
      : `session/load returned JSON-RPC error code ${outcome.code}`;
  }
  return "session/load response did not contain a result";
}

export function createRestartPersistenceObserver({ statePath } = {}) {
  const requests = [];
  const stateAtPrompts = [];
  const pending = new Map();
  let loadSession;
  let loadOutcome;
  let newSessionId;
  let sequence = 0;
  return {
    outbound(message) {
      if (typeof message?.method !== "string") return;
      const request = { sequence: sequence++, method: message.method, params: message.params };
      requests.push(request);
      if (message.method === "session/prompt" && statePath !== undefined) {
        try { stateAtPrompts.push(JSON.parse(readFileSync(statePath, "utf8"))); }
        catch { stateAtPrompts.push(undefined); }
      }
      if (message.id !== undefined) pending.set(message.id, request);
    },
    inbound(message) {
      const request = pending.get(message?.id);
      if (request === undefined) return;
      pending.delete(message.id);
      if (request.method === "initialize") {
        loadSession = message.result?.agentCapabilities?.loadSession === true;
      } else if (request.method === "session/load") {
        loadOutcome = normalizeLoadOutcome(message);
      } else if (request.method === "session/new" && typeof message.result?.sessionId === "string") {
        newSessionId = message.result.sessionId;
      }
    },
    requests,
    stateAtPrompts,
    get loadSession() { return loadSession; },
    get loadOutcome() { return loadOutcome; },
    get newSessionId() { return newSessionId; },
  };
}
