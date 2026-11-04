/**
 * The numbers as the API (/api/v1/stats) and the MCP tools read them, with a
 * copy kept an hour (decision of 4 November 2026: read cold, the numbers take
 * every page of the creator's Stripe account at its most, about forty of a
 * store's API requests, so a Store plan's month went in a dozen readings).
 *
 *   nl:stats:<statsId>:apinum:<variant>   <seal>.<at>.<the numbers as JSON>
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
 * key belongs to, never anything in the request. The copy is sealed with an
 * HMAC over that id, the variant, what it was read under (its Stripe account,
 * currency and whether it reads sales) and its time, nothing of the API key, under a
 * key derived from the deployment's secret (lib/secret-box.ts): a copy written
 * by anything else, for another store, under another Stripe account, or older
 * than an hour is not used, and the numbers are read again. With no secret,
 * nothing is kept. A copy larger than NUMBERS_KEPT_BYTES is not kept.
 *
 * Two variants: "plain" (the numbers without the products' listings, what
 * /api/v1/stats and get_numbers answer) and "full" (with the listings of the
 * products they name, for the MCP tools about a stretch of days). A "full"
 * reading whose listings were not covered by the requests left is answered
 * without them and not kept.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { deriveKey } from "@/lib/secret-box";
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

/** The seal, its time and the two dots before the numbers: what a kept copy holds beside them. */
const SEAL_HEAD_BYTES = 64;

export const keptNumbersKey = (statsId: string, variant: NumbersVariant) => `nl:stats:${statsId}:apinum:${variant}`;

/**
 * What the numbers were read under, and nothing secret: the store's numbers
 * id, its Stripe account, currency and whether it reads sales. A copy read
 * under anything else is not used. Only these fields go into the seal, never
 * the store record as a whole nor anything that came with the request's key.
 */
function readUnder(store: Store): string {
  return JSON.stringify([String(store.statsId ?? ""), String(store.stripeAccountId ?? ""), String(store.currency), readsSales(store)]);
}

/** The seal: an HMAC under a key derived from the deployment's own secret (lib/secret-box.ts), over the fields above, the variant, the time and the numbers. */
function seal(store: Store, variant: NumbersVariant, at: number, json: string): string | null {
  const key = deriveKey("api-numbers-kept");
  if (!key || !store.statsId) return null;
  return createHmac("sha256", key).update(`${variant}|${readUnder(store)}|${at}|`).update(json).digest("base64url");
}

/** The kept copy, when it is this store's, read under what it is now, and less than an hour old; else null. */
export function openKeptNumbers(store: Store, variant: NumbersVariant, raw: unknown, now = Date.now()): { data: StatsData; at: number } | null {
  if (typeof raw !== "string") return null;
  const first = raw.indexOf(".");
  const second = first < 0 ? -1 : raw.indexOf(".", first + 1);
  if (second < 0) return null;
  const mac = raw.slice(0, first);
  const atText = raw.slice(first + 1, second);
  const json = raw.slice(second + 1);
  if (!/^\d{1,15}$/.test(atText)) return null;
  const at = Number(atText);
  if (!(at <= now && now - at < NUMBERS_KEPT_SECONDS * 1000)) return null;
  const expected = seal(store, variant, at, json);
  if (!expected) return null;
  const given = Buffer.from(mac);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  try {
    const data = JSON.parse(json) as StatsData;
    if (!data || typeof data !== "object" || !Array.isArray(data.days) || !data.totals) return null;
    return { data, at };
  } catch {
    return null;
  }
}

/** The copy as it is kept, sealed; null when it cannot be (no secret, no id) or is too big to keep. */
export function sealKeptNumbers(store: Store, variant: NumbersVariant, data: StatsData, at: number): string | null {
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > NUMBERS_KEPT_BYTES) return null;
  const mac = seal(store, variant, at, json);
  return mac ? `${mac}.${at}.${json}` : null;
}

/**
 * The store's numbers for the API or an MCP tool, paid for first (above):
 * null when they cannot be read, the refusal as it is, or the numbers with
 * when they were read and how to settle what the answer sends.
 */
export async function apiNumbers(store: Store, variant: NumbersVariant, charge: Charge, hold: Hold, now = Date.now()): Promise<ApiNumbers | Response | null> {
  const keeps = Boolean(store.statsId && isRedisConfigured() && deriveKey("api-numbers-kept"));
  const key = store.statsId ? keptNumbersKey(store.statsId, variant) : "";
  let taken = 0;
  if (keeps) {
    const [length] = await redisPipeline([["STRLEN", key]]);
    const bytes = Number(length);
    if (Number.isSafeInteger(bytes) && bytes > 0 && bytes <= NUMBERS_KEPT_BYTES + SEAL_HEAD_BYTES) {
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
    const value = sealKeptNumbers(store, variant, cold.data, now);
    // Best effort: a copy not kept is read again next time, and paid for again.
    if (value) await redisPipeline([["SET", key, value, "EX", NUMBERS_KEPT_SECONDS]]).catch((error) => console.error("keeping the numbers failed", error));
  }
  return { data: cold.data, asOf: new Date(now).toISOString(), listed: cold.listed, settle: async () => null };
}
