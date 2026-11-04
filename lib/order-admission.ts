/**
 * Where a paid store's new orders stop: at its plan's figure for the month
 * (lib/order-rules.ts, paidOrdersLimitFor). Added 17 October 2026, when
 * orders past a plan stopped being sold at a price that did not keep the
 * owner's 60% after tax.
 *
 * An order is counted once its confirmation goes out (lib/orders.ts), which
 * is after the buyer has paid on Stripe's page: up to a day after the
 * checkout was opened. A check of the count alone at the door would let
 * every checkout still open become an order past the figure. So each
 * checkout that may become an order is admitted here first, atomically, and
 * held for the day it may still be paid in:
 *
 *   nl:orders:n:<folder>:<month>   orders counted this month (lib/orders.ts)
 *   nl:orders:open:<folder>        hour -> checkouts admitted in that hour, the last 25 hours
 *
 * A checkout is admitted only while the month's orders and the checkouts
 * held from the last day, with this one, stay within the figure, and (since
 * 18 October 2026) while the store's data room has space for the records
 * every one of those open checkouts would leave (lib/store-data-rules.ts,
 * orderDataBytes, the most each of them can take): an order's records are written whatever happens once it
 * is paid, so their room is held here, before anybody pays. When its
 * order is counted, its hour gives it back (settleAdmitted), so a busy day
 * is not counted twice. A checkout nobody pays falls out of the window by
 * itself after a day. What a month counts can therefore never pass the
 * figure through a checkout opened here; a buyer who is already paying is
 * never refused, because the refusal happens before Stripe's page opens.
 *
 * Unknown is not zero: when the counts cannot be read, nothing is admitted,
 * and the buyer is told the payment page could not be opened, with nothing
 * charged. A store in its free trial or with no plan is not counted here;
 * its paid orders stay what they were (docs/funded-exposure-review.md).
 *
 * scripts/test_order_admission_redis.py runs both scripts on a real Redis.
 */
import { allowanceWindow } from "@/lib/allowance-window";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { admitNonPaying } from "@/lib/free-pool";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Store, storeFolder, storeRef } from "@/lib/store";
import { paidOrdersLimitFor } from "@/lib/order-rules";
import { dataKey } from "@/lib/store-data";
import { dataRoomFor, orderDataBytes, MAX_ORDER_ITEMS } from "@/lib/store-data-rules";
import { shareBps } from "@/lib/platform-share";

/** Hours a checkout is held for: Stripe keeps a checkout open for a day at most, and one more for the hour it was opened in. */
export const OPEN_HOURS = 25;

/**
 * KEYS[1] the month's count, KEYS[2] the store's open hours, KEYS[3] the
 * store's data room (lib/store-data.ts), KEYS[4] the bytes the open hours
 * hold for it.
 * ARGV: limit, n, this hour, the oldest hour kept, seconds to keep the hours,
 * the data room in bytes, the most this checkout's orders can leave.
 * Answers 1 when admitted (and held), 0 when the figure would be passed, 2
 * when the data room would be.
 */
export const ADMIT_ORDERS = `-- marktmorgen:order-admission:v3
local limit = tonumber(ARGV[1])
local n = tonumber(ARGV[2])
local hour = tonumber(ARGV[3])
local oldest = tonumber(ARGV[4])
local room = tonumber(ARGV[6])
local bytes = tonumber(ARGV[7])
if not limit or not n or not hour or not oldest or not room or not bytes or n < 1 or bytes < 0 then return -1 end
local used = tonumber(redis.call('HGET', KEYS[3], '#') or '0')
if not used then return -1 end
local raw = redis.call('GET', KEYS[1])
local counted = 0
if raw then
  counted = tonumber(raw)
  if not counted then return -1 end
end
local function held(key)
  local fields = redis.call('HGETALL', key)
  local sum = 0
  for i = 1, #fields, 2 do
    local at = tonumber(fields[i])
    local v = tonumber(fields[i + 1]) or 0
    if not at or at < oldest or v <= 0 then
      redis.call('HDEL', key, fields[i])
    else
      sum = sum + v
    end
  end
  return sum
end
local open = held(KEYS[2])
local holding = held(KEYS[4])
if counted + open + n > limit then return 0 end
if used + holding + bytes > room then return 2 end
redis.call('HINCRBY', KEYS[2], tostring(hour), n)
redis.call('HINCRBY', KEYS[4], tostring(hour), bytes)
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[5]))
redis.call('EXPIRE', KEYS[4], tonumber(ARGV[5]))
return 1`;

/**
 * KEYS[1] the store's open hours, KEYS[2] the bytes they hold; ARGV: the
 * hour a checkout was admitted in, how many orders and how many bytes it
 * gives back. Gives them back, never below nothing.
 */
export const SETTLE_ADMITTED = `-- marktmorgen:order-admission-settle:v2
local field = tostring(ARGV[1])
local n = tonumber(ARGV[2])
local bytes = tonumber(ARGV[3])
if not n or n < 1 or not bytes or bytes < 0 then return 0 end
local held = tonumber(redis.call('HGET', KEYS[1], field) or '0') or 0
if held <= 0 then return 0 end
if held <= n then
  redis.call('HDEL', KEYS[1], field)
else
  redis.call('HINCRBY', KEYS[1], field, -n)
end
local kept = tonumber(redis.call('HGET', KEYS[2], field) or '0') or 0
if kept <= bytes then
  redis.call('HDEL', KEYS[2], field)
else
  redis.call('HINCRBY', KEYS[2], field, -bytes)
end
return 1`;

const countKey = (folder: string, month: string) => `nl:orders:n:${folder}:${month}`;
const openKey = (folder: string) => `nl:orders:open:${folder}`;
const heldKey = (folder: string) => `nl:orders:open:${folder}:b`;
const hourOf = (now: number) => Math.floor(now / 3_600_000);

/** What a checkout carries so its order can give its hour back: the hour, as metadata. */
export const ADMITTED_FIELD = "mm_admit";

export type Admission = { ok: true; hour: number | null } | { ok: false; reason: "paused" | "unavailable" };

type ConfirmationAdmission = { hour: number | null; bytes: number; window: string; windowEnd: number; captured: number; share: number; owner: string; folder: string | null; accountId: string | null; reference?: string };
const confirmationAdmissions = new WeakMap<object, ConfirmationAdmission>();

function confirmationEvidence(store: Store, window: { id: string; start: number; end: number } | null, hour: number | null, folder: string | null, n: number, items: number, now: number): ConfirmationAdmission | null {
  try {
    if (n !== 1 || !window || !Number.isSafeInteger(now) || now<=0 || now<window.start || now>=window.end || !Number.isSafeInteger(items) || items<1 || items>MAX_ORDER_ITEMS) return null;
    const source: Record<string,unknown> = Object.create(null);
    for (const key of ["shared","subscriptionActive","trialEnds","tier"]) {
      const d=Object.getOwnPropertyDescriptor(store,key);
      if (!d || !("value" in d)) return null;
      source[key]=d.value;
    }
    if (typeof source.shared!=="boolean" || typeof source.subscriptionActive!=="boolean" || !Number.isSafeInteger(source.trialEnds) ||
        Number(source.trialEnds)<0 || typeof source.tier!=="string" || !["creator","pro","scale"].includes(source.tier)) return null;
    const share=shareBps(source as unknown as Store,now/1000),owner=storeRef(store).toLowerCase();
    if (!owner || owner.length>320 || !Number.isSafeInteger(share) || share<0 || share>10_000) return null;
    const account=Object.getOwnPropertyDescriptor(store,"stripeAccountId");
    if(account && (!("value" in account) || (account.value!==null && (typeof account.value!=="string" || !/^acct_[A-Za-z0-9]{6,128}$/.test(account.value))))) return null;
    return {hour,bytes:orderDataBytes(items),window:window.id,windowEnd:window.end,captured:now,share,owner,folder,accountId:account?.value??null};
  } catch { return null; }
}

/** Capture only from this checkout's acknowledged admission, before exposing
 * its payment page. This must be the actual returned object in this process:
 * an old metadata hour or reconstructed success cannot establish evidence.
 * One admission can bind only one checkout. Group-place admissions need their
 * own per-place protocol and are intentionally not admitted by this hook.
 */
export function orderConfirmationAdmission(store: Store, admission: Admission, reference: string, accountId?: string): ConfirmationAdmission | null {
  try {
    const evidence=confirmationAdmissions.get(admission);
    if (!evidence || evidence.owner!==storeRef(store).toLowerCase() || (accountId!==undefined && evidence.accountId!==accountId) ||
      (evidence.reference!==undefined && evidence.reference!==reference)) return null;
    evidence.reference=reference;
    return {...evidence};
  } catch { return null; }
}

/** The original aggregate hour is never replaced with the worker's hour. */
export function orderConfirmationHoldKeys(folder: string): [string, string] {
  return [openKey(folder), heldKey(folder)];
}

/**
 * Admits `n` orders for a store before a checkout opens (one for a checkout,
 * one plus its places for a purchase made for several people), each handing
 * over at the most `items` products (a bundle's each: lib/store-data-rules.ts,
 * itemsHandedOver). `hour` is null where the store is not counted here;
 * otherwise it goes on the checkout, as ADMITTED_FIELD, and back to
 * settleAdmitted with its order.
 */
export async function admitOrders(store: Store, n = 1, now = Date.now(), items = 1): Promise<Admission> {
  const limit = paidOrdersLimitFor(store, now / 1000);
  if (limit === null) {
    const result: Admission={ok:true,hour:null};
    try {
      const evidence=confirmationEvidence(store,allowanceWindow(store,now),null,null,n,items,now);
      if(evidence) confirmationAdmissions.set(result,evidence);
    } catch { /* Capturing evidence must not change this legacy admission. */ }
    return result;
  }
  // A store in its free trial holds one of the month's places for stores that pay nothing (lib/free-pool-rules.ts).
  if (!(await admitNonPaying(store, now))) return { ok: false, reason: "paused" };
  if (!Number.isSafeInteger(n) || n < 1) return { ok: false, reason: "unavailable" };
  if (!isRedisConfigured()) return { ok: false, reason: "unavailable" };
  // Counted in the store's billing month (lib/allowance-window.ts); none known, none admitted.
  const window = allowanceWindow(store, now);
  if (!window) return { ok: false, reason: "unavailable" };
  // A paid contract must cover this resource month before capacity is held or a buyer can pay.
  // Settlement below remains available for checkouts already paid.
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return { ok: false, reason: "unavailable" };
  try {
    const folder = await storeFolder(storeRef(store));
    const room = dataKey(store);
    if (!room) return { ok: false, reason: "unavailable" };
    const hour = hourOf(now);
    const evidence=confirmationEvidence(store,window,hour,folder,n,items,now);
    const reply: unknown = await redisPipeline([
      ["EVAL", ADMIT_ORDERS, 4, countKey(folder, window.id), openKey(folder), room, heldKey(folder), limit, n, hour, hour - (OPEN_HOURS - 1), (OPEN_HOURS + 1) * 3_600, dataRoomFor(store, now / 1000), n * orderDataBytes(items)],
    ]);
    // SET-like effects may already have committed: inspect one own numeric
    // acknowledgement without coercion, iteration or releasing uncertain holds.
    if (!Array.isArray(reply)) return { ok: false, reason: "unavailable" };
    const length = Object.getOwnPropertyDescriptor(reply, "length");
    if (!length || !Object.hasOwn(length, "value") || length.value !== 1) return { ok: false, reason: "unavailable" };
    const answer = Object.getOwnPropertyDescriptor(reply, "0");
    if (!answer || !Object.hasOwn(answer, "value")) return { ok: false, reason: "unavailable" };
    if (answer.value === 1) {
      const result: Admission={ok:true,hour};
      if(evidence) confirmationAdmissions.set(result,evidence);
      return result;
    }
    // The figure is reached, or the data room has no space for this order's records: either way the store rests.
    if (answer.value === 0 || answer.value === 2) return { ok: false, reason: "paused" };
    return { ok: false, reason: "unavailable" };
  } catch (error) {
    console.error("could not admit an order", error);
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Gives back what a checkout held, once its order is counted (or covered by
 * its share): its place in the figure and what an order of `items` products
 * leaves, which its order has now taken from the room itself. Never throws.
 */
export async function settleAdmitted(store: Store, hour: unknown, n = 1, items = 1): Promise<void> {
  const at = typeof hour === "number" ? hour : typeof hour === "string" && /^\d{1,9}$/.test(hour) ? Number(hour) : NaN;
  if (!Number.isSafeInteger(at) || !isRedisConfigured()) return;
  try {
    const folder = await storeFolder(storeRef(store));
    await redisPipeline([["EVAL", SETTLE_ADMITTED, 2, openKey(folder), heldKey(folder), String(at), n, n * orderDataBytes(items)]]);
  } catch (error) {
    console.error("could not settle an admitted order", error);
  }
}

/** Whether a paid store's new orders are paused right now, for the studio: the month's orders at the figure. */
export async function ordersPaused(store: Store, counted: number, now = Date.now()): Promise<boolean> {
  const limit = paidOrdersLimitFor(store, now / 1000);
  return limit !== null && counted >= limit;
}

/** Thrown by a checkout that was not admitted; the route turns it into the buyer's notice. */
export class OrdersPausedError extends Error {
  constructor(readonly reason: "paused" | "unavailable") {
    super(reason === "paused" ? "This store is not taking new orders right now" : "Orders could not be counted");
    this.name = "OrdersPausedError";
  }
}
