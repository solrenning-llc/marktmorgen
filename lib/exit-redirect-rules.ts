/**
 * A closed store's moved notice: for 90 days after its closing day, its old
 * address here says where the store went (queue item 97 [D2-OPEN-EXIT],
 * unit 1: the rules only; nothing reads or writes them yet).
 *
 * A creator who leaves keeps the links they printed: on a card, in a book,
 * in a video description, in last year's emails. Today those links lead to
 * nothing the day the store closes (lib/store.ts, closeStoreRecord). With a
 * new address chosen before that day, a visitor to the old one is told,
 * in plain words, that the store moved and where, with the new address as
 * a link they choose to follow.
 *
 * A notice with a link, not a silent HTTP redirect: an address on this site
 * that sends visitors straight to any other site is an open redirect, which
 * is how a phishing page borrows a trusted name. The visitor sees the new
 * host, in its ASCII form so that a look-alike name in another script shows
 * as what it is, and follows it on request (WCAG 3.2.5, change on request).
 *
 * The new address must be a public https address outside this site: no user
 * name or password in it, no IP address, no private or reserved name, no
 * other port. The old address is held from other stores for as long as the
 * notice runs (exitHoldSeconds), never less than the usual quarantine, so a
 * visitor is never told that somebody else's store "moved". Anything that
 * does not read whole, an owner that could not be read, or a clock that is
 * not a number gives no notice: the visitor sees what they see today,
 * never a link to an address nobody checked.
 *
 * Imported by client pages too, so nothing here reaches a server module.
 */
import { closesStore } from "@/lib/plan-closing-rules";
import { SITE_URL } from "@/lib/site-url";

/** How long the notice runs after the closing day: the item's 90 days. */
export const EXIT_NOTICE_DAYS = 90;
/** The longest new address taken, as typed and as kept. */
export const EXIT_DESTINATION_MAX = 2048;

const DAY_MS = 86_400_000;
const DAY_S = 86_400;

/** This site's own host: a notice never points back here. */
const OWN_HOST = new URL(SITE_URL).hostname.toLowerCase();

/**
 * Names that never reach a public website: special-use and reserved names
 * (RFC 6761, RFC 6762, RFC 8375, RFC 2606) and the private names networks
 * commonly use. A host with no dot at all is refused too.
 */
const NOT_PUBLIC_SUFFIXES = ["localhost", "local", "internal", "test", "example", "invalid", "lan", "home.arpa", "onion", "intranet", "corp", "private"];

export type ExitDestination =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: "empty" | "too_long" | "not_address" | "not_https" | "credentials" | "port" | "not_public" | "own_site" };

/** The new address a creator typed, checked; its fragment dropped. */
export function exitDestination(raw: unknown): ExitDestination {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  const typed = raw.trim();
  if (!typed) return { ok: false, reason: "empty" };
  if (typed.length > EXIT_DESTINATION_MAX) return { ok: false, reason: "too_long" };
  let url: URL;
  try {
    url = new URL(typed);
  } catch {
    return { ok: false, reason: "not_address" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (url.port) return { ok: false, reason: "port" };
  const host = url.hostname.toLowerCase();
  const bare = host.endsWith(".") ? host.slice(0, -1) : host;
  if (bare === OWN_HOST || bare.endsWith(`.${OWN_HOST}`)) return { ok: false, reason: "own_site" };
  if (!isPublicName(bare)) return { ok: false, reason: "not_public" };
  url.hash = "";
  const href = url.href;
  if (href.length > EXIT_DESTINATION_MAX) return { ok: false, reason: "too_long" };
  return { ok: true, url: href, host };
}

function isPublicName(host: string): boolean {
  if (!host || host.startsWith("[")) return false;
  if (/^[0-9.]+$/.test(host)) return false;
  if (!host.includes(".")) return false;
  return !NOT_PUBLIC_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Whether a store may choose its new address now: only a store whose plan
 * ended under the rule that closes it whole (closesStore), before its
 * closing day. Anything unknown is no.
 */
export function mayChooseExit(input: { endedAt: number | undefined; closingDay: number; now: number }): boolean {
  const { endedAt, closingDay, now } = input;
  if (typeof endedAt !== "number" || !closesStore(endedAt)) return false;
  if (!Number.isFinite(closingDay) || closingDay <= endedAt) return false;
  return Number.isFinite(now) && now < closingDay;
}

/** What is kept for the notice: the address, the store it was chosen by, its closing day and when it was chosen. */
export type ExitNotice = { to: string; host: string; ref: string; closedAt: number; setAt: number };

/** A kept notice, read whole or not at all. */
export function readExitNotice(value: unknown): ExitNotice | null {
  let data: unknown = value;
  if (typeof value === "string") {
    try {
      data = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { to, host, ref, closedAt, setAt } = data as Record<string, unknown>;
  const checked = exitDestination(to);
  if (!checked.ok || checked.url !== to || checked.host !== host) return null;
  if (typeof ref !== "string" || !ref) return null;
  if (typeof closedAt !== "number" || !Number.isSafeInteger(closedAt) || closedAt <= 0) return null;
  if (typeof setAt !== "number" || !Number.isSafeInteger(setAt) || setAt <= 0 || setAt >= closedAt) return null;
  return { to: checked.url, host: checked.host, ref, closedAt, setAt };
}

/** When the notice of a store closed at `closedAt` ends; unknown is no end, and so no notice. */
export function exitNoticeUntil(closedAt: number): number | null {
  return Number.isFinite(closedAt) ? closedAt + EXIT_NOTICE_DAYS * DAY_MS : null;
}

/**
 * How long, from `now`, the old address must be held from other stores:
 * until the notice ends, and never less than the usual quarantine
 * (RELEASE_QUARANTINE_DAYS in lib/store.ts, passed in so that this file
 * stays out of the server's modules). Whatever is unknown makes the hold
 * longer, never shorter.
 */
export function exitHoldSeconds(closedAt: number, now: number, quarantineDays: number): number {
  const notice = EXIT_NOTICE_DAYS * DAY_S;
  const quarantine = Number.isFinite(quarantineDays) && quarantineDays > 0 ? Math.ceil(quarantineDays * DAY_S) : null;
  const until = exitNoticeUntil(closedAt);
  if (until === null) return quarantine ?? notice;
  if (!Number.isFinite(now)) return Math.max(quarantine ?? 0, notice);
  const left = Math.ceil((until - now) / 1000);
  return Math.max(quarantine ?? notice, left);
}

/**
 * Who holds the old address now: "released" when it is held for the closed
 * store and belongs to nobody, a store's ref when a store has it, "unknown"
 * when it could not be read.
 */
export type ExitHolder = "released" | "unknown" | string;

export type ExitAnswer = { kind: "moved"; to: string; host: string; until: number } | { kind: "gone" } | { kind: "none" };

/**
 * What a visitor to a closed store's old address is shown: the notice while
 * it runs, "gone" once it has ended, and nothing different from today
 * otherwise. Only the store's chosen address is given; the visitor's own
 * path and query are never carried to another site.
 */
export function exitAnswer(input: { record: ExitNotice | null; holder: ExitHolder; now: number }): ExitAnswer {
  const { record, holder, now } = input;
  if (!record || holder !== "released" || !Number.isFinite(now)) return { kind: "none" };
  if (now < record.closedAt) return { kind: "none" };
  const until = exitNoticeUntil(record.closedAt);
  if (until === null) return { kind: "none" };
  if (now >= until) return { kind: "gone" };
  return { kind: "moved", to: record.to, host: record.host, until };
}
