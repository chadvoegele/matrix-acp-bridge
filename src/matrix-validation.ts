export function isSafeHomeserver(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- homeserver values reject ASCII controls
  if (value.length === 0 || /\s/u.test(value) || value.includes("\\") || /[\u0000-\u001F\u007F]/u.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      !value.includes("?") &&
      !value.includes("#") &&
      url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function isMatrixId(value: string, prefix: "@" | "!"): boolean {
  const separator = value.indexOf(":", 1);
  if (value.length === 0 || value[0] !== prefix || separator <= 1) {
    return false;
  }
  const localpart = value.slice(1, separator);
  const serverName = value.slice(separator + 1);
  // eslint-disable-next-line no-control-regex -- Matrix localparts reject ASCII controls
  return /^[^\s\u0000-\u001F\u007F:[\],]+$/u.test(localpart) && isMatrixServerName(serverName);
}

export function isMatrixServerName(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  const hostname = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?`;
  const match = new RegExp(`^(?:(${hostname})|\\[([0-9A-Fa-f:.]+)\\])(?::([0-9]{1,5}))?$`, "u").exec(value);
  return match !== null && (match[3] === undefined || Number(match[3]) <= 65_535);
}

export function isValidMatrixEventId(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("$") || value.length < 2) {
    return false;
  }

  // Event IDs are opaque across room versions. Keep validation to the common
  // client-facing constraints so historical and modern forms remain valid.
  if (Buffer.byteLength(value, "utf8") > 255) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1F ||
      codePoint === 0x7F ||
      (codePoint >= 0x80 && codePoint <= 0x9F) ||
      (codePoint >= 0xD8_00 && codePoint <= 0xDF_FF) ||
      /\s/u.test(character)
    ) {
      return false;
    }
  }
  return true;
}

export function isValidMatrixDeviceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._=-]+$/u.test(value);
}
