export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
