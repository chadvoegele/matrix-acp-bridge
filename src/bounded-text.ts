/** Bound UTF-8 text without splitting a Unicode code point. */
export function takeBytes(
  value: string,
  limit: number,
  fromEnd = false,
): { text: string; cut: boolean } {
  if (Buffer.byteLength(value, "utf8") <= limit)
    return { text: value, cut: false };
  let bytes = 0;
  const characters: string[] = [];
  const source = fromEnd ? [...value].reverse() : value;
  for (const character of source) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > limit) break;
    characters.push(character);
    bytes += size;
  }
  if (fromEnd) characters.reverse();
  return { text: characters.join(""), cut: true };
}
