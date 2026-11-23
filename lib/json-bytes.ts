/**
 * Shared with lib/list-download.ts (a list file and the buyers audience) and
 * app/api/store/forms/export (a form's answers as a file): it imports nothing,
 * so a route can measure what a read moved without the list's modules.
 */
/**
 * The most bytes `value` takes written as JSON, as the database's answer
 * writes it: every character at its widest (a control character, a <, > or &,
 * or a line or paragraph separator escaped in six; a quote or a backslash in
 * two; a lone surrogate in six), so what a read moved is never counted short.
 */
export function jsonBytes(value: unknown): number {
  if (typeof value === "string") {
    let n = 2;
    for (let i = 0; i < value.length; i += 1) {
      const c = value.charCodeAt(i);
      if (c < 0x20 || c === 0x26 || c === 0x3c || c === 0x3e || c === 0x2028 || c === 0x2029) n += 6;
      else if (c === 0x22 || c === 0x5c) n += 2;
      else if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
        n += 4;
        i += 1;
      } else if (c >= 0xd800 && c <= 0xdfff) n += 6;
      else n += 3;
    }
    return n;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) return value.reduce((sum: number, v) => sum + jsonBytes(v) + 1, 2);
  if (value && typeof value === "object") return Object.entries(value).reduce((sum, [k, v]) => sum + jsonBytes(k) + jsonBytes(v) + 2, 2);
  return 4;
}
