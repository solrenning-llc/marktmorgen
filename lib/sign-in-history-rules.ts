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
 *     names, and apart from it the two ways that matter most to recognise:
 *     "rescue", the link to the recovery address that turned two-step login
 *     off, app/api/auth/rescue; and "locked", a session opened without the
 *     second step that is held back from everything LOCKED_NEEDS names,
 *     app/api/auth/lost/confirm and the code page's reset), the second step
 *     used (lib/two-step.ts: a code from the app, a recovery code, or none; a
 *     passkey is its own check), the browser as
 *     browserName says it ("Chrome on macOS", never the full user agent) and
 *     the approximate place the hosting's own headers give (a city and a
 *     country, cleaned; never the IP address, which is not kept).
 *   - At most MAX_SIGN_INS entries, newest first, none shown older than
 *     SIGN_IN_DAYS: enough to see a sign-in that was not yours, small enough
 *     to hold little about the creator.
 *   - How long it is kept, honestly: one sorted set per person, scored by
 *     `at`. Each sign-in drops the entries SIGN_IN_DAYS old or more and all
 *     but the newest MAX_SIGN_INS, and sets the whole set to expire
 *     SIGN_IN_DAYS later. So an entry is shown at most SIGN_IN_DAYS, and is
 *     stored until the next sign-in after that or until the set expires,
 *     which is never more than twice SIGN_IN_DAYS after it was written.
 *     The privacy policy must say "up to 180 days" (2 x SIGN_IN_DAYS), not 90.
 *   - Kept in the platform's own database, shown only to the creator, in
 *     their own studio; never to a team member about another person.
 *   - The place comes from the internet address and is approximate; the
 *     browser is what the device reported. The list says both (SIGN_IN_NOTES).
 *
 * What the unit that writes and shows it must do:
 *   - Read the place headers only on the hosting that sets them
 *     (process.env.VERCEL === "1", as lib/bot-check.ts does), never from a
 *     client elsewhere, after checking the hosting's official, dated docs.
 *   - Write each sign-in with signInWrite's commands, all in ONE transaction
 *     (Upstash's /multi-exec, MULTI ... EXEC; lib/redis.ts has only the
 *     pipeline today, which is not atomic, so that unit adds the call), in
 *     a key family of its own, its cost counted per sign-in.
 *   - Read with signInRead's commands and show only what signInsToShow
 *     keeps, which applies the same age and count limits again, so nothing
 *     older than SIGN_IN_DAYS is shown even if a write was missed.
 *   - Delete it with the account, where the remembered browsers
 *     (nl:auth:devices:) are; put it in the creator's own export; say it in
 *     the privacy policy (lib/person-data.ts).
 *   - Not show it in a locked session (lib/two-step.ts LOCKED_NEEDS), which
 *     may be somebody who got into the recovery inbox.
 */
import type { SignInWay } from "@/lib/auth";
import { countryOf } from "@/lib/source-rules";

export const MAX_SIGN_INS = 20;
export const SIGN_IN_DAYS = 90;
const DAY = 86_400_000;
/** How far from the server's clock a sign-in's time may be and still count as of this moment. */
const SKEW_MS = 60_000;

export type SecondStep = "code" | "recovery" | "none";
/** How a sign-in happened, as the history says it: lib/auth.ts's ways, and the two through the recovery address. */
export type HistoryWay = SignInWay | "rescue" | "locked";
export type SignInEntry = { at: number; way: HistoryWay; second: SecondStep; device: string; place: string };

const WAY_WORDS: Record<HistoryWay, string> = {
  link: "with a login link",
  passkey: "with a passkey",
  invitation: "by accepting a team invitation",
  google: "with Google",
  rescue: "with a link sent to your recovery address, which turned two-step login off",
  locked: "without two-step login, in a locked session",
};
/** Every way the history knows, from the words for it: a new way gets words, or the types refuse it. */
const WAYS = Object.keys(WAY_WORDS) as HistoryWay[];
/** Ways that never take a second step: a passkey is its own check; an invitation opens a new account; the recovery ways go without it. */
const ON_ITS_OWN: readonly HistoryWay[] = ["passkey", "invitation", "rescue", "locked"];
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
  // The same reading of a country the rest of the code makes (lib/source-rules.ts): two capital letters, never "XX" for unknown.
  const code = countryOf(typeof country === "string" ? country.trim().toUpperCase() : "");
  return name && code ? `${name}, ${code}` : name || code;
}

/** An entry as it may be kept, or null: anything that does not read as one is dropped. */
export function readEntry(raw: unknown): SignInEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.at !== "number" || !Number.isSafeInteger(v.at) || v.at <= 0) return null;
  if (!WAYS.includes(v.way as HistoryWay) || !SECONDS.includes(v.second as SecondStep)) return null;
  // A combination that cannot happen is not an entry.
  if (ON_ITS_OWN.includes(v.way as HistoryWay) && v.second !== "none") return null;
  const device = typeof v.device === "string" && /^[A-Za-z ]{1,40}$/.test(v.device) ? v.device : "";
  if (!device) return null;
  // Kept only in the shape placeFrom writes: "City, CC", "CC" or a city alone.
  const place = typeof v.place === "string" && PLACE.test(v.place) ? v.place : "";
  return { at: v.at, way: v.way as HistoryWay, second: v.second as SecondStep, device, place };
}

const PLACE = /^(?:[\p{L}\p{M}][\p{L}\p{M} .'’-]{0,59}(?:, [A-Z]{2})?|[A-Z]{2})$/u;

/** The oldest `at` still kept and shown: anything at or before now - SIGN_IN_DAYS is gone. */
function oldestKept(now: number): number {
  return now - SIGN_IN_DAYS * DAY + 1;
}

/**
 * What one sign-in sends, in ONE transaction, to the person's sorted set
 * (scored by `at`, the member the entry as JSON): add it, drop everything
 * SIGN_IN_DAYS old or more, drop all but the newest MAX_SIGN_INS, and expire
 * the set SIGN_IN_DAYS from now. An entry that does not read as one, or is
 * not of this moment, sends nothing.
 */
export function signInWrite(key: string, entry: SignInEntry, now: number): (string | number)[][] {
  const fresh = readEntry(entry);
  if (!fresh || Math.abs(fresh.at - now) > SKEW_MS) return [];
  const member = JSON.stringify({ at: fresh.at, way: fresh.way, second: fresh.second, device: fresh.device, place: fresh.place });
  return [
    ["ZADD", key, String(fresh.at), member],
    ["ZREMRANGEBYSCORE", key, "-inf", String(oldestKept(now) - 1)],
    ["ZREMRANGEBYRANK", key, "0", String(-(MAX_SIGN_INS + 1))],
    ["EXPIRE", key, SIGN_IN_DAYS * 86_400],
  ];
}

/** What reading the list sends: the newest MAX_SIGN_INS members, newest first. */
export function signInRead(key: string): (string | number)[][] {
  return [["ZREVRANGE", key, "0", String(MAX_SIGN_INS - 1)]];
}

/**
 * The entries to show from what the read answered: each member read as
 * strictly as when it was written, none SIGN_IN_DAYS old or more, none in
 * the future, newest first, at most MAX_SIGN_INS. The same limits as the
 * write, so a missed or failed write never shows anything older.
 */
export function signInsToShow(members: unknown, now: number): SignInEntry[] {
  if (!Array.isArray(members)) return [];
  const kept: SignInEntry[] = [];
  for (const member of members) {
    let raw: unknown = member;
    if (typeof member === "string") {
      try {
        raw = JSON.parse(member);
      } catch {
        continue;
      }
    }
    const entry = readEntry(raw);
    if (entry && entry.at >= oldestKept(now) && entry.at <= now + SKEW_MS) kept.push(entry);
  }
  return kept.sort((a, b) => b.at - a.at).slice(0, MAX_SIGN_INS);
}

const SECOND_WORDS: Record<SecondStep, string> = {
  code: " and a code from your authenticator app",
  recovery: " and a recovery code",
  none: "",
};

/** Said once under the list: where the place and the browser come from. */
export const SIGN_IN_NOTES = [
  "The place comes from the internet address, so it is approximate.",
  "The browser is what the device reported about itself.",
] as const;

/**
 * Said under the list when it holds a locked session: what such a session
 * could and could not do (lib/two-step.ts LOCKED_NEEDS, held in the test).
 */
export const LOCKED_NOTE = [
  "A locked session can sell, edit products and pages, answer buyers and see your numbers.",
  "It cannot change billing, payments, your team or settings.",
  "It cannot delete, export, import or send to your list.",
] as const;

/** The notes to show under a list: always where the facts come from, and what a locked session is when one is listed. */
export function historyNotes(entries: readonly SignInEntry[]): string[] {
  return [...SIGN_IN_NOTES, ...(entries.some((e) => e.way === "locked") ? LOCKED_NOTE : [])];
}

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
  const place = entry.place ? `near ${entry.place} (approximate)` : "place unknown";
  return [when, entry.device, place, `${WAY_WORDS[entry.way]}${SECOND_WORDS[entry.second]}`].join(" · ");
}
