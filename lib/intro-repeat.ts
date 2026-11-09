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
 * The studio's memberships page shows the month's count (introRepeatWords). What it costs: two Redis commands to
 * claim and count, and at most INTRO_REPEAT_READS_PER_SALE Stripe list reads, for each such sale, at most
 * INTRO_REPEAT_CHECKS_PER_PASS sales a store's pass (the rest wait for the next pass, five minutes later), inside the
 * sweep's own deadline; one HMGET when the memberships page is drawn.
 */
import { normaliseEmail } from "@/lib/auth";
import { isSettled } from "@/lib/instant-pay";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { onAccount } from "@/lib/stripe-account";
import { saleHandles, type Store } from "@/lib/store";

/** The most paid sales at an introductory price one store's sweep pass looks at; the rest wait for the next pass. */
export const INTRO_REPEAT_CHECKS_PER_PASS = 20;
/** Stripe list reads for one sale at the most: the address as the buyer typed it, and as it is kept. */
export const INTRO_REPEAT_READS_PER_SALE = 2;
/** Days a store's month of counts is kept after its last count: this month and the last are shown. */
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
type Ask = (method: "GET", account: string, path: string) => Promise<Record<string, unknown>>;

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

/** Whether the address of `row` paid for the same membership of this store before it: never "first" on a guess. */
async function hadBefore(store: Store, row: Row, handles: Set<string>, ask: Ask): Promise<Outcome> {
  const details = row.customer_details && typeof row.customer_details === "object" ? (row.customer_details as Record<string, unknown>) : {};
  const email = typeof details.email === "string" && details.email.trim() ? details.email : typeof row.customer_email === "string" && row.customer_email.trim() ? row.customer_email : "";
  const account = store.stripeAccountId;
  if (!email || !account) return "unknown";
  const product = metaOf(row).product;
  const created = createdOf(row) as number;
  let whole = true;
  for (const variant of [...new Set([email.trim(), normaliseEmail(email)])].slice(0, INTRO_REPEAT_READS_PER_SALE)) {
    let listed: Record<string, unknown>;
    try {
      listed = await ask("GET", account, `/checkout/sessions?${new URLSearchParams({ "customer_details[email]": variant, status: "complete", limit: "100" })}`);
    } catch (error) {
      console.error("intro-repeat: reading an address's earlier checkouts failed; counted as unknown", store.handle, error instanceof Error ? error.message : "");
      return "unknown";
    }
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
 * Looks at each paid membership at its introductory price among `paid` (one page of the sweep), once, and counts it
 * in its store's month. Returns how many were counted. A mark that cannot be taken leaves the sale for the next pass;
 * a count that answers in another shape is logged (the mark stays, so it is never counted twice). Never throws.
 */
export async function noteIntroRepeats(store: Store, paid: Row[], deadline: number, ask: Ask = onAccount): Promise<number> {
  if (!isRedisConfigured() || !STATS_PATTERN.test(store.statsId ?? "") || !store.stripeAccountId) return 0;
  const handles = saleHandles(store);
  const sales = paid.filter((row) => introSale(row, handles)).slice(0, INTRO_REPEAT_CHECKS_PER_PASS);
  let counted = 0;
  for (const row of sales) {
    if (Date.now() >= deadline) break;
    const id = row.id as string;
    try {
      const claim = repliesFor(await redisPipeline([["SET", markKey(id), "1", "NX", "EX", INTRO_REPEAT_MARK_DAYS * 86_400]]), 1);
      // Only "OK" is a claim; nil is a checkout already looked at; anything else waits for the next pass.
      if (!claim || claim[0] !== "OK") continue;
      const outcome = await hadBefore(store, row, handles, ask);
      const month = new Date((createdOf(row) as number) * 1000).toISOString().slice(0, 7);
      const key = countKey(store.statsId as string, month);
      const replies = repliesFor(await redisPipeline([["HINCRBY", key, outcome, 1], ["EXPIRE", key, INTRO_REPEAT_KEEP_DAYS * 86_400]]), 2);
      const n = replies ? countOf(replies[0]) : null;
      if (n === null || n < 1) console.error("intro-repeat: a count answered in an unknown shape; this month's count may be short", store.handle);
      else counted += 1;
    } catch (error) {
      console.error("intro-repeat: a paid checkout could not be looked at", store.handle, error instanceof Error ? error.message : "");
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

/** The line the memberships page shows for a month with a repeat or an unknown; empty when there is neither. */
export function introRepeatWords(month: IntroRepeatMonth): string {
  if (!month.repeat && !month.unknown) return "";
  const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
  const said = `This month, ${people(month.repeat)} who had the same membership before paid its introductory price again.`;
  const unknown = month.unknown ? ` For ${month.unknown} more, whether they had it before could not be checked.` : "";
  return `${said}${unknown} Stripe gives the introductory price to anyone who starts the membership.`;
}
