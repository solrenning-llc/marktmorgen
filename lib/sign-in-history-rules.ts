/**
 * The creator's sign-in history (630 [HN6], item 33, unit 1; added
 * 3 November 2026): the rules, browser-safe. Writing an entry at each
 * sign-in (lib/auth.ts noteSignIn, which already tells the creator about a
 * new browser), the list in the studio beside "Sign out everywhere" (already
 * there, app/api/auth/signout-all), and the privacy policy's sentence are the
 * next unit; keeping the list needs a key family of its own
 * (lib/data-families.ts).
 *
 *   - Each entry says when, how the creator signed in (the way lib/auth.ts
 *     names), the second step used (lib/two-step.ts: a code from the app, a
 *     recovery code, or none; a passkey is its own check), the browser as
 *     browserName says it ("Chrome on macOS", never the full user agent) and
 *     the approximate place the hosting's own headers give (a city and a
 *     country, cleaned; never the IP address, which is not kept).
 *   - At most MAX_SIGN_INS entries, newest first, each kept SIGN_IN_DAYS:
 *     enough to see a sign-in that was not yours, small enough to hold
 *     little about the creator.
 *   - Only the creator sees it, in their own studio; nothing of it is sent
 *     anywhere or shown to a team member about another person.
 */
import type { SignInWay } from "@/lib/auth";

export const MAX_SIGN_INS = 20;
export const SIGN_IN_DAYS = 90;
const DAY = 86_400_000;

export type SecondStep = "code" | "recovery" | "none";
export type SignInEntry = { at: number; way: SignInWay; second: SecondStep; device: string; place: string };

const WAYS: readonly SignInWay[] = ["link", "passkey", "invitation", "google"];
const SECONDS: readonly SecondStep[] = ["code", "recovery", "none"];

/**
 * The approximate place, from the hosting's headers (on Vercel,
 * x-vercel-ip-city, URL-encoded, and x-vercel-ip-country): "Fortaleza, BR",
 * "BR" with no city, "" with neither. Only letters, marks, spaces, dots,
 * apostrophes and hyphens in a city of up to 60 characters; a country of two
 * capital letters. Anything else is left out, never guessed.
 */
export function placeFrom(city: string | null | undefined, country: string | null | undefined): string {
  let name = "";
  if (city) {
    try {
      name = decodeURIComponent(city);
    } catch {
      name = "";
    }
    name = name.normalize("NFC").replace(/\s+/g, " ").trim();
    if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’-]{0,59}$/u.test(name)) name = "";
  }
  const code = typeof country === "string" && /^[A-Z]{2}$/.test(country.trim()) ? country.trim() : "";
  return name && code ? `${name}, ${code}` : name || code;
}

/** An entry as it may be kept, or null: anything that does not read as one is dropped. */
export function readEntry(raw: unknown): SignInEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.at !== "number" || !Number.isSafeInteger(v.at) || v.at <= 0) return null;
  if (!WAYS.includes(v.way as SignInWay) || !SECONDS.includes(v.second as SecondStep)) return null;
  const device = typeof v.device === "string" && /^[A-Za-z ]{1,40}$/.test(v.device) ? v.device : "";
  if (!device) return null;
  // Kept only in the shape placeFrom writes: "City, CC", "CC" or a city alone.
  const place = typeof v.place === "string" && PLACE.test(v.place) ? v.place : "";
  return { at: v.at, way: v.way as SignInWay, second: v.second as SecondStep, device, place };
}

const PLACE = /^(?:[\p{L}\p{M}][\p{L}\p{M} .'’-]{0,59}(?:, [A-Z]{2})?|[A-Z]{2})$/u;

/** The list once a new sign-in is added: newest first, none older than SIGN_IN_DAYS, at most MAX_SIGN_INS. */
export function withSignIn(list: readonly unknown[], entry: SignInEntry, now: number): SignInEntry[] {
  const kept = list.map(readEntry).filter((e): e is SignInEntry => e !== null && now - e.at <= SIGN_IN_DAYS * DAY && e.at <= now + 60_000);
  return [entry, ...kept].sort((a, b) => b.at - a.at).slice(0, MAX_SIGN_INS);
}

const WAY_WORDS: Record<SignInWay, string> = {
  link: "with a login link",
  passkey: "with a passkey",
  invitation: "by accepting a team invitation",
  google: "with Google",
};
const SECOND_WORDS: Record<SecondStep, string> = {
  code: " and a code from your authenticator app",
  recovery: " and a recovery code",
  none: "",
};

/** One line of the list in the studio, in the creator's time zone (UTC when that is not one). */
export function entryWords(entry: SignInEntry, timeZone: string): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: zone }).format(entry.at);
  let when: string;
  try {
    when = format(timeZone);
  } catch {
    when = format("UTC");
  }
  return [when, entry.device, entry.place || "place unknown", `${WAY_WORDS[entry.way]}${SECOND_WORDS[entry.second]}`].join(" · ");
}
