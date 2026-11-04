/**
 * The numbers as the API (/api/v1/stats) and the MCP tools read them, with a
 * copy kept an hour (decision of 4 November 2026: read cold, the numbers take
 * every page of the creator's Stripe account at its most, about forty of a
 * store's API requests, so a Store plan's month went in a dozen readings).
 *
 *   nl:stats:<statsId>:apinum:<variant>   [variant, statsId, Stripe account, currency, sales, at] \n <the numbers as JSON>
 *
 * A reading first looks up how big the copy is (STRLEN). Kept: what reading
 * it and sending the answer may take is set aside (lib/api-guard.ts,
 * holdMoreApi), it is read, and settled at what it read and what the answer
 * sends, before it is sent: a warm reading pays only for the copy. Not kept:
 * the numbers are taken at their most (lib/api-read-rules.ts, numbersWork)
 * with what keeping them costs (NUMBERS_KEEP_WORK), all before anything is
 * read, then read and kept. Every answer says `asOf`, when its numbers were
 * read, in ISO 8601.
 *
 * Whose numbers: the key is the store's own `statsId`, from the store the API
 * key belongs to, never anything in the request, and only the server writes
 * it. The copy carries, in the clear on its first line, the variant, what it
 * was read under (that id, the Stripe account, currency and whether the store
 * reads sales) and when; a reading compares them exactly with the store's own
 * and its clock, so a copy for another store, variant, Stripe account or
 * currency, or older than an hour, is not used, and the numbers are read
 * again. A copy larger than NUMBERS_KEPT_BYTES is not kept.
 *
 * Two variants: "plain" (the numbers without the products' listings, what
 * /api/v1/stats and get_numbers answer) and "full" (with the listings of the
 * products they name, for the MCP tools about a stretch of days). A "full"
 * reading whose listings were not covered by the requests left is answered
 * without them and not kept.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import type { Store } from "@/lib/store";
import { type StatsData, readsSales } from "@/lib/stats";
import { readNumbers } from "@/lib/stats-report";
import { type Charge, type Hold, numbersUnits } from "@/lib/api-read";
import { NUMBERS_KEEP_WORK, NUMBERS_KEPT_BYTES, NUMBERS_KEPT_SECONDS, NUMBERS_SENT_BYTES, apiReadUnits, keptNumbersWork, settledUnits } from "@/lib/api-read-rules";
import { readFullNumbersPaid } from "@/lib/mcp-tools";

export type NumbersVariant = "plain" | "full";

export type ApiNumbers = {
  data: StatsData;
  /** When these numbers were read, ISO 8601: now, or when the kept copy was made. */
  asOf: string;
  /** Whether the products' listings were read ("full" only; "plain" never reads them). */
  listed: boolean;
  /** Settles what was set aside at what the answer sends, before it is sent: null when settled, else the refusal to send instead. */
  settle: (sentBytes: number) => Promise<Response | null>;
};

/** The first line of a kept copy, before the numbers, at its largest: the variant, what they were read under and when. */
const HEAD_BYTES = 512;

export const keptNumbersKey = (statsId: string, variant: NumbersVariant) => `nl:stats:${statsId}:apinum:${variant}`;

/**
 * The first line of a kept copy: the variant, what the numbers were read
 * under, nothing secret (the store's numbers id, its Stripe account, currency
 * and whether it reads sales), and when, as JSON on one line.
 */
function headOf(store: Store, variant: NumbersVariant, at: number): string {
  return JSON.stringify([variant, String(store.statsId ?? ""), String(store.stripeAccountId ?? ""), String(store.currency), readsSales(store), at]);
}

/** The kept copy, when its first line is exactly this store's and this variant's, and less than an hour old; else null. */
export function openKeptNumbers(store: Store, variant: NumbersVariant, raw: unknown, now = Date.now()): { data: StatsData; at: number } | null {
  if (typeof raw !== "string" || !store.statsId) return null;
  const end = raw.indexOf("\n");
  if (end < 0 || end > HEAD_BYTES) return null;
  let at: unknown;
  try {
    at = (JSON.parse(raw.slice(0, end)) as unknown[])[5];
  } catch {
    return null;
  }
  if (typeof at !== "number" || !Number.isSafeInteger(at) || !(at <= now && now - at < NUMBERS_KEPT_SECONDS * 1000)) return null;
  if (raw.slice(0, end) !== headOf(store, variant, at)) return null;
  try {
    const data = JSON.parse(raw.slice(end + 1)) as StatsData;
    if (!data || typeof data !== "object" || !Array.isArray(data.days) || !data.totals) return null;
    return { data, at };
  } catch {
    return null;
  }
}

/** The copy as it is kept: its first line, then the numbers; null when the store has no numbers id or they are too big to keep. */
export function keptNumbersCopy(store: Store, variant: NumbersVariant, data: StatsData, at: number): string | null {
  const json = JSON.stringify(data);
  if (!store.statsId || Buffer.byteLength(json) > NUMBERS_KEPT_BYTES) return null;
  return `${headOf(store, variant, at)}\n${json}`;
}

/**
 * The store's numbers for the API or an MCP tool, paid for first (above):
 * null when they cannot be read, the refusal as it is, or the numbers with
 * when they were read and how to settle what the answer sends.
 */
export async function apiNumbers(store: Store, variant: NumbersVariant, charge: Charge, hold: Hold, now = Date.now()): Promise<ApiNumbers | Response | null> {
  const keeps = Boolean(store.statsId && isRedisConfigured());
  const key = store.statsId ? keptNumbersKey(store.statsId, variant) : "";
  let taken = 0;
  if (keeps) {
    const [length] = await redisPipeline([["STRLEN", key]]);
    const bytes = Number(length);
    if (Number.isSafeInteger(bytes) && bytes > 0 && bytes <= NUMBERS_KEPT_BYTES + HEAD_BYTES + 1) {
      const most = apiReadUnits(keptNumbersWork(bytes, NUMBERS_SENT_BYTES));
      const settle = await hold(most);
      if (settle instanceof Response) return settle;
      const [raw] = await redisPipeline([["GET", key]]);
      // What the read really answered, if the copy was written again in between.
      const read = Math.max(bytes, typeof raw === "string" ? Buffer.byteLength(raw) : 0);
      const kept = openKeptNumbers(store, variant, raw, now);
      if (kept) {
        return {
          data: kept.data,
          asOf: new Date(kept.at).toISOString(),
          listed: true,
          settle: (sent) => settle(settledUnits(keptNumbersWork(read, sent), most)),
        };
      }
      // Gone, old or not this store's since it was measured: what was set aside to send is given back, and the numbers are read as below.
      taken = settledUnits(keptNumbersWork(read, 0), most);
      const refused = await settle(taken);
      if (refused) return refused;
    }
  }
  const units = await numbersUnits(store, keeps ? NUMBERS_KEEP_WORK : {});
  const refused = await charge(units, taken);
  if (refused) return refused;
  const cold = variant === "full" ? await readFullNumbersPaid(store, charge, now, taken + units) : await readNumbers(store, now).then((data) => (data ? { data, listed: true } : null));
  if (!cold) return null;
  if (keeps && cold.listed) {
    const value = keptNumbersCopy(store, variant, cold.data, now);
    // Best effort: a copy not kept is read again next time, and paid for again.
    if (value) await redisPipeline([["SET", key, value, "EX", NUMBERS_KEPT_SECONDS]]).catch((error) => console.error("keeping the numbers failed", error));
  }
  return { data: cold.data, asOf: new Date(now).toISOString(), listed: cold.listed, settle: async () => null };
}
