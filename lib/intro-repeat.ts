/**
 * An introductory price paid again (owner's decision 15, 9 November 2026). A membership's introductory price
 * (lib/intro-price.ts) is given by Stripe's checkout to whoever starts the membership, so somebody who had it, left
 * and comes back pays it again. The owner's decision: accept it for now, never look the buyer up before Stripe, and
 * count how often it happens.
 *
 * Counted after the payment, from Stripe: the five-minute checkout sweep (lib/checkout-sweep.ts) already holds each
 * store's paid checkouts of the last day, and hands them here. A paid membership at its introductory price is looked
 * at once (a mark per checkout): the creator's own Stripe account is asked for the address's completed checkouts
 * (one page of a hundred, for the address as typed and as kept, as lib/next-offer.ts reads what an address owns), and
 * the sale is counted in its store's month as
 *
 *   - "repeat": an earlier paid checkout of the same membership, from this store, is among them;
 *   - "first": none is, and the list was read whole;
 *   - "unknown": the list could not be read whole (cut short, a failed read, an answer in another shape, no address):
 *     never taken for "first".
 *
 * Only numbers are kept, by store and month: no address, no checkout, no customer, nothing about the buyer.
 *
 *   nl:intro:rep:<statsId>:<yyyy-mm>   hash: repeat, first, unknown -> n; gone INTRO_REPEAT_KEEP_DAYS after its last count
 *   nl:intro:rep:paid:<checkout id>    that checkout was looked at; gone after INTRO_REPEAT_MARK_DAYS (the sweep reads one day back)
 *
 * The studio's memberships page shows the month's count (introRepeatWords). What it costs (pre-review of 099b23b129,
 * 9 November 2026): one MGET of the page's marks on every pass that holds such a sale (the sweep reads each checkout
 * back for a day, so up to 288 a day for a page, never one a sale); for each sale not yet counted, at most
 * INTRO_REPEAT_READS_PER_SALE Stripe list reads, each never waited on past the sweep's deadline, then one EVAL that
 * marks and counts in one step (INTRO_REPEAT_COUNT_IF: SET NX, HINCRBY and EXPIRE inside, four billed); at most
 * INTRO_REPEAT_CHECKS_PER_PASS sales a store's pass, the rest on the next pass. One HMGET when the memberships page is
 * drawn. Run after the order confirmations, so it never takes their time.
 */
import { normaliseEmail } from "@/lib/auth";
import { isSettled } from "@/lib/instant-pay";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { STRIPE_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { onAccount } from "@/lib/stripe-account";
import { saleHandles, type Store } from "@/lib/store";

/** The most paid sales at an introductory price one store's sweep pass looks at; the rest wait for the next pass. */
export const INTRO_REPEAT_CHECKS_PER_PASS = 20;
/** Stripe list reads for one sale at the most: the address as the buyer typed it, and as it is kept. */
export const INTRO_REPEAT_READS_PER_SALE = 2;
/**
 * Days a store's month of counts is kept after its last count: long enough that this month's (the one the memberships
 * page shows) never runs out before the month ends, and the last month's can still be read early in the next.
 */
export const INTRO_REPEAT_KEEP_DAYS = 62;
/** Days a checkout's mark is kept: longer than the day the sweep reads back (CONFIRM_WITHIN_SECONDS). */
export const INTRO_REPEAT_MARK_DAYS = 2;

const countKey = (statsId: string, month: string) => `nl:intro:rep:${statsId}:${month}`;
const markKey = (session: string) => `nl:intro:rep:paid:${session}`;
const SESSION_PATTERN = /^cs_[A-Za-z0-9_]{1,250}$/;
const STATS_PATTERN = /^[0-9a-f]{32}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const INTRO_COUNT = /^[1-9][0-9]?$/;

export type IntroRepeatMonth = { repeat: number; first: number; unknown: number };
type Outcome = keyof IntroRepeatMonth;
type Row = Record<string, unknown>;
type Ask = (method: "GET", account: string, path: string, body?: undefined, version?: undefined, idempotencyKey?: undefined, timeoutMs?: number) => Promise<Record<string, unknown>>;

/**
 * A sale's mark and its count, in one step (lib/redis-memory.ts models it; scripts/test_intro_repeat_redis.py runs it on
 * a real Redis): KEYS[1] the checkout's mark, KEYS[2] its store's month; ARGV the outcome's field, the mark's seconds,
 * the month's seconds. Counted only when the mark was not there: 1 counted, 0 already counted. A count that fails
 * leaves no mark, so the next pass counts the sale (pre-review of 099b23b129).
 */
export const INTRO_REPEAT_COUNT_IF = `-- marktmorgen:intro-repeat-count:v1
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[2]) then return 0 end
redis.call('HINCRBY', KEYS[2], ARGV[1], 1)
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1`;

/** A read not waited on past the deadline: "late" when the time ran out first (the sale waits for the next pass). */
async function before<T>(deadline: number, work: (ms: number) => Promise<T>): Promise<T | "late"> {
  const left = deadline - Date.now();
  if (left < 50) return "late";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), left);
  });
  try {
    return await Promise.race([work(Math.min(left, STRIPE_TIMEOUT_MS)), late]);
  } finally {
    clearTimeout(timer);
  }
}

const metaOf = (row: Row): Record<string, unknown> => (row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {});
const createdOf = (row: Row): number | null => (typeof row.created === "number" && Number.isSafeInteger(row.created) && row.created > 0 ? row.created : null);

/** A paid membership of this store, at its introductory price, with its id and its time. */
function introSale(row: Row, handles: Set<string>): boolean {
  const meta = metaOf(row);
  return (
    typeof row.id === "string" &&
    SESSION_PATTERN.test(row.id) &&
    row.mode === "subscription" &&
    isSettled(row) &&
    createdOf(row) !== null &&
    typeof meta.store === "string" &&
    handles.has(meta.store) &&
    typeof meta.product === "string" &&
    meta.product !== "" &&
    typeof meta.intro === "string" &&
    INTRO_COUNT.test(meta.intro)
  );
}

/** Whether the address of `row` paid for the same membership of this store before it: never "first" on a guess; "late" when the deadline came first. */
async function hadBefore(store: Store, row: Row, handles: Set<string>, ask: Ask, deadline: number): Promise<Outcome | "late"> {
  const details = row.customer_details && typeof row.customer_details === "object" ? (row.customer_details as Record<string, unknown>) : {};
  const email = typeof details.email === "string" && details.email.trim() ? details.email : typeof row.customer_email === "string" && row.customer_email.trim() ? row.customer_email : "";
  const account = store.stripeAccountId;
  if (!email || !account) return "unknown";
  const product = metaOf(row).product;
  const created = createdOf(row) as number;
  let whole = true;
  for (const variant of [...new Set([email.trim(), normaliseEmail(email)])].slice(0, INTRO_REPEAT_READS_PER_SALE)) {
    let listed: Record<string, unknown> | "late";
    try {
      const path = `/checkout/sessions?${new URLSearchParams({ "customer_details[email]": variant, status: "complete", limit: "100" })}`;
      listed = await before(deadline, (ms) => ask("GET", account, path, undefined, undefined, undefined, ms));
    } catch (error) {
      console.error("intro-repeat: reading an address's earlier checkouts failed; counted as unknown", store.handle, error instanceof Error ? error.message : "");
      return "unknown";
    }
    if (listed === "late") return "late";
    if (!listed || !Array.isArray(listed.data) || (listed.has_more !== true && listed.has_more !== false)) return "unknown";
    const earlier = (listed.data as unknown[]).some((item) => {
      if (!item || typeof item !== "object") return false;
      const other = item as Row;
      const meta = metaOf(other);
      const at = createdOf(other);
      return (
        other.id !== row.id &&
        other.mode === "subscription" &&
        isSettled(other) &&
        typeof meta.store === "string" &&
        handles.has(meta.store) &&
        meta.product === product &&
        at !== null &&
        at <= created
      );
    });
    if (earlier) return "repeat";
    if (listed.has_more === true) whole = false;
  }
  return whole ? "first" : "unknown";
}

/**
 * Looks at each paid membership at its introductory price among `paid` (one page of the sweep) not counted yet, and
 * counts it in its store's month. Returns how many were counted. Which ones were counted is read first, in one MGET for
 * the page, so the ones already counted never take the pass's INTRO_REPEAT_CHECKS_PER_PASS places (pre-review of
 * 099b23b129). A read the deadline cuts, or a mark read in another shape, leaves the sale for the next pass; the mark
 * and the count are written together after the read (INTRO_REPEAT_COUNT_IF), so a count that fails is tried again,
 * and one that already ran is never counted twice. Never throws.
 */
export async function noteIntroRepeats(store: Store, paid: Row[], deadline: number, ask: Ask = onAccount): Promise<number> {
  if (!isRedisConfigured() || !STATS_PATTERN.test(store.statsId ?? "") || !store.stripeAccountId) return 0;
  const handles = saleHandles(store);
  const sales = paid.filter((row) => introSale(row, handles));
  if (!sales.length || Date.now() >= deadline) return 0;
  let waiting: Row[];
  try {
    const read = repliesFor(await redisPipeline([["MGET", ...sales.map((row) => markKey(row.id as string))]]), 1);
    const marks = read ? repliesFor(read[0], sales.length) : null;
    if (!marks) return 0;
    // Only an exact nil is a sale not counted yet; anything else waits (counted, or not known).
    waiting = sales.filter((_, i) => marks[i] === null).slice(0, INTRO_REPEAT_CHECKS_PER_PASS);
  } catch (error) {
    console.error("intro-repeat: the marks of a page could not be read; its sales wait for the next pass", store.handle, error instanceof Error ? error.message : "");
    return 0;
  }
  let counted = 0;
  for (const row of waiting) {
    if (Date.now() >= deadline) break;
    const id = row.id as string;
    try {
      const outcome = await hadBefore(store, row, handles, ask, deadline);
      if (outcome === "late") break;
      const month = new Date((createdOf(row) as number) * 1000).toISOString().slice(0, 7);
      const keys = [markKey(id), countKey(store.statsId as string, month)];
      const done = repliesFor(await redisPipeline([["EVAL", INTRO_REPEAT_COUNT_IF, 2, ...keys, outcome, INTRO_REPEAT_MARK_DAYS * 86_400, INTRO_REPEAT_KEEP_DAYS * 86_400]]), 1);
      const n = done ? countOf(done[0]) : null;
      if (n === 1) counted += 1;
      else if (n !== 0) console.error("intro-repeat: a count answered in an unknown shape; the sale is looked at again on the next pass if it did not land", store.handle);
    } catch (error) {
      console.error("intro-repeat: a paid checkout could not be counted; it waits for the next pass", store.handle, error instanceof Error ? error.message : "");
    }
  }
  return counted;
}

/** A store's counts of a month (yyyy-mm), this month when not said; null when they cannot be read exactly. */
export async function introRepeatMonth(statsId: string | null, month = new Date().toISOString().slice(0, 7)): Promise<IntroRepeatMonth | null> {
  if (!statsId || !STATS_PATTERN.test(statsId) || !MONTH_PATTERN.test(month) || !isRedisConfigured()) return null;
  const read = repliesFor(await redisPipeline([["HMGET", countKey(statsId, month), "repeat", "first", "unknown"]]), 1);
  const values = read ? repliesFor(read[0], 3) : null;
  if (!values) return null;
  // HMGET answers each count as text (nil before the first): anything else is unknown, never 0.
  const [repeat, first, unknown] = values.map((value) => (value === null ? 0 : typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : null));
  if (repeat === null || first === null || unknown === null) return null;
  return { repeat, first, unknown };
}

/**
 * The line the memberships page shows: the month's sales at the introductory price by an email address that had paid
 * for the same membership before, and those that could not be checked, this month in UTC; empty when there is neither;
 * said as not read when the counts could not be read (null), never as none.
 */
export function introRepeatWords(month: IntroRepeatMonth | null): string {
  if (month === null) return "Introductory prices paid again this month (UTC): the count could not be read just now. This does not mean there were none.";
  if (!month.repeat && !month.unknown) return "";
  const sales = (n: number) => `${n} ${n === 1 ? "sale" : "sales"}`;
  const parts: string[] = [];
  if (month.repeat) parts.push(`${sales(month.repeat)} at the introductory price went to buyers with the same email address as an earlier paid membership of the same product, this month (UTC).`);
  if (month.unknown) parts.push(`For ${sales(month.unknown)} at the introductory price this month (UTC), whether the same email address had paid for it before could not be checked.`);
  return `${parts.join(" ")} Stripe gives the introductory price to anyone who starts the membership.`;
}
