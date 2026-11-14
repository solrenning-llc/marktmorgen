/**
 * Writing calendar files: the three small rules of the format that every
 * file we make follows — the booking invite each buyer and creator gets
 * (lib/calls.ts) and the subscription address that lists a store's bookings
 * (lib/calendar-sync.ts). Kept in one place so both files are escaped,
 * timed and folded the same way.
 */

/**
 * A text value, with the characters the format reserves escaped. A line break
 * of any kind (CRLF, LF or a lone CR) becomes the format's \n: TEXT may hold
 * no control character, and a raw CR would start a new property for a parser
 * that splits lines on it.
 */
export function icsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** An instant in UTC, as the format writes it: 20260926T140000Z. */
export function icsTime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Folds a line at 75 bytes, as the calendar format requires. */
export function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = "";
  for (const char of line) {
    const next = current + char;
    if (new TextEncoder().encode(next).length > (out.length ? 74 : 75)) {
      out.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  out.push(current);
  return out.join("\r\n ");
}
