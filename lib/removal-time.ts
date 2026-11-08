/**
 * The moment a passkey waiting to be removed goes (lib/passkeys.ts
 * scheduleRemoval), in words: the day, the time and the time zone spelled
 * out, so nobody has to guess whether "Monday" is their Monday. The same
 * words in the email and on the studio page; nothing here reads the server.
 */
export function removalWhen(at: number): string {
  const when = new Date(at);
  const day = when.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const time = when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  return `${day}, at ${time} Coordinated Universal Time (UTC)`;
}
