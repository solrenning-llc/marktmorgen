/** The name shown as an email's sender (placeholder: the behavior before the fix). */
export function safeSenderName(name: string, fallback: string): string {
  return name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || fallback;
}
