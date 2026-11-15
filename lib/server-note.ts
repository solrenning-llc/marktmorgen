/**
 * What to tell a person when a request was refused: the server's own sentence
 * when its reply carries one (for example, a studio whose monthly requests are
 * used up), otherwise the caller's general sentence. Never an empty line.
 */
export function serverNote(reply: unknown, fallback: string): string {
  const message = reply && typeof reply === "object" ? (reply as { message?: unknown }).message : undefined;
  return typeof message === "string" && message.trim() ? message.trim() : fallback;
}
