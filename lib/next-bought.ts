/**
 * What buyers get next (added 12 October 2026): for each product, which
 * product its buyers went on to buy afterward, how many of them, and how long
 * after, counted from the store's own paid sales.
 *
 * Read before it was built: Kissmetrics and Polar show the order customers buy
 * in, GA4 its path exploration, Triple Whale its product journeys. Each starts
 * from the same question a creator has when choosing what to offer after
 * paying: not what sells, but what the people who bought this went on to buy.
 * "N buyers bought both" (lib/also-bought.ts) said nothing of the order.
 *
 *   - Counted from the store's all-time sales (lib/stats.ts readAllTimeSales),
 *     the same reading "bought both" comes from, by the address each buyer
 *     paid with: one buyer counts once for a pair, however often they bought.
 *   - "Next" is a later purchase: more than an hour after the first one, so a
 *     box ticked at checkout or an offer taken in one click right after paying
 *     — the same visit — is "bought together", not "next".
 *   - Said only from MIN_NEXT buyers up, and only in the creator's studio.
 *   - The time between is the middle one of those buyers' (the median), in
 *     whole days, so one buyer who came back a year later does not move it.
 *
 * Kept a week and read again in the background when the studio opens after six
 * hours: one Redis read for the studio, nothing on a visit to the store.
 *
 *   nl:next:<statsId>   JSON { at, starts, next }
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { BUMP_KEYS } from "@/lib/bundle-rules";

/** Below this many buyers, a sequence is not said. */
export const MIN_NEXT = 3;
/** How many later products are kept for each product. */
export const NEXT_KEPT = 5;
/** Within this long of the first purchase, a second one is the same visit. */
export const SAME_VISIT_SECONDS = 3600;
export const NEXT_FRESH_MS = 6 * 60 * 60 * 1000;
const NEXT_KEEP_SECONDS = 7 * 86_400;

export type NextStep = { id: string; buyers: number; days: number };

export type BuyerPaths = {
  /** When it was read, in ms. */
  at: number;
  /** How many buyers each product was the first purchase of. */
  starts: Record<string, number>;
  /** For each product, what its buyers bought later, the most buyers first. */
  next: Record<string, NextStep[]>;
};

/** One paid sale, as lib/stats.ts reads it: when, what, and the row it came from. */
type SaleRow = { created: number; product: string; row: Record<string, unknown>; upsell: boolean };

const text = (value: unknown) => (typeof value === "string" ? value : "");

function buyerOf(row: Record<string, unknown>): string {
  const details = row.customer_details && typeof row.customer_details === "object" ? (row.customer_details as Record<string, unknown>) : {};
  const email = text(details.email) || text(row.customer_email) || text(row.receipt_email);
  if (email) return `e:${email.trim().toLowerCase()}`;
  const customer = text(row.customer);
  return customer ? `c:${customer}` : "";
}

function productsOf(sale: SaleRow): string[] {
  const meta = sale.row.metadata && typeof sale.row.metadata === "object" ? (sale.row.metadata as Record<string, unknown>) : {};
  return [sale.product, ...(sale.upsell ? [] : BUMP_KEYS.map((key) => text(meta[key])))].filter((id) => id !== "");
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** The paths, from paid sales (`created` in ms). Pure. */
export function pathsFrom(sales: SaleRow[], now = Date.now()): BuyerPaths {
  // When each buyer first bought each product, in seconds.
  const firsts = new Map<string, Map<string, number>>();
  for (const sale of sales) {
    const who = buyerOf(sale.row);
    if (!who) continue;
    const mine = firsts.get(who) ?? new Map<string, number>();
    const at = Math.floor(sale.created / 1000);
    for (const id of productsOf(sale)) {
      if (!mine.has(id) || (mine.get(id) as number) > at) mine.set(id, at);
    }
    firsts.set(who, mine);
  }
  // A product id is read from the sale's metadata, which the creator's own Stripe account can set to anything, even
  // "__proto__" or "constructor": counted in Maps and handed on as plain records of own keys only (tests/proto-keys.test.ts).
  const starts = new Map<string, number>();
  const gaps = new Map<string, Map<string, number[]>>();
  for (const mine of firsts.values()) {
    if (mine.size > 200) continue;
    const ordered = [...mine.entries()].sort((a, b) => a[1] - b[1]);
    // The first purchase, and any product in the same visit as it.
    for (const [id, at] of ordered) if (at - ordered[0][1] <= SAME_VISIT_SECONDS) starts.set(id, (starts.get(id) ?? 0) + 1);
    for (const [a, atA] of ordered) {
      for (const [b, atB] of ordered) {
        if (a === b || atB - atA <= SAME_VISIT_SECONDS) continue;
        const row = gaps.get(a) ?? new Map<string, number[]>();
        row.set(b, [...(row.get(b) ?? []), (atB - atA) / 86_400]);
        gaps.set(a, row);
      }
    }
  }
  const next = new Map<string, NextStep[]>();
  for (const [a, row] of gaps) {
    const kept = [...row.entries()]
      .filter(([, days]) => days.length >= MIN_NEXT)
      .map(([id, days]) => ({ id, buyers: days.length, days: Math.round(median(days)) }))
      .sort((x, y) => y.buyers - x.buyers || x.days - y.days || x.id.localeCompare(y.id))
      .slice(0, NEXT_KEPT);
    if (kept.length) next.set(a, kept);
  }
  return { at: now, starts: Object.fromEntries(starts), next: Object.fromEntries(next) };
}

const nextKey = (statsId: string) => `nl:next:${statsId}`;

/** Whatever came back from storage, made safe to use. */
export function parsePaths(raw: unknown): BuyerPaths | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { at?: unknown; starts?: unknown; next?: unknown };
  if (typeof value.at !== "number") return null;
  const starts = new Map<string, number>();
  for (const [id, n] of Object.entries(value.starts && typeof value.starts === "object" ? (value.starts as Record<string, unknown>) : {})) {
    if (typeof n === "number" && Number.isInteger(n) && n > 0) starts.set(id, n);
  }
  const next = new Map<string, NextStep[]>();
  for (const [id, list] of Object.entries(value.next && typeof value.next === "object" ? (value.next as Record<string, unknown>) : {})) {
    if (!Array.isArray(list)) continue;
    const kept = list
      .filter((s): s is NextStep => Boolean(s) && typeof s.id === "string" && Number.isInteger(s.buyers) && s.buyers >= MIN_NEXT && Number.isInteger(s.days) && s.days >= 0)
      .slice(0, NEXT_KEPT);
    if (kept.length) next.set(id, kept);
  }
  return { at: value.at, starts: Object.fromEntries(starts), next: Object.fromEntries(next) };
}

/** How many bytes what buyers bought next holds as kept, 0 when none, looked up before it is read by a reading that pays for its size (lib/mcp-tools.ts, productsTool); null when it did not come back. */
export async function pathsBytes(statsId: string | null): Promise<number | null> {
  if (!statsId || !isRedisConfigured()) return 0;
  const [n] = await redisPipeline([["STRLEN", nextKey(statsId)]]);
  const bytes = Number(n);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

export async function readPaths(statsId: string | null): Promise<BuyerPaths | null> {
  if (!statsId || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", nextKey(statsId)]]);
  if (typeof raw !== "string" || !raw) return null;
  try {
    return parsePaths(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function keepPaths(statsId: string | null, paths: BuyerPaths): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  await redisPipeline([["SET", nextKey(statsId), JSON.stringify(paths), "EX", NEXT_KEEP_SECONDS]]);
}

/** Whether the studio should have them read again. */
export function pathsStale(paths: BuyerPaths | null, now = Date.now()): boolean {
  return paths === null || now - paths.at > NEXT_FRESH_MS;
}

/** "the same day", "1 day later", "12 days later". */
export function laterWords(days: number): string {
  return days < 1 ? "the same day" : `${days} ${days === 1 ? "day" : "days"} later`;
}

/** Whether this request is the one to read them again: one at a time per store, five minutes apart at most. */
export async function claimPathsRead(statsId: string | null): Promise<boolean> {
  if (!statsId || !isRedisConfigured()) return false;
  const [mine] = await redisPipeline([["SET", `nl:next:lock:${statsId}`, "1", "NX", "EX", 300]]);
  return mine === "OK";
}
