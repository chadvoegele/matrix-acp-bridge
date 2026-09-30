export type JsonRecord = { readonly [key: string]: unknown };

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

export function stringProperty(value: unknown, ...names: readonly string[]): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

export function numberProperty(value: unknown, ...names: readonly string[]): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
