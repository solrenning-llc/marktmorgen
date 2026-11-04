import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { reserveFundedExposure } from "@/lib/exposure-budget";
import { CURRENT_EXPOSURE_BUDGET_POLICY, exposureBudgetConfiguration, type ExposureBudgetPolicy, type ExposureFundingContext } from "@/lib/exposure-budget-policy";
import { CURRENT_COMMERCIAL_MARGIN_REVIEW, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT } from "@/lib/commercial-margin";
import { HELD_RECHECKS_PER_DAY, HELD_RETRY_COUNTER_SECONDS, HELD_MONTH_COUNT_SECONDS, heldStoreFundingFloorCents } from "@/lib/held-store-rules";

const INDEX = "nl:held:stores";
const refValid = (ref: string) => typeof ref === "string" && ref.length > 0 && Buffer.byteLength(ref) <= 1280;
const identity = (ref: string) => "held_" + createHash("sha256").update(ref).digest("hex");
const dayOf = (now: number): string | null => {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !day.startsWith("0000") ? day : null;
};
const number = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const ack = (reply: unknown): boolean => {
  if (!Array.isArray(reply) || Object.getOwnPropertySymbols(reply).length) return false;
  const length = Object.getOwnPropertyDescriptor(reply, "length"), value = Object.getOwnPropertyDescriptor(reply, "0");
  return Boolean(length && Object.hasOwn(length, "value") && length.value === 1 && value && Object.hasOwn(value, "value") && value.value === 1);
};

/** One store/day and a site-wide day ceiling, committed before any Stripe read.
 * A lost reply keeps the claim consumed. No money or retention is released. */
export const CLAIM_HELD_RECHECK = `-- marktmorgen:held-recheck:v1
local t=redis.call('TYPE',KEYS[1]).ok
if t~='none' and t~='hash' then return -1 end
local raw=redis.call('HGET',KEYS[1],'count')
if t=='hash' and not raw then return -1 end
if raw and (not string.match(raw,'^%d+$') or (raw~='0' and string.sub(raw,1,1)=='0')) then return -1 end
local n=tonumber(raw or '0')
if not n or n<0 or n~=math.floor(n) or n>tonumber(ARGV[2]) then return -1 end
local seen=redis.call('HGET',KEYS[1],ARGV[1])
if seen then if seen~='1' then return -1 end return 0 end
if n>=tonumber(ARGV[2]) then return 0 end
redis.call('HINCRBY',KEYS[1],'count',1)
redis.call('HSET',KEYS[1],ARGV[1],'1')
redis.call('EXPIRE',KEYS[1],ARGV[3])
return 1
`;
export type HeldFunding = { policy: ExposureBudgetPolicy | null; context: ExposureFundingContext };
const currentFunding = (): HeldFunding => ({ policy: CURRENT_EXPOSURE_BUDGET_POLICY, context: { termsSnapshot: CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, review: CURRENT_COMMERCIAL_MARGIN_REVIEW?.fundedExposure ?? null } });
/** Existing post_cancellation reserve enforces the global reviewed case ceiling.
 * The unapproved current policy stays null; an unknown cost is never zero. */
export async function fundHeldStore(ref: string, now: number, funding: HeldFunding = currentFunding()): Promise<boolean> {
  if (!refValid(ref) || dayOf(now) === null) return false;
  const config = exposureBudgetConfiguration(funding.policy, funding.context, new Date(now));
  const allocation = config?.allocations.post_cancellation;
  if (!config || !allocation || allocation.slots === 0 || allocation.cents < heldStoreFundingFloorCents()) return false;
  return reserveFundedExposure(identity(ref), "post_cancellation", funding.policy, funding.context);
}
/** CX-69: the known two-read retry line and daily work ceiling are independent
 * of the retention review. An unknown retention budget cannot freeze recovery. */
export async function claimHeldRecheck(ref: string, now: number): Promise<boolean> {
  const day = dayOf(now);
  if (!refValid(ref) || day === null || !isRedisConfigured()) return false;
  try {
    const reply = await redisPipeline([["EVAL", CLAIM_HELD_RECHECK, 1, "nl:held:retry:" + day, identity(ref), HELD_RECHECKS_PER_DAY, HELD_RETRY_COUNTER_SECONDS]]);
    return ack(reply) && dayOf(Date.now()) === day;
  } catch { return false; }
}
export async function heldStoreKnown(ref: string): Promise<boolean> {
  const [score] = await redisPipeline([["ZSCORE", INDEX, ref]]);
  if (score === null) return false;
  if (number(score) === null) throw new Error("held store observation is unknown");
  return true;
}
export async function heldStoresDue(now: number): Promise<string[]> {
  if (dayOf(now) === null) return [];
  const [rows] = await redisPipeline([["ZRANGEBYSCORE", INDEX, "-inf", now, "LIMIT", 0, HELD_RECHECKS_PER_DAY]]);
  if (!Array.isArray(rows) || rows.some(ref => !refValid(ref))) throw new Error("held store candidates are unknown");
  return rows as string[];
}
/** Index changes invalidate the monthly observation in the same Redis operation. */
export const NOTE_HELD_CLOSING = `-- marktmorgen:held-state:v1
local t=redis.call('TYPE',KEYS[1]).ok
local m=redis.call('TYPE',KEYS[2]).ok
if (t~='none' and t~='zset') or (m~='none' and m~='hash') then return -1 end
if ARGV[1]=='1' then redis.call('ZADD',KEYS[1],ARGV[3],ARGV[2]) else redis.call('ZREM',KEYS[1],ARGV[2]) end
redis.call('HDEL',KEYS[2],'complete')
return 1
`;
export const RECORD_HELD_MONTH = `-- marktmorgen:held-month:v1
local t=redis.call('TYPE',KEYS[1]).ok
local m=redis.call('TYPE',KEYS[2]).ok
if (t~='none' and t~='zset') or (m~='none' and m~='hash') then return -1 end
local raw=redis.call('HGET',KEYS[2],'peak')
if raw and (not string.match(raw,'^%d+$') or (raw~='0' and string.sub(raw,1,1)=='0')) then return -1 end
local peak=tonumber(raw or '0')
if not peak or peak>9007199254740991 then return -1 end
local n=redis.call('ZCARD',KEYS[1])
redis.call('HSET',KEYS[2],'count',n,'peak',math.max(n,peak),'day',ARGV[1],'complete',ARGV[2])
redis.call('EXPIRE',KEYS[2],ARGV[3])
return 1
`;
/** Existing obligations are always counted, including reserve exhaustion; never
 * delete a store or hide an over-cap obligation to make funding appear sound. */
export async function noteHeldClosing(ref: string, held: boolean, now: number, funding?: HeldFunding): Promise<void> {
  const day = dayOf(now);
  if (!refValid(ref) || day === null) throw new Error("held store identity or clock is unknown");
  if (held) await fundHeldStore(ref, now, funding);
  const nextDay = Date.parse(day + "T00:00:00Z") + 86400_000;
  const reply = await redisPipeline([["EVAL", NOTE_HELD_CLOSING, 2, INDEX, "nl:held:month:" + day.slice(0, 7), held ? 1 : 0, ref, nextDay]]);
  if (!ack(reply)) throw new Error("held store update is unknown");
}
/** Atomic daily aggregate only. A partial walk cannot certify a complete count. */
export async function recordHeldMonth(now: number, complete: boolean): Promise<void> {
  const day = dayOf(now);
  if (day === null) throw new Error("held store count clock is unknown");
  const reply = await redisPipeline([["EVAL", RECORD_HELD_MONTH, 2, INDEX, "nl:held:month:" + day.slice(0, 7), day, complete ? 1 : 0, HELD_MONTH_COUNT_SECONDS]]);
  if (!ack(reply)) throw new Error("held store count is unknown");
}
export type HeldMonthCount = { month: string; count: number; peak: number };
export async function readHeldMonth(month: string): Promise<HeldMonthCount | null> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  try {
    const [raw] = await redisPipeline([["HMGET", "nl:held:month:" + month, "count", "peak", "day", "complete"]]);
    if (!Array.isArray(raw) || raw.length !== 4) return null;
    if (Object.getOwnPropertySymbols(raw).length) return null;
    const entries = Array.from({ length: 4 }, (_, i) => Object.getOwnPropertyDescriptor(raw, String(i)));
    if (entries.some(entry => !entry || !Object.hasOwn(entry, "value"))) return null;
    const values = entries.map(entry => entry!.value);
    const count = number(values[0]), peak = number(values[1]);
    const [year, m] = month.split("-").map(Number);
    const last = new Date(0);
    last.setUTCFullYear(year, m, 0);
    const end = last.toISOString().slice(0, 10);
    if (count === null || peak === null || peak < count || values[2] !== end || values[3] !== "1" && values[3] !== 1) return null;
    return { month, count, peak };
  } catch { return null; }
}
