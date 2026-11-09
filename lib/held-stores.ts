import { createHash } from "node:crypto";
import { types } from "node:util";
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
/** Redis replies are evidence only as ordinary, dense arrays of own data.
 * Native Proxy detection must precede every reflective operation, so a reply
 * cannot run a trap while pretending to be complete. */
const exactArray = (reply: unknown): unknown[] | null => {
  if (!Array.isArray(reply) || types.isProxy(reply) || Object.getPrototypeOf(reply) !== Array.prototype) return null;
  if (Object.getOwnPropertySymbols(reply).length) return null;
  const length = Object.getOwnPropertyDescriptor(reply, "length");
  if (!length || !Object.hasOwn(length, "value") || !Number.isSafeInteger(length.value) || length.value < 0) return null;
  if (Reflect.ownKeys(reply).length !== length.value + 1) return null;
  const values: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const field = Object.getOwnPropertyDescriptor(reply, String(index));
    if (!field || !field.enumerable || !Object.hasOwn(field, "value")) return null;
    values.push(field.value);
  }
  return values;
};
const ack = (reply: unknown): boolean => {
  const values = exactArray(reply);
  return values?.length === 1 && values[0] === 1;
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
  const reply = exactArray(await redisPipeline([["ZSCORE", INDEX, ref]]));
  if (!reply || reply.length !== 1) throw new Error("held store observation is unknown");
  const score = reply[0];
  if (score === null) return false;
  if (number(score) === null) throw new Error("held store observation is unknown");
  return true;
}
export async function heldStoresDue(now: number): Promise<string[]> {
  if (dayOf(now) === null) return [];
  const reply = exactArray(await redisPipeline([["ZRANGEBYSCORE", INDEX, "-inf", now, "LIMIT", 0, HELD_RECHECKS_PER_DAY]]));
  const rows = reply?.length === 1 ? exactArray(reply[0]) : null;
  if (!rows || rows.some(ref => typeof ref !== "string" || !refValid(ref))) throw new Error("held store candidates are unknown");
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
/**
 * DONO-3: a closed store closed without Stripe at its deadline (lib/plan-closing.ts, STRIPE_SILENT_DAYS) is counted
 * in its month, in the same monthly hash as the held count (field `lapsed`), so the owner's report says why held
 * stores left the line. A count that is not confirmed throws: the closing day is then tried again with it.
 */
export async function recordLapsed(now: number): Promise<void> {
  const day = dayOf(now);
  if (day === null) throw new Error("lapsed closing clock is unknown");
  const key = "nl:held:month:" + day.slice(0, 7);
  const values = exactArray(await redisPipeline([["HINCRBY", key, "lapsed", 1], ["EXPIRE", key, HELD_MONTH_COUNT_SECONDS]]));
  if (!values || values.length !== 2 || number(values[0]) === null || (values[0] as number | string) === 0 || values[1] !== 1) throw new Error("lapsed closing count is unknown");
}
/** The month's lapses, known only once its last day was observed (as readHeldMonth): none recorded then is zero; otherwise unknown, never zero. */
export async function readLapsedMonth(month: string): Promise<number | null> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  try {
    const reply = exactArray(await redisPipeline([["HMGET", "nl:held:month:" + month, "day", "lapsed"]]));
    const values = reply?.length === 1 ? exactArray(reply[0]) : null;
    if (!values || values.length !== 2) return null;
    const [year, m] = month.split("-").map(Number);
    const last = new Date(0);
    last.setUTCFullYear(year, m, 0);
    if (values[0] !== last.toISOString().slice(0, 10)) return null;
    if (values[1] === null) return 0;
    return number(values[1]);
  } catch { return null; }
}
export type HeldMonthCount = { month: string; count: number; peak: number };
export async function readHeldMonth(month: string): Promise<HeldMonthCount | null> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  try {
    const reply = exactArray(await redisPipeline([["HMGET", "nl:held:month:" + month, "count", "peak", "day", "complete"]]));
    const values = reply?.length === 1 ? exactArray(reply[0]) : null;
    if (!values || values.length !== 4) return null;
    const count = number(values[0]), peak = number(values[1]);
    const [year, m] = month.split("-").map(Number);
    const last = new Date(0);
    last.setUTCFullYear(year, m, 0);
    const end = last.toISOString().slice(0, 10);
    if (count === null || peak === null || peak < count || values[2] !== end || values[3] !== "1" && values[3] !== 1) return null;
    return { month, count, peak };
  } catch { return null; }
}
