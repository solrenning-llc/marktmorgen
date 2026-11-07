/**
 * Holding one of the month's places for a store that pays nothing
 * (lib/free-pool-rules.ts). A store that pays is let through without a
 * command. One that does not is let through when it already holds a place
 * this calendar month, or when one is free and it takes it.
 *
 *   nl:free:in:<month>:<store>   "1" holds a place for the month, "0" was turned away this hour
 *   nl:free:n:<month>            places handed out this month
 *
 * Unknown is closed: a count that cannot be read or written is a store not
 * let through, so nothing it would do is charged to us unbounded.
 */
import { createHash } from "node:crypto";
import { calendarWindow } from "@/lib/allowance-window";
import { FREE_POOL_BASE_STORES, PAYING_INDEX, freePoolSize } from "@/lib/free-pool-rules";
import { type PlanFields, standingOf } from "@/lib/plan-standing";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { claimMark } from "@/lib/claim-mark";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { textCountOf } from "@/lib/redis-count";

const KEEP_SECONDS = 40 * 86_400;
const REFUSED_SECONDS = 3_600;
const inKey = (month: string, id: string) => `nl:free:in:${month}:${id}`;
const countKey = (month: string) => `nl:free:n:${month}`;

type PoolStore = PlanFields & { sid?: string; statsId?: string | null; handle?: string };

/** What a store is counted by: its id, or what it is kept under, hashed. */
function idOf(store: PoolStore): string | null {
  const raw = store.sid || store.statsId || store.handle || "";
  return raw ? createHash("sha256").update(`free-pool:${raw}`).digest("hex").slice(0, 32) : null;
}

/**
 * This store's place this month: "in" when it pays or holds one, "full" when
 * the places are taken, "unknown" when it could not be counted (no id, no
 * database, or the database did not answer), so a refusal can say which.
 */
export async function poolPlace(store: PoolStore, now = Date.now()): Promise<"in" | "full" | "unknown"> {
  if (standingOf(store, now / 1000) === "paid") return "in";
  const id = idOf(store);
  if (!id || !isRedisConfigured()) return "unknown";
  const month = calendarWindow(now).id;
  try {
    const [held] = await redisPipeline([["GET", inKey(month, id)]]);
    if (held === "1") return "in";
    if (held === "0") return "full";
    const [taken, , paying] = await redisPipeline([
      ["INCR", countKey(month)],
      ["EXPIRE", countKey(month), KEEP_SECONDS],
      ["SCARD", PAYING_INDEX],
    ]);
    const n = Number(taken);
    // A reply that is not a count says nothing about the places: unknown, and no refusal is written down.
    if (!Number.isSafeInteger(n) || n < 1) return "unknown";
    const fits = Number.isSafeInteger(n) && n >= 1 && n <= freePoolSize(Number(paying) || 0);
    // A place not handed out is not counted, so a ceiling that grows later has it free.
    if (!fits && Number.isSafeInteger(n) && n >= 1) await redisPipeline([["DECR", countKey(month)]]);
    // A place held lasts the month; a refusal an hour, so a store asks again when places grow.
    // Read exactly (CX-123 rule 24): written, or read back holding this same answer, it stands; holding the other one,
    // written a moment earlier by another request, that one stands; unreadable, the store is not let through.
    const set = await claimMark(inKey(month, id), fits ? KEEP_SECONDS : REFUSED_SECONDS, fits ? "1" : "0");
    if (set === "unknown") return "unknown";
    if (set === "taken") {
      // Decided a moment ago by another request: that answer stands, and the
      // place this one counted is not handed out again.
      // Read exactly (Codex CX1 on #2723): one reply, "1" or "0"; anything else is not known, never a place.
      const read = repliesFor(await redisPipeline([["GET", inKey(month, id)]]), 1);
      const again = read ? read[0] : undefined;
      return again === "1" ? "in" : again === "0" ? "full" : "unknown";
    }
    return fits ? "in" : "full";
  } catch {
    return "unknown";
  }
}

/** Whether this store may do something that costs us now: always when it pays, and with a place this month when it does not. */
export async function admitNonPaying(store: PoolStore, now = Date.now()): Promise<boolean> {
  return (await poolPlace(store, now)) === "in";
}

/**
 * Places handed out this month, and how many there are, for the owner's own checks.
 * Each read exactly (rule 24): a counter that is not there is none handed out; a reply
 * in any other shape is unknown (null), shown as unknown, never as 0 taken nor the smallest pool.
 */
export async function poolThisMonth(now = Date.now()): Promise<{ taken: number | null; size: number | null }> {
  if (!isRedisConfigured()) return { taken: 0, size: FREE_POOL_BASE_STORES };
  const replies = repliesFor(await redisPipeline([["GET", countKey(calendarWindow(now).id)], ["SCARD", PAYING_INDEX]]), 2);
  const taken = textCountOf(replies?.[0]);
  const paying = countOf(replies?.[1]);
  return { taken: taken === "absent" ? 0 : taken, size: paying === null ? null : freePoolSize(paying) };
}
