/**
 * A break from the plan instead of leaving it (added 11 October 2026).
 *
 * Why. Stan, the store this one is first compared with, loses about 13% of
 * its creators a month (Contrary, August 2026). Some of them are not leaving
 * at all: a teacher whose term is over, a coach taking the summer off, a
 * course being rebuilt. Offered only "cancel", they cancel, and a creator who
 * has cancelled rarely comes back to start again. Offered a break, they take
 * the break, and the plan starts again by itself.
 *
 * What a break is, precisely, and why it is built out of parts that exist:
 *
 *   - The subscription is set to stop at the end of the period already paid
 *     for, exactly as cancelling does (lib/billing.ts, setCancelAtPeriodEnd).
 *     Until that day nothing changes; on it, the store stands as any store
 *     whose plan ended (lib/plan-standing.ts): the checkout stops, the page
 *     stays up, a buyer's download is never refused, lesson video plays for
 *     the hours a store with no plan has.
 *   - What the store keeps is kept, all of it, for the whole break. The
 *     closing that takes away what a store with no plan may not keep
 *     (lib/plan-closing.ts) waits while a break runs, and goes on as it would
 *     have after, if the plan does not start again.
 *   - On the day the break ends the plan is started again on the card it was
 *     last paid with, at the plan and price it had, monthly, charged at once
 *     or not at all (lib/billing.ts, restartPlan). The creator is told the
 *     date and the price RESTART_NOTICE_DAYS before, as before a trial ends,
 *     and told again whichever way it goes.
 *   - The creator can take the break back before it starts, in one click,
 *     and the plan goes on as if nothing happened; or once it has started,
 *     start the plan again from the studio's ordinary button, any day; or
 *     tell us not to start it at all.
 *
 * Why not Stripe's own "pause payment collection". It voids every invoice
 * made while it is set, which would also void a usage charge for the month
 * before the break, and it leaves the subscription "active", which every part
 * of this code reads as a store that may sell. Stopping and starting again
 * costs a new subscription id, and nothing else.
 *
 * Who may take one: a monthly plan, paid up and past its trial, with
 * PAID_MONTHS_BEFORE_PAUSE payments through, not set to stop, with no change
 * of plan waiting, once in PAUSE_EVERY_DAYS. What that costs us at the most is
 * added up in tests/plan-margin.test.ts.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import {
  BillingError,
  hasContractFunding,
  isBillingConfigured,
  periodEnd,
  planOf,
  restartPlan,
  setCancelAtPeriodEnd,
  stateOf,
  subscriptionRecord,
} from "@/lib/billing";
import { addPeriods } from "@/lib/plans";
import { NIMBUS_FROM, type SendOutcome, isSenderConfigured, sendEmailOutcome } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { PLAN_NAMES, PLAN_PRICES, type Tier, parseTier } from "@/lib/plan";
import { setSubscription, storeForEmail, storeForRestartSource, storeRef, type Store } from "@/lib/store";
import {
  PAID_MONTHS_BEFORE_PAUSE,
  PAUSE_EVERY_DAYS,
  RESTART_NOTICE_DAYS,
  type PauseMonths,
} from "@/lib/plan-pause-rules";

const DAY = 86_400;
/** Days a restart that failed for a reason other than the card is tried again. */
const RETRY_DAYS = 3;

/** Whether Stripe refused because of the card or the bank, which trying again will not change. */
function declined(error: unknown): boolean {
  if (!(error instanceof BillingError)) return false;
  return error.status === 402 || /card_declined|authentication_required|expired_card|insufficient_funds|payment_method|incorrect_cvc/.test(error.code);
}
const recordKey = (ref: string) => `nl:pause:${ref}`;
const lastKey = (ref: string) => `nl:pause:last:${ref}`;
const DUE = "nl:pause:due";
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{6,64}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]{6,64}$/;
const PAYMENT_METHOD_ID = /^(pm|card|src)_[A-Za-z0-9]{6,64}$/;

/** A break, as it is kept. Times in seconds. */
export type PauseRecord = {
  /** The subscription that stops for it. */
  subscription: string;
  customer: string;
  /** The card the plan was paid with, and is started again on. */
  paymentMethod: string;
  tier: Tier;
  /** When the paid period ends and the break begins. */
  from: number;
  /** When the plan starts again. */
  until: number;
  /** When the creator was told the plan is about to start again; 0 until then. */
  told: number;
  /** Durable marker before the inactive store loses its funded period. Null is unknown, never legacy. */
  funding?: { version: 1; grantId: string | null };
};

function parseRecord(raw: unknown): PauseRecord | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    // JSON parsing does not make inherited fields evidence. A polluted prototype
    // must not fill missing ownership, dates, or an optional funding marker.
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    for (const key of ["subscription", "customer", "paymentMethod", "tier", "from", "until"]) {
      if (!Object.hasOwn(value, key)) return null;
    }
    if ((!Object.hasOwn(value, "told") && "told" in value) ||
        (!Object.hasOwn(value, "funding") && "funding" in value)) return null;
    const tier = parseTier(value.tier);
    const told = value.told === undefined ? 0 : value.told;
    const funding = value.funding as { version?: unknown; grantId?: unknown } | null | undefined;
    if (value.funding !== undefined && (!funding || typeof funding !== 'object' || Array.isArray(funding) || !Object.hasOwn(funding, 'version') || !Object.hasOwn(funding, 'grantId') || funding.version !== 1 || (funding.grantId !== null && (typeof funding.grantId !== 'string' || !/^ctr_[A-Za-z0-9_-]{1,80}$/.test(funding.grantId))))) return null;
    if (
      typeof value.subscription !== "string" || !SUBSCRIPTION_ID.test(value.subscription) ||
      typeof value.customer !== "string" || !CUSTOMER_ID.test(value.customer) ||
      typeof value.paymentMethod !== "string" || !PAYMENT_METHOD_ID.test(value.paymentMethod) || !tier ||
      typeof value.from !== "number" || !Number.isSafeInteger(value.from) || value.from <= 0 ||
      typeof value.until !== "number" || !Number.isSafeInteger(value.until) || value.until <= value.from ||
      typeof told !== "number" || !Number.isSafeInteger(told) || told < 0
    ) {
      return null;
    }
    return {
      subscription: value.subscription,
      customer: value.customer,
      paymentMethod: value.paymentMethod,
      tier,
      from: value.from,
      until: value.until,
      told,
      ...(funding ? { funding: { version: 1 as const, grantId: funding.grantId as string | null } } : {}),
    };
  } catch {
    return null;
  }
}

/** The break a store has set, whether it has begun or not, or null. */
export async function pauseOf(store: Pick<Store, "email" | "sid" | "extra">): Promise<PauseRecord | null> {
  return pauseAt(storeRef(store));
}

/** A UI observation preserves unknown evidence without another Redis read. */
export async function pauseView(store: Pick<Store, "email" | "sid" | "extra">): Promise<
  { kind: "known"; record: PauseRecord } | { kind: "missing" } | { kind: "unknown" }
> {
  if (!isRedisConfigured()) return { kind: "unknown" };
  try {
    const observed = await storedPauseAt(storeRef(store));
    if (observed.missing) return { kind: "missing" };
    return observed.record ? { kind: "known", record: observed.record } : { kind: "unknown" };
  } catch { return { kind: "unknown" }; }
}

/** Read at most4097 raw bytes; missing and unreadable evidence stay distinct. */
/** Bound due-member response bytes before Redis returns them; never erase malformed evidence. */
export const PAUSE_DUE_OBSERVATION = `-- marktmorgen:pause-due-observation:v1
if #KEYS~=1 or #ARGV~=1 or not string.match(ARGV[1],'^%d+$') then return {-1} end
local deadline=tonumber(ARGV[1])
if not deadline or deadline>1000000000000 or (#ARGV[1]>1 and string.sub(ARGV[1],1,1)=='0') then return {-1} end
local kind=redis.call('TYPE',KEYS[1]).ok
if kind=='none' then return {} end
if kind~='zset' then return {-1} end
local refs=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',ARGV[1],'LIMIT',0,200)
for _,ref in ipairs(refs) do
 if #ref==0 or #ref>1280 then return {-1} end
end
return refs`;

export const PAUSE_OBSERVATION = `-- marktmorgen:pause-observation:v1
if #KEYS~=1 or #ARGV~=0 then return {-1} end
local kind=redis.call('TYPE',KEYS[1]).ok
if kind=='none' then return {0} end
if kind~='string' then return {-1} end
local raw=redis.call('GETRANGE',KEYS[1],0,4096)
if #raw==0 or #raw>4096 then return {-1} end
return {1,raw}`;

/** Decode only the two finite own-data shapes emitted by PAUSE_OBSERVATION. */
function boundedPauseObservation(reply: unknown): { missing: true; raw: null } | { missing: false; raw: string } | null {
  try {
    if (!Array.isArray(reply) || Object.getOwnPropertySymbols(reply).length) return null;
    const outerLength = Object.getOwnPropertyDescriptor(reply, "length");
    if (!outerLength || !Object.hasOwn(outerLength, "value") || outerLength.value !== 1) return null;
    const entry = Object.getOwnPropertyDescriptor(reply, "0");
    if (!entry || !Object.hasOwn(entry, "value") || !Array.isArray(entry.value)) return null;
    const ack: unknown[] = entry.value;
    if (Object.getOwnPropertySymbols(ack).length) return null;
    const length = Object.getOwnPropertyDescriptor(ack, "length");
    if (!length || !Object.hasOwn(length, "value") || (length.value !== 1 && length.value !== 2)) return null;
    const flag = Object.getOwnPropertyDescriptor(ack, "0");
    if (!flag || !Object.hasOwn(flag, "value")) return null;
    if (length.value === 1) return flag.value === 0 ? { missing: true, raw: null } : null;
    if (flag.value !== 1) return null;
    const field = Object.getOwnPropertyDescriptor(ack, "1");
    if (!field || !Object.hasOwn(field, "value") || typeof field.value !== "string") return null;
    const raw = field.value;
    if (raw.length === 0 || raw.length > 4096 || Buffer.byteLength(raw, "utf8") > 4096) return null;
    return { missing: false, raw };
  } catch { return null; }
}

async function storedPauseAt(ref: string): Promise<{ record: PauseRecord | null; missing: boolean; raw: string | null }> {
  if (!isRedisConfigured()) return { record: null, missing: true, raw: null };
  const reply = await redisPipeline([["EVAL", PAUSE_OBSERVATION, 1, recordKey(ref)]]);
  // Bound the acknowledgement shape before touching members or encoding raw
  // bytes. A generic snapshot would first traverse an oversized response.
  const observation = boundedPauseObservation(reply);
  if (!observation) return { record: null, missing: false, raw: null };
  if (observation.missing) return { record: null, missing: true, raw: null };
  const raw = observation.raw;
  return { record: parseRecord(raw), missing: false, raw };
}

async function pauseAt(ref: string): Promise<PauseRecord | null> {
  return (await storedPauseAt(ref)).record;
}

/** Whether a break has not run out yet. */
export function breakRunning(record: Pick<PauseRecord, "until">, nowSeconds = Date.now() / 1000): boolean {
  return record.until > nowSeconds;
}

/** Whether a store's closing must wait: a break that has not run out. Read by lib/plan-closing.ts. */
export async function onBreak(ref: string, nowSeconds = Date.now() / 1000): Promise<boolean> {
  try {
    const stored = await storedPauseAt(ref);
    // Unknown pause evidence is not permission to remove a creator's content.
    if (!stored.record) return !stored.missing;
    return Boolean(stored.record.funding) || stored.record.until > nowSeconds;
  } catch {
    return true;
  }
}

export type PauseRefusal = "standing" | "trial" | "yearly" | "canceling" | "pending" | "early" | "recent";

/**
 * Whether this subscription may take a break, and if not, why. Pure, so the
 * studio can say the reason and a test can hold every case.
 */
export function pauseRefusal(
  subscription: Record<string, unknown>,
  nowSeconds: number,
  pausedBefore: boolean,
): PauseRefusal | null {
  const state = stateOf(subscription);
  if (state.state !== "active" || subscription.status !== "active") {
    return state.state === "active" && state.trialing ? "trial" : "standing";
  }
  if (state.cycle !== "month") return "yearly";
  if (state.cancelsAtEnd) return "canceling";
  if (state.changePending) return "pending";
  // Paid for PAID_MONTHS_BEFORE_PAUSE months: the first charge is at the
  // trial's end, or at the start when there was none, and the n-th a month
  // after the one before. "active" rather than "past_due" means the latest
  // went through.
  const trialEnd = typeof subscription.trial_end === "number" ? subscription.trial_end : 0;
  const started = typeof subscription.start_date === "number" ? subscription.start_date : 0;
  const first = Math.max(trialEnd, started);
  if (!first || addPeriods(first, "month", PAID_MONTHS_BEFORE_PAUSE - 1) > nowSeconds) return "early";
  if (pausedBefore) return "recent";
  return null;
}

/** The card a subscription is charged on: its own, or its customer's default. */
function cardOf(subscription: Record<string, unknown>): string {
  const own = subscription.default_payment_method;
  if (typeof own === "string") return own;
  if (own && typeof own === "object" && typeof (own as { id?: unknown }).id === "string") return (own as { id: string }).id;
  const source = subscription.default_source;
  return typeof source === "string" ? source : "";
}

/** Copy only a small own-data ACK before interpreting eligibility or writes. */
function ownPauseAcknowledgement(reply: unknown, expected: 1 | 3): unknown[] | null {
  try {
    if (!Array.isArray(reply)) return null;
    const length = Object.getOwnPropertyDescriptor(reply, "length");
    if (!length || !Object.hasOwn(length, "value") || length.value !== expected) return null;
    const values: unknown[] = [];
    for (let index = 0; index < expected; index++) {
      const field = Object.getOwnPropertyDescriptor(reply, String(index));
      if (!field || !Object.hasOwn(field, "value")) return null;
      values.push(field.value);
    }
    return values;
  } catch { return null; }
}

export type PauseResult = { kind: "paused"; record: PauseRecord } | { kind: "refused"; reason: PauseRefusal | "card" };

/** Sets a break of `months`, starting when the period already paid for ends. */
export async function pausePlan(store: Store, months: PauseMonths, nowSeconds = Math.floor(Date.now() / 1000)): Promise<PauseResult> {
  const id = store.subscriptionId;
  if (!id || !isBillingConfigured() || !isRedisConfigured()) return { kind: "refused", reason: "standing" };
  const subscription = await subscriptionRecord(id);
  if (!subscription || subscription.id !== id) return { kind: "refused", reason: "standing" };
  const observedCustomer = subscription.customer;
  const customer = typeof observedCustomer === "string" ? observedCustomer :
    observedCustomer && typeof observedCustomer === "object" && typeof (observedCustomer as { id?: unknown }).id === "string" ? (observedCustomer as { id: string }).id : "";
  // Never replace missing provider ownership with the store's cached customer.
  if (!CUSTOMER_ID.test(customer) || (store.stripeCustomerId !== null && customer !== store.stripeCustomerId)) {
    return { kind: "refused", reason: "standing" };
  }
  const ref = storeRef(store);
  const lastReply = await redisPipeline([["EXISTS", lastKey(ref)]]);
  // Unknown annual eligibility must fail before a due record or provider stop
  // is created. Only the single numeric EXISTS result proves this state.
  const eligibility = ownPauseAcknowledgement(lastReply, 1);
  if (!eligibility || (eligibility[0] !== 0 && eligibility[0] !== 1)) {
    return { kind: "refused", reason: "standing" };
  }
  const refusal = pauseRefusal(subscription, nowSeconds, eligibility[0] === 1);
  if (refusal) return { kind: "refused", reason: refusal };
  const paymentMethod = cardOf(subscription);
  // Without a card on the subscription there is nothing to start it again on,
  // and a break that cannot end by itself is a cancellation with a nicer name.
  if (!PAYMENT_METHOD_ID.test(paymentMethod)) return { kind: "refused", reason: "card" };

  const from = periodEnd(subscription, false);
  if (!from || from <= nowSeconds) return { kind: "refused", reason: "standing" };
  const record: PauseRecord = {
    subscription: id,
    customer,
    paymentMethod,
    tier: planOf(subscription).tier,
    from,
    until: addPeriods(from, "month", months),
    told: 0,
    ...((store.period?.funded === true || hasContractFunding(subscription)) ? { funding: { version: 1 as const, grantId: (() => { const metadata = subscription.metadata as Record<string, unknown> | null | undefined; const pending = metadata?.funding_pending_grant !== undefined || metadata?.funding_pending_review !== undefined; const grant = pending ? metadata?.funding_pending_grant : metadata?.funding_grant; return typeof grant === "string" && /^ctr_[A-Za-z0-9_-]{1,80}$/.test(grant) ? grant : null; })() } } : {}),
  };
  // All three durable scheduling writes must be acknowledged before any
  // provider mutation. A missing/partial reply may hide committed writes:
  // retain them and refuse rather than assuming an unused year or no pause.
  const written = await redisPipeline([
    ["SET", recordKey(ref), JSON.stringify(record)],
    ["ZADD", DUE, record.until, ref],
    ["SET", lastKey(ref), String(nowSeconds), "EX", PAUSE_EVERY_DAYS * DAY],
  ]);
  const persisted = ownPauseAcknowledgement(written, 3);
  if (!persisted || persisted[0] !== "OK"
    || (persisted[1] !== 0 && persisted[1] !== 1) || persisted[2] !== "OK") {
    return { kind: "refused", reason: "standing" };
  }
  // A provider error or lost acknowledgement cannot prove that its scheduled
  // stop was not applied. Keep the exact pause, due member and annual evidence
  // until an explicit undo/reconciliation; never roll unknown evidence back.
  const state = await setCancelAtPeriodEnd(id, true);
  if (state.state !== "active") throw new Error(`the subscription is ${state.state}`);
  if (!state.cancelsAtEnd) throw new Error("the subscription did not acknowledge its scheduled stop");
  return { kind: "paused", record };
}

/** Drops a store's break. `andTheYear` gives the once-a-year break back too: for one that never began. */

/** Worker cleanup may only remove the generation it actually observed.
 * An ambiguous reply keeps the evidence and never falls back to DEL/ZREM.
 * Creator-initiated undo/drop keep their existing separate semantics. */
export const PAUSE_WORKER_FORGET = `-- marktmorgen:pause-worker-forget:v1
if #KEYS~=2 or #ARGV~=3 or KEYS[1]==KEYS[2] then return 0 end
local current
if ARGV[2]=='known' then
 current=redis.call('GETRANGE',KEYS[1],0,4096)
 if #current==0 or #current>4096 then return 0 end
else
 current=redis.call('GET',KEYS[1])
end
if ARGV[2]=='missing' then
 if current then return 0 end
 redis.call('ZREM',KEYS[2],ARGV[1])
 return 1
end
if ARGV[2]~='known' or current~=ARGV[3] then return 0 end
local ok,p=pcall(cjson.decode,current)
if not ok or type(p)~='table' or p.funding~=nil or type(p['until'])~='number' then return 0 end
if redis.call('ZSCORE',KEYS[2],ARGV[1])~=tostring(p['until']) then return 0 end
redis.call('DEL',KEYS[1])
redis.call('ZREM',KEYS[2],ARGV[1])
return 1
`;
async function forgetObserved(ref: string, raw: string | null): Promise<boolean> {
  try {
    const reply = await redisPipeline([["EVAL", PAUSE_WORKER_FORGET, 2, recordKey(ref), DUE, ref, raw === null ? "missing" : "known", raw ?? ""]]);
    if (!Array.isArray(reply) || reply.length !== 1) return false;
    const ack = Object.getOwnPropertyDescriptor(reply, "0");
    return Boolean(ack && Object.hasOwn(ack, "value") && ack.value === 1);
  } catch { return false; }
}


/** A sent legacy notice cannot overwrite a pause replaced while email waited.
 * This is only an exact-generation marker ACK, not exactly-once email delivery. */
export const PAUSE_WORKER_NOTICE = `-- marktmorgen:pause-worker-notice:v1
if #KEYS~=2 or #ARGV~=4 or KEYS[1]==KEYS[2] then return 0 end
local now=tonumber(ARGV[4])
if not now or now<=0 or now~=math.floor(now) then return 0 end
local current=redis.call('GET',KEYS[1])
if current~=ARGV[2] then return 0 end
local ok,p=pcall(cjson.decode,current)
local nextOK,q=pcall(cjson.decode,ARGV[3])
if not ok or not nextOK or type(p)~='table' or type(q)~='table' or p.funding~=nil or q.funding~=nil then return 0 end
local fields={subscription=true,customer=true,paymentMethod=true,tier=true,from=true,['until']=true,told=true}
for k,_ in pairs(p) do if not fields[k] then return 0 end end
local count=0
for k,_ in pairs(q) do if not fields[k] then return 0 end count=count+1 end
if count~=7 or (p.told~=nil and p.told~=0) or q.told~=now or type(p['until'])~='number' or p['until']<=now then return 0 end
for k,_ in pairs(fields) do if k~='told' and p[k]~=q[k] then return 0 end end
if redis.call('ZSCORE',KEYS[2],ARGV[1])~=tostring(p['until']) then return 0 end
redis.call('SET',KEYS[1],ARGV[3],'KEEPTTL')
return 1
`;

function knownNoticeSource(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const fields = ["subscription", "customer", "paymentMethod", "tier", "from", "until", "told"];
    return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).every(key => fields.includes(key)));
  } catch { return false; }
}

async function markObservedNotice(ref: string, raw: string | null, record: PauseRecord, nowSeconds: number): Promise<boolean> {
  if (raw === null || !Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) return false;
  try {
    const next = JSON.stringify({ ...record, told: nowSeconds });
    const reply = await redisPipeline([["EVAL", PAUSE_WORKER_NOTICE, 2, recordKey(ref), DUE, ref, raw, next, nowSeconds]]);
    if (!Array.isArray(reply) || reply.length !== 1) return false;
    const ack = Object.getOwnPropertyDescriptor(reply, "0");
    return Boolean(ack && Object.hasOwn(ack, "value") && ack.value === 1);
  } catch { return false; }
}

async function forget(ref: string, andTheYear: boolean): Promise<void> {
  await redisPipeline([
    ["DEL", recordKey(ref)],
    ["ZREM", DUE, ref],
    ...(andTheYear ? [["DEL", lastKey(ref)]] : []),
  ]);
}

/**
 * Takes a break back. Before it begins the plan simply goes on, and the
 * break is not counted. Once it has begun the plan has already stopped, and
 * this only means it will not start again by itself.
 */
export async function undoPause(store: Store, nowSeconds = Math.floor(Date.now() / 1000)): Promise<"kept" | "stopped" | "none"> {
  const ref = storeRef(store);
  // Unknown evidence cannot mean that the break was removed. Preserve the
  // existing bounded observation and refuse before provider or cleanup writes.
  if (!isRedisConfigured()) throw new Error("the break could not be confirmed");
  const observed = await storedPauseAt(ref);
  if (observed.missing) return "none";
  const record = observed.record;
  if (!record) throw new Error("the break could not be confirmed");
  if (nowSeconds < record.from && record.subscription === store.subscriptionId) {
    const state = await setCancelAtPeriodEnd(record.subscription, false);
    // Being active is not acknowledgement that the scheduled stop was removed.
    // Keep the pause and its annual eligibility until that change is observed.
    if (state.state === "active" && state.cancelsAtEnd) {
      throw new Error("the subscription is still set to stop at the end of its paid period");
    }
    await forget(ref, true);
    return state.state === "active" ? "kept" : "stopped";
  }
  // A stopped break may have been replaced since the bounded observation.
  // Reuse the worker\'s exact-raw/due CAS: unknown ACKs and funded evidence
  // never authorize blind cleanup, and annual eligibility is not returned.
  if (!await forgetObserved(ref, observed.raw)) {
    throw new Error("the break removal could not be confirmed");
  }
  return "stopped";
}

/** Called when the creator cancels outright, or starts a plan again by hand: there is no break left to run. */
export async function dropPause(store: Pick<Store, "email" | "sid" | "extra">): Promise<void> {
  if (!isRedisConfigured()) return;
  await forget(storeRef(store), false);
}

function day(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** What the creator is told, plain text. */
export function pauseEmail(kind: "set" | "soon" | "restarted" | "failed" | "unconfirmed", record: PauseRecord): { subject: string; text: string } {
  const name = PLAN_NAMES[record.tier];
  const price = dollars(PLAN_PRICES[record.tier].month);
  const studio = `${SITE_URL}/studio#billing`;
  const close = ["", `Questions: reply to this email, or write to ${SUPPORT_EMAIL}.`, "", "Marktmorgen"];
  if (kind === "set") {
    return {
      subject: `Your break from ${name}: ${day(record.from)} to ${day(record.until)}`,
      text: [
        "Hello,",
        "",
        `Your store keeps taking payments until ${day(record.from)}. From then until ${day(record.until)} nothing is charged, your checkout is closed, and everything you put up stays exactly where it is.`,
        "",
        `On ${day(record.until)} your plan starts again by itself, at ${price} a month on the card you pay with now. We will write a week before.`,
        "",
        `To take the break back, or to start selling again sooner, open your studio: ${studio}`,
        ...close,
      ].join("\n"),
    };
  }
  if (kind === "soon") {
    return {
      subject: `Your ${name} plan starts again on ${day(record.until)}`,
      text: [
        "Hello,",
        "",
        `Your break ends on ${day(record.until)}. On that day your plan starts again and your card is charged ${price}, and then ${price} every month, until you cancel.`,
        "",
        `If you would rather not start again, say so in your studio before then. It takes one click, with no email to us: ${studio}`,
        ...close,
      ].join("\n"),
    };
  }
  if (kind === "restarted") {
    return {
      subject: `Your ${name} plan has started again`,
      text: [
        "Hello,",
        "",
        `Your break is over. Your plan has started again at ${price} a month, and your checkout is taking payments.`,
        "",
        `Every charge is covered by our 30-day refund. Your plan is in your studio: ${studio}`,
        ...close,
      ].join("\n"),
    };
  }
  if (kind === "unconfirmed") {
    return {
      subject: `Your ${name} plan restart needs a check`,
      text: [
        "Hello,",
        "",
        "We could not confirm the outcome of your plan restart. This does not tell us whether a charge went through.",
        "",
        `Check your billing in the studio: ${studio}`,
        "",
        "Before starting the plan again, contact us so we can check the subscription and any charge. If you see a charge, include its date and amount, but do not send card details.",
        ...close,
      ].join("\n"),
    };
  }
  return {
    subject: `Your ${name} plan could not start again`,
    text: [
      "Hello,",
      "",
      `Your break ended on ${day(record.until)}, and we could not start your plan again: the latest attempt was refused by the card or bank, or needs a confirmation we cannot give for you. This does not confirm the outcome of any earlier attempt.`,
      "",
      `Check your billing in the studio before starting the plan again: ${studio}`,
      "",
      "If you see a charge or are unsure about an earlier attempt, contact us before trying again. Include the date and amount of any charge, but do not send card details.",
      "",
      "Your store and your products stay up. If your store keeps more than a store with no plan may, we will write with the figures and the date before anything is removed.",
      ...close,
    ].join("\n"),
  };
}

/** Funded account notices need their own reviewed reservation and durable generation.
 * The company meter alone is not proof of this liability. Keep them held until
 * that path is built; a missing inactive period cannot erase the pause marker. */
function legacyNoticeAdmitted(store: Store, record: PauseRecord): boolean {
  try {
    if (!record || typeof record !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(record))) return false;
    if (Object.getOwnPropertyDescriptor(record, "funding")) return false;
    if (!store || typeof store !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(store))) return false;
    const period = Object.getOwnPropertyDescriptor(store, "period");
    if (period && !Object.hasOwn(period, "value")) return false;
    if (period?.value !== null && period?.value !== undefined) {
      if (typeof period.value !== "object" ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(period.value))) return false;
      const funded = Object.getOwnPropertyDescriptor(period.value, "funded");
      if (funded && (!Object.hasOwn(funded, "value") || funded.value !== false)) return false;
    }
    return true;
  } catch { return false; }
}

/**
 * Sends one notice, telling a certain refusal from an answer that is not
 * known (SendOutcome): a notice that may have gone is never sent again by a
 * job that writes once (rule 30, as 283 [HG2]). Nothing asked of the sender
 * (not admitted, no sender, no address) is a refusal; a throw from the send
 * may follow the request, so it is uncertain.
 */
async function tell(store: Store, kind: "set" | "soon" | "restarted" | "failed" | "unconfirmed", record: PauseRecord): Promise<SendOutcome> {
  if (!legacyNoticeAdmitted(store, record)) return "refused";
  if (!isSenderConfigured() || !store.email) return "refused";
  const { subject, text } = pauseEmail(kind, record);
  return sendEmailOutcome({ meter: { by: "company" }, from: NIMBUS_FROM, to: store.email, subject, text, replyTo: SUPPORT_EMAIL }).catch((error) => {
    console.error("a break notice may have gone; it is not sent again", kind, error);
    return "uncertain" as const;
  });
}

/** Tells the creator what they just set. Never fails the request that set it. */
export async function confirmPause(store: Store, record: PauseRecord): Promise<void> {
  await tell(store, "set", record).catch((error) => console.error("confirming a break failed", error));
}

/** Read only the bounded own-data response from PAUSE_DUE_OBSERVATION. */
function boundedPauseDueRefs(reply: unknown): string[] | null {
  try {
    if (!Array.isArray(reply) || Object.getOwnPropertySymbols(reply).length) return null;
    const outerLength = Object.getOwnPropertyDescriptor(reply, "length");
    if (!outerLength || !Object.hasOwn(outerLength, "value") || outerLength.value !== 1) return null;
    const entry = Object.getOwnPropertyDescriptor(reply, "0");
    if (!entry || !Object.hasOwn(entry, "value") || !Array.isArray(entry.value)) return null;
    const batch: unknown[] = entry.value;
    if (Object.getOwnPropertySymbols(batch).length) return null;
    const length = Object.getOwnPropertyDescriptor(batch, "length");
    if (!length || !Object.hasOwn(length, "value") ||
        !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 200) return null;
    const refs: string[] = [], seen = new Set<string>();
    for (let i = 0; i < length.value; i++) {
      const field = Object.getOwnPropertyDescriptor(batch, String(i));
      if (!field || !Object.hasOwn(field, "value") || typeof field.value !== "string") return null;
      const ref = field.value;
      if (ref.length === 0 || ref.length > 1280 ||
          new TextEncoder().encode(ref).length > 1280 || seen.has(ref)) return null;
      seen.add(ref);
      refs.push(ref);
    }
    return refs;
  } catch { return null; }
}

/**
 * The daily pass: tells every creator whose break ends within the notice, and
 * starts again every plan whose break has ended. Safe to run as often as it is
 * called: each notice goes once, and a plan is started under a key Stripe will
 * not carry out twice.
 */
export async function runBreaks(nowSeconds = Math.floor(Date.now() / 1000)): Promise<{ told: number; restarted: number; failed: number; dropped: number }> {
  const counts = { told: 0, restarted: 0, failed: 0, dropped: 0 };
  if (!isRedisConfigured() || !isBillingConfigured()) return counts;
  const deadline=nowSeconds+RESTART_NOTICE_DAYS*DAY;
  if(!Number.isSafeInteger(nowSeconds)||nowSeconds<0||!Number.isSafeInteger(deadline)||deadline>1_000_000_000_000){counts.failed+=1;return counts;}
  let reply:unknown;
  try{reply=await redisPipeline([["EVAL", PAUSE_DUE_OBSERVATION, 1, DUE, deadline]]);}catch{counts.failed+=1;return counts;}
  // Check cardinality and string sizes before visiting or encoding the reply.
  // A malformed acknowledgement must not turn this bounded reader into an
  // unbounded financial-snapshot traversal.
  const refs = boundedPauseDueRefs(reply);
  if (refs === null) {
    counts.failed += 1;
    return counts;
  }
  for (const ref of refs) {
    let stored: Awaited<ReturnType<typeof storedPauseAt>>;
    try {
      stored = await storedPauseAt(ref);
    } catch {
      // A single unavailable record must not erase its evidence or abort
      // the other distinct members of this already bounded due batch.
      counts.failed += 1;
      continue;
    }
    const record = stored.record;
    if (!record && !stored.missing) {
      counts.failed += 1;
      continue;
    }
    if (!record) {
      // The explicit pause miss above proves this is only a stale due member.
      if (!(await forgetObserved(ref, stored.raw))) { counts.failed += 1; continue; }
      counts.dropped += 1;
      continue;
    }
    // A funded pause is immutable evidence for its future restart owner.
    // The legacy notice sends before an unguarded SET of `told`: another
    // worker could already have claimed these exact bytes while email waits.
    // Until notice funding and generation-aware ACK/CAS are covered, retain
    // the untouched pause without owner reads, email or a replacement SET.
    if (record.funding && record.until > nowSeconds) {
      counts.failed += 1;
      continue;
    }
    // A nullable store lookup does not distinguish absence from unreadable
    // data. Neither that nor a transport failure authorizes erasing a known
    // pause, its due entry, or its once-a-year evidence.
    let store: Store | null;
    try {
      // Funded due work must bound the source bytes and reject missing raw
      // financial primitives before restart admission; legacy lookup stays intact.
      store = record.funding ? await storeForRestartSource(ref) : await storeForEmail(ref);
    } catch {
      counts.failed += 1;
      continue;
    }
    if (!store || storeRef(store) !== ref) {
      counts.failed += 1;
      continue;
    }
    // Started again by hand, from the studio, on a subscription of its own:
    // there is nothing left to start.
    if (!record.funding && store.subscriptionActive && store.subscriptionId !== record.subscription) {
      if (!(await forgetObserved(ref, stored.raw))) { counts.failed += 1; continue; }
      counts.dropped += 1;
      continue;
    }
    if (record.until > nowSeconds) {
      if (!record.told && !knownNoticeSource(stored.raw)) { counts.failed += 1; continue; }
      // Told on a send that may have gone too: the notice has no key of its own,
      // so the next daily run would write it a second time (rule 30). Only a
      // certain refusal leaves it for the next run.
      const soon = record.told ? null : await tell(store, "soon", record).catch(() => "refused" as const);
      if (soon === "uncertain") console.error("plan-pause: the notice that a break ends may have gone; marked told, not sent again", ref);
      if (soon === "sent" || soon === "uncertain") {
        if (!(await markObservedNotice(ref, stored.raw, record, nowSeconds))) { counts.failed += 1; continue; }
        counts.told += 1;
      }
      continue;
    }
    // A due record alone does not prove that its original plan stopped.
    // If that same subscription still appears active, keep the evidence and
    // wait for reconciliation rather than starting a second paid plan.
    if (store.subscriptionActive) {
      counts.failed += 1;
      continue;
    }
    // A retained pause never authorizes charging a different current source.
    if (store.subscriptionId !== record.subscription || store.stripeCustomerId !== record.customer ||
        store.tier !== record.tier || store.cycle !== "month") {
      counts.failed += 1;
      continue;
    }
    try {
      const started = await restartPlan({
        store,
        customerId: record.customer,
        paymentMethod: record.paymentMethod,
        tier: record.tier,
        idempotencyKey: `restart:${record.subscription}:${record.until}`,
        ...(record.funding ? { funding: { statsId: store.statsId ?? "", sourceSubscriptionId: record.subscription, sourceGrantId: record.funding.grantId, ref, paused: stored.raw ?? "" } } : {}),
      });
      if(started.fundedPublication===true){
        // The joint publisher already acknowledged Store, indexes and exact generation cleanup.
        // Funded notice obligations remain held; no unbudgeted legacy email is sent here.
        counts.restarted+=1;
        continue;
      }
      let saved: Store | null;
      try { saved = await setSubscription(ref, started, store); }
      catch {
        // Saving failed after the provider answered. This is not a card
        // refusal and must not enter the legacy charge-failure cleanup.
        counts.failed += 1;
        continue;
      }
      // A provider response is not an acknowledged store write. Retain the
      // exact pause and due evidence when the nullable writer cannot confirm.
      if (!saved) { counts.failed += 1; continue; }
      if (!(await forgetObserved(ref, stored.raw))) { counts.failed += 1; continue; }
      await tell(store, "restarted", record).catch(() => false);
      counts.restarted += 1;
    } catch (error) {
      console.error("starting a plan again after a break failed", store.handle, error);
      // The funded protocol retains every uncertain source/intent. It must not
      // enter the legacy retry window, forget its evidence, or announce success.
      if (record.funding) { counts.failed += 1; continue; }
      // Stripe or the network failing is not the card failing: tried again on
      // the next run, for a few days, before the creator is told it did not work.
      if (!declined(error) && nowSeconds - record.until < RETRY_DAYS * DAY) {
        counts.failed += 1;
        continue;
      }
      if (!(await forgetObserved(ref, stored.raw))) { counts.failed += 1; continue; }
      await tell(store, declined(error) ? "failed" : "unconfirmed", record).catch(() => false);
      counts.failed += 1;
    }
  }
  return counts;
}
