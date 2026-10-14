// Summarize bridge verification failures without exposing Matrix or ACP data.
const REASONS = new Set([
  "target_rejected",
  "method_rejected",
  "operator_rejected",
  "cancelled",
  "timeout",
  "protocol",
  "tty",
  "manifest",
  "attempt-failed",
  "verification-failed",
  "unknown",
  "database-invalid",
]);

export class SasBridgeDiagnostics {
  #pending = "";

  reason;

  lastEvent = "none";

  stdoutSeen = false;

  stderrSeen = false;

  accept(chunk) {
    this.stdoutSeen ||= chunk.length > 0;
    this.#pending += chunk.toString("utf8");
    while (this.#pending.includes("\n")) {
      const newline = this.#pending.indexOf("\n");
      this.#acceptLine(this.#pending.slice(0, newline));
      this.#pending = this.#pending.slice(newline + 1);
    }
    // Keep only a bounded tail if a subprocess emits an unterminated line.
    this.#pending = this.#pending.slice(-65_536);
  }

  finish() {
    this.#acceptLine(this.#pending);
    this.#pending = "";
  }

  #acceptLine(line) {
    // `script` runs the bridge in a PTY; strip its terminal escapes before parsing.
    const clean = line
      .replaceAll("\r", "")
      // eslint-disable-next-line no-control-regex -- strip terminal escape sequences
      .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
      .trim();
    let record;
    try {
      record = JSON.parse(clean);
    } catch {
      return;
    }
    if (record?.event === "crypto-verification-failed") {
      this.lastEvent = "crypto-verification-failed";
      this.reason = REASONS.has(record.fields?.reason) ? record.fields.reason : "unknown";
    } else if (record?.event === "startup-failed") {
      this.lastEvent = "startup-failed";
      this.reason = "startup";
    }
  }

  summary(code, signal) {
    const exit = Number.isSafeInteger(code) && code >= 0 && code <= 255 ? String(code) : "unknown";
    const safeSignal = signal === "SIGTERM" || signal === "SIGKILL" || signal === "SIGINT" ? signal : "none";
    return `exit=${exit}, signal=${safeSignal}, diagnostic=${this.lastEvent}, stdout=${this.stdoutSeen ? "seen" : "absent"}, stderr=${this.stderrSeen ? "seen" : "absent"}`;
  }
}
