/**
 * Sending the email on the anniversary of a purchase (lib/anniversary-rules.ts, 283 [HG2]).
 *
 * Once a day, inside the daily job (app/api/cron/plans), for every store that
 * turned it on: the paid checkouts on the creator's own Stripe account made a
 * year ago, read from where the last run stopped (the store's scan below). A
 * checkout is written about only when all of this is known, and nothing is
 * sent on anything not known:
 *
 *   - it is this store's, complete and paid, a one-time payment above zero,
 *     of a product the store still has (never a tip, a call, a payment plan,
 *     a membership, a package or a request);
 *   - its charge, read in the same list, was neither refunded (in whole or
 *     in part) nor disputed;
 *   - the buyer ticked the box to hear from the creator at that checkout
 *     (`news` "yes"), AND is on the creator's list and may be written to now
 *     (lib/contacts.ts, tokensFor: never unsubscribed, bounced or marked as
 *     spam), AND was not deleted from the store (lib/suppression.ts, read
 *     whole or not at all).
 *
 * One email per person per date, whatever they bought that day: the once-mark
 * is claimed exactly (lib/claim-mark.ts) before sending and let go only when
 * the sender refused it for certain (lib/email.ts, sendEmailOutcome). An
 * answer that is not known (a timeout, a server error, a throw after the
 * request left) keeps the mark: the email may have gone, and a second one is
 * worse than none. The email is taken from the store's own figure before it
 * is sent (lib/email.ts, meter "store"); a spent figure sends nothing.
 *
 * The scan, and its ceilings. Stripe lists newest first, so a store's
 * purchases of a year ago are read as a scan of a fixed span of time,
 * [lo, hi], SESSION_PAGES pages of a hundred a run at the most, and the
 * next run goes on from the last checkout handled (`starting_after`). A
 * run moves the scan on only past checkouts it handled whole; one it could
 * not finish (ANNIVERSARIES_PER_STORE_RUN emails tried, the deadline, a
 * refusal, an unknown claim) is read again the next run, and the once-marks
 * keep that from meaning two emails. When a scan is done, the next one
 * starts right after it and ends a year before that run. So on a busy day
 * some of these emails go on the following days, and the email gives the
 * real date of the purchase; a purchase older than ANNIVERSARY_LATE_DAYS
 * before the run is no longer read, and its email is not sent. Those are the
 * ceilings: 300 checkouts read and 100 emails tried a store a day, at most a
 * week late. The studio says so.
 *
 *   nl:hg:once:<statsId>:<hash>           that person was written to lately, ONCE_DAYS
 *   nl:hg:count:<statsId>:<yyyy-mm>       sent this month, for the studio, COUNT_DAYS
 *   nl:hg:scan:<statsId>                  the store's scan: "lo|hi|after", after "*" when done
 *   nl:hg:cursor                          where the last run stopped among the stores
 */
import { createHash } from "node:crypto";
import { EMAIL_PATTERN, normaliseEmail } from "@/lib/auth";
import { isSenderConfigured, sendEmailOutcome } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { onAccount, platformKey } from "@/lib/stripe-account";
import { type Store, saleHandles, storesAfter } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { fromLine, render } from "@/lib/mail";
import { tokensFor } from "@/lib/contacts";
import { suppressedAmong } from "@/lib/suppression";
import { storeBase } from "@/lib/purchase-email";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { ANNIVERSARY_LATE_DAYS, anniversaryCovers, anniversaryEmail, anniversaryOn, anniversaryWindow } from "@/lib/anniversary-rules";

const DAY_SECONDS = 86_400;
const CURSOR_KEY = "nl:hg:cursor";
/** A person written to is not written to again for this long: once per date, and never twice in a month. */
const ONCE_DAYS = 30;
const COUNT_DAYS = 62;
/** A store's scan is kept this long after its last run: past it, a scan could not reach anything still sent. */
const SCAN_DAYS = ANNIVERSARY_LATE_DAYS + 2;
/** Pages of a hundred checkouts read for one store in one run; the next run goes on from there. */
const SESSION_PAGES = 3;
/** At most this many emails tried from one store in one run; the rest go the next day, up to ANNIVERSARY_LATE_DAYS late. */
export const ANNIVERSARIES_PER_STORE_RUN = 100;
/** Checkouts that are not a purchase of a product to look back on. */
const NOT_A_PURCHASE = new Set(["tip", "call", "plan", "package", "request", "upsell"]);
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,255}$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const onceKey = (statsId: string, email: string) => `nl:hg:once:${statsId}:${sha(`nimbus-hg-once:${normaliseEmail(email)}`).slice(0, 32)}`;
const countKey = (statsId: string, month: string) => `nl:hg:count:${statsId}:${month}`;
const scanKey = (statsId: string) => `nl:hg:scan:${statsId}`;
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/**
 * A day as the store's language writes it, said to be the UTC day: "November 6, 2025 (UTC)". The
 * buyer's own time zone is not kept on a checkout, and the UTC day can be the day before or after theirs.
 */
const day = (seconds: number, language: unknown) =>
  `${new Date(seconds * 1000).toLocaleDateString(LANGUAGES[parseLanguage(language)].locale, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })} (UTC)`;

type Candidate = { email: string; product: string; created: number; session: string };
/** A span of Stripe's seconds read newest first; `after` the last checkout handled ("" for none yet), `done` when all of it was. */
type Scan = { lo: number; hi: number; after: string; done: boolean };

/** A saved scan, read strictly: anything else is no scan (a new one starts; the once-marks keep it from writing twice). */
function parseScan(raw: unknown): Scan | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{1,12})\|(\d{1,12})\|(\*|cs_(?:test|live)_[A-Za-z0-9]{8,255})?$/.exec(raw);
  if (!match) return null;
  const lo = Number(match[1]);
  const hi = Number(match[2]);
  if (lo > hi + 1) return null;
  const after = match[3] ?? "";
  return after === "*" ? { lo, hi, after: "", done: true } : { lo, hi, after, done: false };
}

/** This run's scan: the one in progress, or the next after a finished one, never reaching back past `oldest`. */
function scanFor(saved: Scan | null, window: { from: number; upTo: number }, oldest: number): Scan {
  if (saved && !saved.done && saved.hi >= oldest) return { ...saved, lo: Math.max(saved.lo, oldest) };
  if (saved && !saved.done) return { lo: oldest, hi: window.upTo, after: "", done: false };
  if (saved) return { lo: Math.max(saved.hi + 1, oldest), hi: window.upTo, after: "", done: false };
  return { lo: window.from, hi: window.upTo, after: "", done: false };
}

/** A checkout's charge as the list expanded it: known untouched only when Stripe said so, field by field. */
function chargeUntouched(payment: unknown): boolean | null {
  if (!payment || typeof payment !== "object") return null;
  const charge = (payment as { latest_charge?: unknown }).latest_charge;
  if (!charge || typeof charge !== "object") return null;
  const { refunded, amount_refunded: amountRefunded, disputed } = charge as Record<string, unknown>;
  if (typeof refunded !== "boolean" || typeof disputed !== "boolean" || typeof amountRefunded !== "number") return null;
  return !refunded && amountRefunded === 0 && !disputed;
}

/** One listed checkout, read whole: a candidate, or null when it is not one (or not known to be one). */
function candidateOf(row: unknown, handles: Set<string>, window: { from: number; upTo: number }): Candidate | null {
  if (!row || typeof row !== "object") return null;
  const s = row as Record<string, unknown>;
  const meta = s.metadata && typeof s.metadata === "object" && !Array.isArray(s.metadata) ? (s.metadata as Record<string, unknown>) : null;
  if (!meta || typeof s.id !== "string" || !SESSION_ID.test(s.id)) return null;
  if (typeof meta.store !== "string" || !handles.has(meta.store)) return null;
  // The box at that checkout, said yes to: nothing else stands for it.
  if (meta.news !== "yes") return null;
  if (typeof meta.product !== "string" || !meta.product) return null;
  if (typeof meta.kind === "string" && NOT_A_PURCHASE.has(meta.kind)) return null;
  if (s.status !== "complete" || s.payment_status !== "paid" || s.mode !== "payment") return null;
  if (typeof s.amount_total !== "number" || s.amount_total <= 0) return null;
  if (typeof s.created !== "number" || s.created < window.from || s.created > window.upTo) return null;
  if (chargeUntouched(s.payment_intent) !== true) return null;
  const details = s.customer_details && typeof s.customer_details === "object" ? (s.customer_details as { email?: unknown }) : {};
  const raw = typeof details.email === "string" ? details.email : typeof s.customer_email === "string" ? s.customer_email : "";
  if (!raw || !EMAIL_PATTERN.test(raw)) return null;
  return { email: normaliseEmail(raw), product: meta.product, created: s.created, session: s.id };
}

/**
 * This run's pages of the scan, from where it stopped, whole pages only: a page that is not a list stops
 * the store's run (nothing is sent, the scan does not move). `after` is the last checkout read; `more`
 * whether Stripe has older ones in the span.
 */
async function scanPages(store: Store, scan: Scan, deadline: number): Promise<{ rows: unknown[]; after: string; more: boolean }> {
  const rows: unknown[] = [];
  let after = scan.after;
  for (let page = 0; page < SESSION_PAGES && Date.now() < deadline; page += 1) {
    const query = new URLSearchParams({ limit: "100", "created[gte]": String(scan.lo), "created[lte]": String(scan.hi) });
    query.append("expand[]", "data.payment_intent.latest_charge");
    if (after) query.set("starting_after", after);
    const listed = await onAccount("GET", store.stripeAccountId as string, `/checkout/sessions?${query}`);
    if (!Array.isArray(listed.data) || (listed.has_more !== true && listed.has_more !== false)) throw new Error("a page of checkouts could not be read whole");
    rows.push(...(listed.data as unknown[]));
    if (listed.has_more === false) return { rows, after, more: false };
    const last = (listed.data as { id?: unknown }[]).at(-1)?.id;
    // More to come, but no checkout to go on from: not known, so nothing of this run is used.
    if (typeof last !== "string" || !SESSION_ID.test(last)) throw new Error("a page of checkouts could not be read whole");
    after = last;
  }
  return { rows, after, more: true };
}

/** One store's purchases of a year ago, each buyer written to once. */
export async function anniversaryStore(store: Store, deadline: number, now = Date.now()): Promise<number> {
  if (!anniversaryOn(store) || !store.stripeAccountId || !store.statsId || !store.listId) return 0;
  const statsId = store.statsId;
  const listId = store.listId;
  const window = anniversaryWindow(now);
  const [saved] = await redisPipeline([["GET", scanKey(statsId)]]);
  const scan = scanFor(parseScan(saved), window, window.upTo - ANNIVERSARY_LATE_DAYS * DAY_SECONDS);
  const keep = async (next: Scan) => {
    const value = `${next.lo}|${next.hi}|${next.done ? "*" : next.after}`;
    await redisPipeline([["SET", scanKey(statsId), value, "EX", SCAN_DAYS * DAY_SECONDS]]);
  };
  // Nothing new since the last scan ended (a second run at the same moment).
  if (scan.lo > scan.hi) return 0;
  const read = await scanPages(store, scan, deadline);
  const handles = saleHandles(store);
  // Oldest first among what this run read. Each person's first purchase is the one named; whatever else
  // they bought that day does not mean a second email.
  const found = read.rows
    .reverse()
    .map((row) => candidateOf(row, handles, { from: scan.lo, upTo: scan.hi }))
    .filter((c): c is Candidate => c !== null)
    // Only a product the creator's choice covers (283 [HG2] unit 3); the person is written about the first of those.
    .filter((c) => anniversaryCovers(store.anniversary, c.product))
    .sort((a, b) => a.created - b.created);
  const byPerson = new Map<string, Candidate>();
  for (const candidate of found) if (!byPerson.has(candidate.email)) byPerson.set(candidate.email, candidate);
  // On the list and may be written to now; and not deleted from the store, read whole or the run sends nothing.
  const emails = [...byPerson.keys()];
  const tokens = emails.length ? await tokensFor(listId, emails, store.handle) : new Map<string, string>();
  const deleted = emails.length ? await suppressedAmong(listId, emails.filter((e) => tokens.has(e))) : new Set<string>();
  const base = storeBase(store);
  let tried = 0;
  let sent = 0;
  // Whether every checkout this run read was handled: only then does the scan move on past them.
  let whole = true;

  for (const candidate of byPerson.values()) {
    if (Date.now() >= deadline || tried >= ANNIVERSARIES_PER_STORE_RUN) {
      whole = false;
      break;
    }
    const unsub = tokens.get(candidate.email);
    if (!unsub || deleted.has(candidate.email)) continue;
    const product = await readListing(store, candidate.product);
    if (!product) continue;
    // Made before the mark is claimed, so a failure here holds nothing.
    const mail = anniversaryEmail({
      storeName: store.name,
      title: product.title,
      boughtOn: day(candidate.created, store.language),
      message: store.anniversary.message,
      link: base,
      language: store.language,
    });
    // The list email's own footer: why they get it, the one-click way off the list, and the creator's postal address.
    const withAddress = { ...store, mail: { fromName: store.mail?.fromName || store.name, address: store.anniversary.address } };
    const rendered = render(withAddress, mail.subject, mail.body, unsub);
    const claim = claimValue();
    const key = onceKey(statsId, candidate.email);
    // Ours only on an exact claim: written to lately sends nothing; an unknown answer sends nothing now and is read again.
    const claimed = await claimMark(key, ONCE_DAYS * 86_400, claim);
    if (claimed === "unknown") whole = false;
    if (claimed !== "ours") continue;
    tried += 1;
    let outcome: "sent" | "refused" | "uncertain";
    try {
      outcome = await sendEmailOutcome({
        meter: { by: "store", store: store, kind: "email" },
        from: fromLine(withAddress),
        to: candidate.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        replyTo: store.email,
        headers: rendered.headers,
        idempotencyKey: `nimbus-hg:${statsId}:${candidate.session}`,
      });
    } catch (error) {
      // Thrown on the way: it may have gone, so the mark stays.
      outcome = "uncertain";
      console.error("sending an anniversary email failed; its mark is kept", store.handle, error);
    }
    if (outcome === "sent") {
      sent += 1;
      const count = countKey(statsId, monthOf(now));
      await redisPipeline([
        ["INCR", count],
        ["EXPIRE", count, COUNT_DAYS * 86_400],
      ]).catch((error) => console.error("counting an anniversary email failed", store.handle, error));
    } else if (outcome === "refused") {
      // Refused for certain (the store's figure spent, the sender down): only this run's own claim is let go,
      // and the store stops here; the next run reads these checkouts again.
      await releaseMark(key, claim);
      whole = false;
      break;
    } else {
      console.error("an anniversary email's answer is not known; its mark is kept, so it is not sent again", store.handle);
    }
  }
  if (!whole) await keep(scan);
  else if (read.more) await keep({ ...scan, after: read.after });
  else await keep({ ...scan, done: true });
  return sent;
}

/** How many anniversary emails a store sent this month. */
export async function anniversariesThisMonth(store: Store, now = Date.now()): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const [count] = await redisPipeline([["GET", countKey(store.statsId, monthOf(now))]]);
  return Number(count) || 0;
}

/** The daily run: every store with it on, from where the last run stopped. */
export async function sendAnniversaries(deadline: number, now = Date.now()): Promise<{ stores: number; sent: number }> {
  const counts = { stores: 0, sent: 0 };
  if (!isRedisConfigured() || !platformKey() || !isSenderConfigured()) return counts;
  const [saved] = await redisPipeline([["GET", CURSOR_KEY]]);
  const [savedCursor, savedDone] = typeof saved === "string" ? saved.split("|") : ["0", "0"];
  let cursor = /^\d+$/.test(savedCursor ?? "") ? savedCursor : "0";
  let skip = Number(savedDone) || 0;
  while (Date.now() < deadline) {
    const { stores, next } = await storesAfter(cursor);
    let done = 0;
    for (const store of stores) {
      if (done < skip) {
        done += 1;
        continue;
      }
      if (Date.now() >= deadline) break;
      if (anniversaryOn(store) && store.stripeAccountId && store.statsId && store.listId) {
        counts.stores += 1;
        try {
          counts.sent += await anniversaryStore(store, deadline, now);
        } catch (error) {
          console.error("reading a store's purchases of a year ago failed", store.handle, error);
        }
      }
      done += 1;
    }
    if (done < stores.length) {
      await redisPipeline([["SET", CURSOR_KEY, `${cursor}|${done}`]]);
      return counts;
    }
    skip = 0;
    cursor = next;
    if (next === "0") break;
  }
  await redisPipeline([["SET", CURSOR_KEY, `${cursor}|0`]]);
  return counts;
}

/** Forgets that one person was written to on a purchase's anniversary (lib/person-erasure.ts). */
export async function forgetAnniversaryPerson(statsId: string | null, email: string): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const [gone] = await redisPipeline([["DEL", onceKey(statsId, email)]]);
  return Number(gone) || 0;
}
