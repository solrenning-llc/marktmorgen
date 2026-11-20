/**
 * The creator's sign-in history (630 [HN6], item 33, unit 1; added
 * 3 November 2026): the rules, browser-safe. Writing an entry at each
 * sign-in (lib/auth.ts noteSignIn, which already tells the creator about a
 * new browser), the list in the studio beside "Sign out everywhere" (already
 * there, app/api/auth/signout-all), and the privacy policy's sentence are the
 * next unit; keeping the list needs a key family of its own
 * (lib/data-families.ts).
 *
 *   - Each entry says when; how the creator got in (`way`: the ways lib/auth.ts
 *     names, plus "rescue", the link to the recovery address that turned
 *     two-step login off, app/api/auth/rescue; "locked", a session opened
 *     without the second step and held back from what LOCKED_NOTE says; and
 *     "move", the session the change of sign-in address opens); apart from
 *     it, which address the way went through (`via`: the sign-in address or
 *     the recovery address, so a session opened from the recovery inbox is
 *     never shown as a plain login link); the second step used (lib/two-step.ts:
 *     a code from the app, a recovery code, or none; a passkey is its own
 *     check); the browser as browserName says it ("Chrome on macOS", never the
 *     full user agent); and the approximate place the hosting's own headers
 *     give (a city and a country, cleaned; never the IP address, which is not
 *     kept). The country is kept as its two-letter code and shown by its
 *     English name (Intl.DisplayNames), never as the bare code (AX274 3.1.4).
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
 *   - Key: one sorted set per person, named from a hash of the NORMALISED
 *     sign-in email, exactly as the remembered browsers are
 *     (lib/auth.ts devicesKey: the devices prefix + sha256Hex of a prefix and
 *     normaliseEmail(email), cut to 40 hex), with its own prefix and its own
 *     hash input; never the email in clear in a key or a member.
 *   - Read the place headers only on the hosting that sets them
 *     (process.env.VERCEL === "1", as lib/bot-check.ts does), never from a
 *     client elsewhere, after checking the hosting's official, dated docs.
 *     Check there too whether x-vercel-ip-city encodes a space as "+":
 *     decodeURIComponent leaves "+" as it is, placeFrom then refuses the
 *     city and keeps the country only (left out, never guessed); if Vercel
 *     uses "+", turn it into a space before placeFrom, with a test.
 *   - Write each sign-in with signInWrite's commands, all in ONE MULTI/EXEC
 *     transaction (Upstash's /multi-exec). This is required, not a choice:
 *     lib/redis.ts has only the pipeline today, which is not atomic, so the
 *     unit adds the call; a pipeline is never acceptable here, because a
 *     ZADD that lands without its EXPIRE leaves a set with no end. That unit
 *     tests the failure of EXPIRE (and of each other command): the whole
 *     write is undone or never applied, never a set left without expiry.
 *     In a key family of its own, its cost counted per sign-in.
 *   - Write the entry's way from what really happened, never "link" for
 *     everything as noteSignIn's callers pass today:
 *       app/api/auth/lost/confirm (the "lost" link sent to the recovery
 *       address) has three paths, and throughLostLink names each: two-step
 *       login on, the code page then writes "link" via "recovery" with the
 *       code used, or "locked" via "recovery" when the code page's reset is
 *       used; no two-step login and a recovery lock running, "locked" via
 *       "recovery"; no two-step login and no lock, "link" via "recovery".
 *       app/api/auth/code needs to know the hold came through the recovery
 *       address: CONTRACT for the next unit, lib/two-step.ts finishSignIn
 *       answers `viaRecovery` beside `byGoogle` (its hold already keeps `v`),
 *       and the reset reads heldInfo(held).viaRecovery before enterLocked
 *       spends the hold. That change belongs to lib/two-step.ts and is not
 *       made in this unit. app/api/auth/rescue writes "rescue" via "recovery".
 *   - The change of sign-in address IS a sign-in: app/api/auth/move ends
 *     every session of the old address and opens a new one with
 *     openSession(moved.to), without noteSignIn today; a session opened is
 *     a way in, so it is written as "move" via "sign-in", second step none,
 *     said "with the link that changed your sign-in address". The move must
 *     also take the history with it, beside moveDevices
 *     (app/api/auth/move/route.ts, the Promise.all with moveDevices): the
 *     old address's set is moved to the new address's key and the old key
 *     deleted, in one transaction, before the "move" entry is written to the
 *     new key; if moving fails, the old key is deleted, never left behind.
 *   - Read with signInRead's commands and show only what signInsToShow
 *     keeps, which applies the same age and count limits again, so nothing
 *     older than SIGN_IN_DAYS is shown even if a write was missed.
 *   - Delete it with the account, where the remembered browsers
 *     (lib/auth.ts devicesKey) are; put it in the creator's own export; say it in
 *     the privacy policy (lib/person-data.ts).
 *   - Not show it in a locked session (lib/two-step.ts LOCKED_NEEDS), which
 *     may be somebody who got into the sign-in or the recovery inbox.
 */
import type { SignInWay } from "@/lib/auth";
import { countryOf } from "@/lib/source-rules";

export const MAX_SIGN_INS = 20;
export const SIGN_IN_DAYS = 90;
const DAY = 86_400_000;
/** How far from the server's clock a sign-in's time may be and still count as of this moment. */
const SKEW_MS = 60_000;
/** The last moment a Date can hold (ECMAScript's time value limit): past it, nothing can be said about when. */
const LAST_TIME = 8.64e15;

export type SecondStep = "code" | "recovery" | "none";
/**
 * How a sign-in happened, as the history says it: lib/auth.ts's ways; "rescue",
 * the recovery address's link that turned two-step login off; "locked", a
 * session opened without the second step, through either address (see `via`);
 * "move", the session the change of sign-in address opens.
 */
export type HistoryWay = SignInWay | "rescue" | "locked" | "move";
/** Which address the way went through: the sign-in address, or the recovery address. */
export type Via = "sign-in" | "recovery";
export type SignInEntry = { at: number; way: HistoryWay; via: Via; second: SecondStep; device: string; place: string };

/** What each way is said as, and through which addresses it can come. A new way gets both, or the types refuse it. */
const WAY_RULES: Record<HistoryWay, { via: readonly Via[]; words: (via: Via) => string }> = {
  link: { via: ["sign-in", "recovery"], words: (via) => (via === "recovery" ? "with a login link sent to your recovery address" : "with a login link") },
  code: { via: ["sign-in"], words: () => "with a login code" },
  passkey: { via: ["sign-in"], words: () => "with a passkey" },
  invitation: { via: ["sign-in"], words: () => "by accepting a team invitation" },
  google: { via: ["sign-in"], words: () => "with Google" },
  rescue: { via: ["recovery"], words: () => "with a link sent to your recovery address, which turned two-step login off" },
  locked: {
    via: ["sign-in", "recovery"],
    words: (via) =>
      via === "recovery"
        ? "without two-step login, through a link sent to your recovery address, in a locked session"
        : "without two-step login, through your sign-in address, in a locked session",
  },
  move: { via: ["sign-in"], words: () => "with the link that changed your sign-in address" },
};
const WAYS = Object.keys(WAY_RULES) as HistoryWay[];
/** Ways that never take a second step: a passkey is its own check; an invitation opens a new account; the others go without it. */
const ON_ITS_OWN: readonly HistoryWay[] = ["passkey", "invitation", "rescue", "locked", "move"];
const SECONDS: readonly SecondStep[] = ["code", "recovery", "none"];

/**
 * The three paths of app/api/auth/lost/confirm, the "lost" link sent to the
 * recovery address, as the history writes each (tests/sign-in-history-rules
 * reads the route to hold them):
 *   - "two-step": two-step login is on, so it leads to the code page with a
 *     hold that says "through the recovery address"; a code there makes it a
 *     login link via the recovery address with that code ("code" or
 *     "recovery"), and the code page's reset, with no code ("none"), a
 *     locked session via the recovery address.
 *   - "locked": no two-step login and the recovery lock still running.
 *   - "open": no two-step login and no lock: a full session, still a link
 *     sent to the recovery address, never a plain login link.
 */
export function throughLostLink(path: "two-step" | "locked" | "open", second: SecondStep = "none"): Pick<SignInEntry, "way" | "via" | "second"> {
  if (path === "two-step" && second !== "none") return { way: "link", via: "recovery", second };
  if (path === "open") return { way: "link", via: "recovery", second: "none" };
  return { way: "locked", via: "recovery", second: "none" };
}

/** A city's name: letters, each with at most two combining marks, and spaces, dots, apostrophes and hyphens, starting with a letter. */
const CITY = String.raw`\p{L}\p{M}{0,2}(?:\p{L}\p{M}{0,2}|[ .'’-])*`;
const CITY_ONLY = new RegExp(`^${CITY}$`, "u");
const CITY_CHARS = 60;
/** Kept only in the shape placeFrom writes: "City, CC", "CC" or a city alone. */
const PLACE = new RegExp(`^(?:(${CITY})(?:, [A-Z]{2})?|[A-Z]{2})$`, "u");

/**
 * The approximate place, from the hosting's headers (on Vercel,
 * x-vercel-ip-city, URL-encoded, and x-vercel-ip-country): "Fortaleza, BR",
 * "BR" with no city, "" with neither. A city of up to 60 characters as CITY
 * reads it; a country of two capital letters. Anything else is left out,
 * never guessed.
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
    if (name.length > CITY_CHARS || !CITY_ONLY.test(name)) name = "";
  }
  // The same reading of a country the rest of the code makes (lib/source-rules.ts): two capital letters, never "XX" for unknown.
  const code = countryOf(typeof country === "string" ? country.trim().toUpperCase() : "");
  return name && code ? `${name}, ${code}` : name || code;
}

/** An entry as it may be kept, or null: anything that does not read as one is dropped. */
export function readEntry(raw: unknown): SignInEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.at !== "number" || !Number.isSafeInteger(v.at) || v.at <= 0 || v.at > LAST_TIME) return null;
  if (!WAYS.includes(v.way as HistoryWay) || !SECONDS.includes(v.second as SecondStep)) return null;
  const way = v.way as HistoryWay;
  // A combination that cannot happen is not an entry: a way through an address it never uses, or a second step where none is taken.
  if (!WAY_RULES[way].via.includes(v.via as Via)) return null;
  if (ON_ITS_OWN.includes(way) && v.second !== "none") return null;
  const device = typeof v.device === "string" && /^[A-Za-z ]{1,40}$/.test(v.device) ? v.device : "";
  if (!device) return null;
  const place = typeof v.place === "string" && v.place.length <= CITY_CHARS + 4 ? v.place : "";
  const match = PLACE.exec(place);
  const kept = match && (match[1] ?? "").length <= CITY_CHARS ? place : "";
  return { at: v.at, way, via: v.via as Via, second: v.second as SecondStep, device, place: kept };
}

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
  const member = JSON.stringify({ at: fresh.at, way: fresh.way, via: fresh.via, second: fresh.second, device: fresh.device, place: fresh.place });
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
 * Said under the list when it holds a locked session: everything such a
 * session is held back from, and that the rest is open to it. The
 * test holds it against lib/two-step.ts LOCKED_NEEDS (the studio's
 * permissions, lib/studio-route.ts), LOCKED_ACTIONS (each deleting action of
 * an open permission) and against every route that refuses a
 * locked session on its own (app/api/auth/signout-all, passkey, two-step,
 * recovery-address, app/api/store/address), so it never claims less or more.
 */
export const LOCKED_NOTE = [
  "A locked session got in without two-step login, so some things wait until its lock ends.",
  "It cannot change your plan, your Stripe connection, your team or your store settings.",
  "It cannot delete your store, download or import lists, or send email to your list or your members.",
  "It cannot delete anything for good, like people, products, lessons, files, forms or posts.",
  "It cannot put a new file or picture over an old one.",
  "It cannot cancel, delete or move an event, or send a purchase email again.",
  'It cannot use "Sign out everywhere" or "Log out of other devices".',
  "It cannot add or remove a passkey or change two-step login.",
  "It cannot change your recovery address or your sign-in address.",
  "Everything else in your studio is open to it.",
] as const;

/** The notes to show under a list: always where the facts come from, and what a locked session is when one is listed. */
export function historyNotes(entries: readonly SignInEntry[]): string[] {
  return [...SIGN_IN_NOTES, ...(entries.some((e) => e.way === "locked") ? LOCKED_NOTE : [])];
}

/** The country's English name, or "" when the code names none (never the bare code). */
function countryName(code: string): string {
  try {
    const name = new Intl.DisplayNames(["en-US"], { type: "region" }).of(code);
    return name && name !== code && name !== "Unknown Region" ? name : "";
  } catch {
    return "";
  }
}

/** The place as shown: "Fortaleza, Brazil", "Brazil", or "" when nothing can be said. */
function placeWords(place: string): string {
  const match = /^(?:(.+), )?([A-Z]{2})$/u.exec(place);
  if (!match) return place;
  const country = countryName(match[2]);
  return [match[1], country].filter(Boolean).join(", ");
}

/** One line of the list in the studio, in the creator's time zone (UTC when that is not one). */
export function entryWords(entry: SignInEntry, timeZone: string): string {
  let when = "time unknown";
  for (const zone of [timeZone, "UTC"]) {
    try {
      when = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: zone }).format(entry.at);
      break;
    } catch {
      // A zone that is not one, or a time no Date can hold: the next try, then "time unknown".
    }
  }
  const shown = placeWords(entry.place);
  const place = shown ? `near ${shown} (approximate)` : "place unknown";
  return [when, entry.device, place, `${WAY_RULES[entry.way].words(entry.via)}${SECOND_WORDS[entry.second]}`].join(" · ");
}
