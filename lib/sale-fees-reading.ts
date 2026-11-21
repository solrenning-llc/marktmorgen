/**
 * Reading fees and net from the creator's own Stripe account (282 [HG1],
 * unit 3). Read-only: a GET of the account's balance transactions with
 * their sources (so a refund or dispute names its charge), from the first
 * day of the year's oldest month shown (readingSince, in UTC), newest
 * first, SALE_FEES_PAGE_SIZE a page, at most SALE_FEES_PAGES pages one after
 * another. When the pages run out before the year does, the reading says how
 * far back it reached: the second after its oldest line, whose second may
 * go on beyond the last page, so its lines are left out; older months are
 * then unknown (lib/sale-fees-months.ts), never lower.
 *
 * The ceiling before the call (MR): one of the store's SALE_FEES_READINGS_PER_DAY
 * readings of the UTC day is taken before Stripe is asked (SET NX, INCRBY,
 * DECRBY when past the figure; an unreadable count is a refusal). A reading
 * that called Stripe stays counted, whatever came back. The cost is its own
 * line (tests/plan-cost-registry.ts, sale-fees-reading).
 *
 * The copy: what was read is kept SALE_FEES_KEEP_SECONDS for the page and the
 * download, shown without asking again while it is SALE_FEES_FRESH_SECONDS
 * old; past the day's readings the last copy is shown as stale, and a
 * reading that failed shows it as failed. With none, the page says so: never
 * a zero. The copy keeps only the money fields of each line (amounts, fees,
 * type, time, ids and the charge a refund or dispute is for); a buyer's
 * name, address, card or anything else Stripe sends with the source is never
 * kept. A copy larger than SALE_FEES_COPY_MAX_BYTES is not kept.
 *
 * A page in any other shape (not a list, no has_more, more said and nothing
 * given, more than a page, a line without an id) or a Stripe error fails the
 * whole reading: no part of a reading is ever shown as the whole.
 *
 *   nl:salefees:copy:<statsId>       { at, since, lines }, a day
 *   nl:salefees:day:<statsId>:<day>  the day's readings, two days
 */
import { readingSince } from "@/lib/earnings-by-month";
import { nextUtcMidnight } from "@/lib/local-clock";
import type { ReadShape } from "@/lib/read-ceilings";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { keyFor, onAccount } from "@/lib/stripe-account";

/** Readings of a store's fees a UTC day, each taken before Stripe is called. */
export const SALE_FEES_READINGS_PER_DAY = 3;
/** Pages of the account's balance transactions one reading reads at the most. */
export const SALE_FEES_PAGES = 5;
/** Lines a page: Stripe's largest. */
export const SALE_FEES_PAGE_SIZE = 100;
/** How long a copy is shown without asking Stripe again. */
export const SALE_FEES_FRESH_SECONDS = 3_600;
/** How long a copy is kept, to show when the day's readings are used. */
export const SALE_FEES_KEEP_SECONDS = 86_400;
/** The largest copy kept, in bytes: SALE_FEES_PAGES × SALE_FEES_PAGE_SIZE lines of the money fields at their largest. */
export const SALE_FEES_COPY_MAX_BYTES = 262_144;
/** Database commands of one reading at the most: the copy read, the day's count (SET NX, INCRBY, DECRBY) and the copy written. */
export const SALE_FEES_READ_COMMANDS = 1 + 3 + 1;
/** One reading at its worst, in the shape lib/read-ceilings.ts prices: every page waited on one after another. */
export const SALE_FEES_READ_SHAPE: ReadShape = {
  seconds: 2,
  cpu: 1,
  commands: SALE_FEES_READ_COMMANDS,
  dbBytes: 2 * SALE_FEES_COPY_MAX_BYTES,
  outBytes: 0,
  stripePages: SALE_FEES_PAGES,
};

const copyKey = (statsId: string) => `nl:salefees:copy:${statsId}`;
const dayKey = (statsId: string, now: number) => `nl:salefees:day:${statsId}:${new Date(now).toISOString().slice(0, 10)}`;
const DAY_KEY_SECONDS = 2 * 86_400;

export type SaleFeesKept = { lines: unknown[]; since: number; at: number; stale: boolean; failed?: boolean };
export type SaleFeesState =
  | { kind: "read"; kept: SaleFeesKept }
  | { kind: "none" }
  | { kind: "not_configured" }
  | { kind: "used"; backAt: number }
  | { kind: "failed" };

type Account = { statsId?: string | null; stripeAccountId?: string | null };

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const prim = (v: unknown): string | number | boolean | null => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null);
const idOf = (v: unknown): string | null => (typeof v === "string" ? v : record(v) && typeof v.id === "string" ? v.id : null);

/** One line, its money fields only: never a person's name, address, card or anything else of its source. */
function moneyFields(line: Record<string, unknown>): Record<string, unknown> {
  const source = line.source;
  const details = Array.isArray(line.fee_details)
    ? line.fee_details.map((d) => (record(d) ? { amount: prim(d.amount), currency: prim(d.currency), type: prim(d.type) } : null))
    : null;
  return {
    id: prim(line.id),
    object: prim(line.object),
    amount: prim(line.amount),
    currency: prim(line.currency),
    fee: prim(line.fee),
    fee_details: details,
    net: prim(line.net),
    type: prim(line.type),
    reporting_category: prim(line.reporting_category),
    created: prim(line.created),
    source: record(source) ? { id: idOf(source), charge: idOf(source.charge) } : prim(source),
  };
}

class PageRefused extends Error {}

/** The pages of one reading. Throws on a page in any other shape or a Stripe error. */
async function readPages(account: string, now: number): Promise<{ lines: Record<string, unknown>[]; since: number }> {
  const sinceMs = readingSince(now, "UTC");
  const sinceSeconds = Math.floor(sinceMs / 1000);
  const lines: Record<string, unknown>[] = [];
  let after = "";
  for (let page = 0; page < SALE_FEES_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(SALE_FEES_PAGE_SIZE), "created[gte]": String(sinceSeconds), "expand[]": "data.source" });
    if (after) query.set("starting_after", after);
    const reply = await onAccount("GET", account, `/balance_transactions?${query}`);
    const data = reply.data;
    if (reply.object !== "list" || !Array.isArray(data) || typeof reply.has_more !== "boolean" || data.length > SALE_FEES_PAGE_SIZE) throw new PageRefused();
    for (const item of data) {
      if (!record(item) || typeof item.id !== "string" || !item.id) throw new PageRefused();
      lines.push(moneyFields(item));
    }
    if (!reply.has_more) return { lines, since: sinceMs };
    if (!data.length) throw new PageRefused();
    after = (data[data.length - 1] as { id: string }).id;
  }
  // The pages ran out: the reading reaches back to the second after its oldest line, whose second may go on.
  const times = lines.map((l) => l.created);
  if (!times.length || !times.every((t): t is number => typeof t === "number" && Number.isSafeInteger(t))) throw new PageRefused();
  const oldest = Math.min(...(times as number[]));
  return { lines: lines.filter((l) => (l.created as number) > oldest), since: (oldest + 1) * 1000 };
}

/** One of the day's readings, taken whole or not at all; an unreadable count is a refusal. */
async function takeReading(statsId: string, now: number): Promise<boolean> {
  const key = dayKey(statsId, now);
  try {
    const replies = repliesFor(await redisPipeline([["SET", key, "0", "NX", "EX", DAY_KEY_SECONDS], ["INCRBY", key, 1]]), 2);
    const count = replies ? countOf(replies[1]) : null;
    if (count === null || count < 1) return false;
    if (count <= SALE_FEES_READINGS_PER_DAY) return true;
    await redisPipeline([["DECRBY", key, 1]]).catch(() => {});
    return false;
  } catch {
    return false;
  }
}

async function readCopy(statsId: string): Promise<SaleFeesKept | null> {
  try {
    const replies = repliesFor(await redisPipeline([["GET", copyKey(statsId)]]), 1);
    const raw = replies?.[0];
    if (typeof raw !== "string") return null;
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed) || !Number.isSafeInteger(parsed.at) || !Number.isSafeInteger(parsed.since) || !Array.isArray(parsed.lines)) return null;
    return { lines: parsed.lines, since: parsed.since as number, at: parsed.at as number, stale: false };
  } catch {
    return null;
  }
}

/**
 * The store's fees and net, as kept or read now. `fresh` asks Stripe again
 * even when the copy is fresh, while the day has a reading left.
 */
export async function keptSaleFees(store: Account, now = Date.now(), fresh = false): Promise<SaleFeesState> {
  const { statsId, stripeAccountId: account } = store;
  if (!statsId || !account || !isRedisConfigured()) return { kind: "none" };
  if (!keyFor(account)) return { kind: "not_configured" };
  const copy = await readCopy(statsId);
  if (copy && !fresh && now - copy.at >= 0 && now - copy.at < SALE_FEES_FRESH_SECONDS * 1000) return { kind: "read", kept: copy };
  if (!(await takeReading(statsId, now))) return copy ? { kind: "read", kept: { ...copy, stale: true } } : { kind: "used", backAt: nextUtcMidnight(now) };
  let read: { lines: Record<string, unknown>[]; since: number };
  try {
    read = await readPages(account, now);
  } catch {
    // Stripe was called: the reading stays counted.
    return copy ? { kind: "read", kept: { ...copy, stale: true, failed: true } } : { kind: "failed" };
  }
  const text = JSON.stringify({ at: now, since: read.since, lines: read.lines });
  if (Buffer.byteLength(text, "utf8") <= SALE_FEES_COPY_MAX_BYTES) {
    await redisPipeline([["SET", copyKey(statsId), text, "EX", SALE_FEES_KEEP_SECONDS]]).catch(() => {});
  }
  return { kind: "read", kept: { lines: read.lines, since: read.since, at: now, stale: false } };
}
