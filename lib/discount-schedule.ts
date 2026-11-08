/**
 * A discount code with a start and an end set ahead (511 [CK3]).
 *
 * The code is made at once on the creator's own Stripe account, switched off
 * and with Stripe's own expiry as its end (lib/discount.ts, createCode), so a
 * buyer cannot use it before its start and Stripe stops it at its end with
 * nothing from us. What is kept here is only what the five-minute job
 * (app/api/cron/imports) needs to switch it on at its start:
 *
 *   nl:dsched:<statsId>        hash: promotion code id -> {c code, s start, e end, t tries, f failed}
 *   nl:dsched:due              sorted set: "<sid>|<statsId>|<promotion code id>" by when it is next tried
 *   nl:dsched:lock:<statsId>   one store's schedules changed by one hand at a time, a minute at most
 *
 * At most MAX_SCHEDULED_CODES a store; each goes once switched on (Stripe
 * holds the rest from then), or when the creator cancels it, or with the
 * store. A try is confirmed only by Stripe's exact answer (active true, this
 * code); anything else is tried again at the next run, ACTIVATION_TRIES times
 * in all, then kept as failed for the studio to say so, the code still off.
 * Every Redis reply is read in its exact shape (lib/redis-reply.ts): an
 * unreadable one acts on nothing and leaves the entry for the next run. A
 * kept record that cannot be parsed reads the same at every run, so it
 * leaves the due list at once (the code stays off, as made) and stays in the
 * store's hash for the studio and for the creator's Cancel.
 */
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { activateCode, createCode, stopCode, type DiscountCode } from "@/lib/discount";
import type { CodeAsked } from "@/lib/discount-input";
import {
  ACTIVATION_TRIES,
  MAX_SCHEDULED_CODES,
  RETRY_SECONDS,
  type ScheduleEntry,
  type ScheduleWindow,
} from "@/lib/discount-schedule-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { STORE_ID_PATTERN, type Store, setHasDiscounts, storeForId, storeRef } from "@/lib/store";

export const DUE_KEY = "nl:dsched:due";
const scheduleKey = (statsId: string) => `nl:dsched:${statsId}`;
const lockKey = (statsId: string) => `nl:dsched:lock:${statsId}`;
/** How long one change holds a store's schedules: inside a request's or a run's minute. */
const LOCK_SECONDS = 60;
/** Codes the job looks at in one run, at the most; the rest wait for the next. */
export const DUE_PER_RUN = 25;
const HEX32 = /^[0-9a-f]{32}$/;
const PROMO_ID = /^[A-Za-z0-9_]{1,80}$/;

type Shop = Pick<Store, "sid" | "statsId" | "stripeAccountId">;

const memberOf = (sid: string, statsId: string, id: string) => `${sid}|${statsId}|${id}`;

/**
 * The store with this id, read exactly, for work dropped for good when its
 * store is gone: "none" only when the id's own key (nl:store:id:<sid>, which
 * deleting a store removes first) is confirmed absent; "unknown" when that
 * reply is not in its exact shape or the record behind it cannot be read, so
 * a partial answer is never taken for a store that is gone.
 */
async function storeExactly(sid: string): Promise<Store | "none" | "unknown"> {
  if (!STORE_ID_PATTERN.test(sid) || !isRedisConfigured()) return "unknown";
  const replies = repliesFor(await redisPipeline([["GET", `nl:store:id:${sid}`]]), 1);
  if (!replies) return "unknown";
  const ref = replies[0];
  if (ref === null) return "none";
  if (typeof ref !== "string" || !ref) return "unknown";
  return (await storeForId(sid)) ?? "unknown";
}

/** A kept schedule, read in its exact shape, or null. */
function readRecord(id: string, raw: string): ScheduleEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { c, s, e, t, f } = value as Record<string, unknown>;
  const int = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (typeof c !== "string" || !c || !int(s) || !int(e) || e <= s || !int(t) || (f !== 0 && f !== 1)) return null;
  return { id, code: c, start: s, end: e, tries: t, failed: f === 1 };
}

const writeRecord = (entry: ScheduleEntry) =>
  JSON.stringify({ c: entry.code, s: entry.start, e: entry.end, t: entry.tries, f: entry.failed ? 1 : 0 });

/** Runs `work` holding the store's lock: "busy" when another hand holds it, "unknown" when that cannot be told. */
async function holding<T>(statsId: string, work: () => Promise<T>): Promise<T | "busy" | "unknown"> {
  const value = claimValue();
  const got = await claimMark(lockKey(statsId), LOCK_SECONDS, value);
  if (got === "taken") return "busy";
  if (got !== "ours") return "unknown";
  try {
    return await work();
  } finally {
    await releaseMark(lockKey(statsId), value);
  }
}

/** Whether every reply of a pipeline is a count: the writes landed as asked. */
async function counted(commands: (string | number)[][]): Promise<boolean> {
  try {
    const replies = repliesFor(await redisPipeline(commands), commands.length);
    return Boolean(replies && replies.every((reply) => countOf(reply) !== null));
  } catch {
    return false;
  }
}

export type Scheduled =
  | { ok: true; code: DiscountCode }
  /** "live": Stripe made the code live at once and did not confirm it off; it is kept as failed for the studio to show. */
  | { ok: false; reason: "busy" | "full" | "taken" | "stripe" | "unknown" | "live" };

/**
 * Makes a code that starts and ends at set times: switched off on the
 * creator's Stripe account, Stripe's expiry its end, and kept here to be
 * switched on at its start. The store's cap and lock are checked before
 * Stripe is asked anything. The caller has already taken SCHEDULE_UNITS
 * studio requests, which pay for every try the job may make.
 */
export async function scheduleCode(shop: Shop, asked: CodeAsked, window: ScheduleWindow, nowSeconds: number): Promise<Scheduled> {
  const { statsId, stripeAccountId: account } = shop;
  if (!isRedisConfigured() || !statsId || !HEX32.test(statsId) || !HEX32.test(shop.sid) || !account) return { ok: false, reason: "unknown" };
  // Read by the route against the same clock; a window already over is never made.
  if (window.start <= nowSeconds || window.end <= window.start) return { ok: false, reason: "unknown" };
  const result = await holding<Scheduled>(statsId, async () => {
    let held: number | null = null;
    try {
      const replies = repliesFor(await redisPipeline([["HLEN", scheduleKey(statsId)]]), 1);
      held = replies ? countOf(replies[0]) : null;
    } catch {
      held = null;
    }
    if (held === null) return { ok: false, reason: "unknown" };
    if (held >= MAX_SCHEDULED_CODES) return { ok: false, reason: "full" };

    const made = await createCode(account, asked.code, asked.off, asked.maxRedemptions, asked.minimum, { expiresAt: window.end });
    if (!made.ok) return { ok: false, reason: made.reason };
    // Made live, or under an id this file cannot keep: never left live by mistake.
    if (made.code.active !== false || !PROMO_ID.test(made.code.id)) {
      // Asked twice: a stop Stripe answers in an unclear way is tried once more at once.
      if ((await stopCode(account, made.code.id)) || (await stopCode(account, made.code.id))) return { ok: false, reason: "stripe" };
      // Live and not confirmed off: kept as failed and never due, so the studio lists it beside Stripe's own
      // "Live" and the creator's Cancel or "Switch it off" stops it; the creator is told in words either way.
      if (PROMO_ID.test(made.code.id)) {
        const failed: ScheduleEntry = { id: made.code.id, code: asked.code, start: window.start, end: window.end, tries: 0, failed: true };
        await counted([["HSET", scheduleKey(statsId), failed.id, writeRecord(failed)]]);
      }
      return { ok: false, reason: "live" };
    }
    const entry: ScheduleEntry = { id: made.code.id, code: asked.code, start: window.start, end: window.end, tries: 0, failed: false };
    const kept = await counted([
      ["HSET", scheduleKey(statsId), entry.id, writeRecord(entry)],
      ["ZADD", DUE_KEY, window.start, memberOf(shop.sid, statsId, entry.id)],
    ]);
    // Not kept: the code stays off on Stripe, never live without a start.
    return kept ? { ok: true, code: made.code } : { ok: false, reason: "unknown" };
  });
  return typeof result === "string" ? { ok: false, reason: result } : result;
}

/** A store's scheduled codes, read exactly, or not known. */
export async function readSchedules(statsId: string | null): Promise<{ ok: true; schedules: ScheduleEntry[] } | { ok: false }> {
  if (!statsId) return { ok: true, schedules: [] };
  if (!isRedisConfigured() || !HEX32.test(statsId)) return { ok: false };
  try {
    const replies = repliesFor(await redisPipeline([["HGETALL", scheduleKey(statsId)]]), 1);
    const flat = replies ? stringList(replies[0]) : null;
    if (!flat || flat.length % 2 !== 0) return { ok: false };
    const schedules: ScheduleEntry[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      const entry = readRecord(flat[i], flat[i + 1]);
      if (!entry) return { ok: false };
      schedules.push(entry);
    }
    schedules.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    return { ok: true, schedules };
  } catch {
    return { ok: false };
  }
}

/** Takes a code's schedule away, if it has one, holding the store's lock. */
async function unkeep(shop: Shop, statsId: string, id: string): Promise<"done" | "none" | "unknown"> {
  let held: unknown;
  try {
    const replies = repliesFor(await redisPipeline([["HGET", scheduleKey(statsId), id]]), 1);
    if (!replies) return "unknown";
    held = replies[0];
  } catch {
    return "unknown";
  }
  if (held === null) return "none";
  if (typeof held !== "string") return "unknown";
  const gone = await counted([
    ["HDEL", scheduleKey(statsId), id],
    ["ZREM", DUE_KEY, memberOf(shop.sid, statsId, id)],
  ]);
  return gone ? "done" : "unknown";
}

/**
 * The creator cancels a scheduled code: its schedule goes, so the job never
 * switches it on, then Stripe is told to keep it off (it already is, unless
 * a try the job could not confirm did switch it on). With no schedule left
 * (the job switched it on after the creator's page was read, or it was
 * canceled already) the code is switched off on the creator's own Stripe
 * account all the same: "stopped", so the studio never says "It stays off"
 * of a code that was live. Either answer only once Stripe confirms it off.
 */
export async function cancelSchedule(shop: Shop, id: string): Promise<"done" | "stopped" | "busy" | "unknown" | "stripe"> {
  const statsId = shop.statsId;
  if (!statsId || !HEX32.test(statsId) || !PROMO_ID.test(id) || !shop.stripeAccountId) return "unknown";
  const account = shop.stripeAccountId;
  const result = await holding(statsId, async () => {
    const taken = await unkeep(shop, statsId, id);
    if (taken === "unknown") return "unknown";
    if (!(await stopCode(account, id))) return "stripe";
    return taken === "done" ? "done" : "stopped";
  });
  return result;
}

/**
 * Drops a code's schedule before it is switched off by hand (the studio's
 * "Switch it off"), so the job cannot switch it back on. "done" also when it
 * had none.
 */
export async function dropSchedule(shop: Shop, id: string): Promise<"done" | "busy" | "unknown"> {
  const statsId = shop.statsId;
  if (!statsId || !PROMO_ID.test(id)) return "done";
  if (!HEX32.test(statsId)) return "unknown";
  const result = await holding(statsId, () => unkeep(shop, statsId, id));
  return result === "none" ? "done" : result;
}

type Outcome = "activated" | "retried" | "failed" | "dropped" | "unknown";
export type ActivationCounts = Record<Outcome, number>;

type Deps<S extends Shop> = {
  /** The store, read exactly: null or "none" only when it is confirmed gone; "unknown" keeps the code due. */
  findStore: (sid: string) => Promise<S | null | "none" | "unknown">;
  /**
   * The checkout's code box, switched on once a code is live (lib/store.ts,
   * hasDiscounts): confirmed only by the store it answers with the box on.
   */
  markDiscounts: (store: S) => Promise<unknown>;
};

const DEFAULT_DEPS: Deps<Store> = {
  findStore: storeExactly,
  markDiscounts: (store) => setHasDiscounts(storeRef(store), true),
};

/** Whether the store's answer says the checkout's code box is on: nothing else (null, a throw, a partial record) does. */
const boxOn = (answer: unknown): boolean =>
  Boolean(answer && typeof answer === "object" && !Array.isArray(answer) && Object.hasOwn(answer, "hasDiscounts") && (answer as { hasDiscounts?: unknown }).hasDiscounts === true);

async function drop(member: string): Promise<void> {
  await counted([["ZREM", DUE_KEY, member]]);
}

/** A try that did not confirm: counted, and the next one set, or the code kept as failed. */
async function missed(shop: Shop, statsId: string, entry: ScheduleEntry, nowSeconds: number, last = false): Promise<Outcome> {
  const tries = entry.tries + 1;
  const member = memberOf(shop.sid, statsId, entry.id);
  if (last || tries >= ACTIVATION_TRIES) {
    const kept = await counted([
      ["HSET", scheduleKey(statsId), entry.id, writeRecord({ ...entry, tries, failed: true })],
      ["ZREM", DUE_KEY, member],
    ]);
    return kept ? "failed" : "unknown";
  }
  const kept = await counted([
    ["HSET", scheduleKey(statsId), entry.id, writeRecord({ ...entry, tries })],
    ["ZADD", DUE_KEY, nowSeconds + RETRY_SECONDS, member],
  ]);
  return kept ? "retried" : "unknown";
}

async function activateOne<S extends Shop>(shop: S, statsId: string, id: string, nowSeconds: number, deps: Deps<S>): Promise<Outcome> {
  const member = memberOf(shop.sid, statsId, id);
  const result = await holding<Outcome>(statsId, async () => {
    let raw: unknown;
    try {
      const replies = repliesFor(await redisPipeline([["HGET", scheduleKey(statsId), id]]), 1);
      if (!replies) return "unknown";
      raw = replies[0];
    } catch {
      return "unknown";
    }
    // Canceled: nothing to switch on.
    if (raw === null) {
      await drop(member);
      return "dropped";
    }
    if (typeof raw !== "string") return "unknown";
    const entry = readRecord(id, raw);
    // Unreadable: it reads the same at every run, so it leaves the due list now and never holds a healthy
    // code behind it. Never acted on (the code stays off, as made); the record stays for the studio and for
    // the creator's Cancel, which takes it away.
    if (!entry) {
      await drop(member);
      return "failed";
    }
    if (entry.failed) {
      await drop(member);
      return "dropped";
    }
    if (nowSeconds < entry.start) return "unknown";
    // Its end came before any try could: shown as failed, Stripe not asked.
    if (nowSeconds >= entry.end) return missed(shop, statsId, entry, nowSeconds, true);
    if (!shop.stripeAccountId) return missed(shop, statsId, entry, nowSeconds);
    // One key a try: a repeat of the same try is answered, not done again; the next try is a new request.
    const live = await activateCode(shop.stripeAccountId, id, `dsched:${id}:${entry.start}:${entry.tries}`);
    if (!live) return missed(shop, statsId, entry, nowSeconds);
    // Live on Stripe. The checkout's code box goes on first, confirmed by the store it answers with; a box
    // not confirmed on is a missed try like any other (counted, tried again at the next run, which Stripe
    // answers the same way, then kept as failed), so the code is never counted live while buyers cannot type it.
    let box: unknown = null;
    try {
      box = await deps.markDiscounts(shop);
    } catch (error) {
      console.error("switching the checkout's code box on failed", error);
    }
    if (!boxOn(box)) {
      await missed(shop, statsId, entry, nowSeconds);
      return "unknown";
    }
    // Only then the schedule goes: Stripe holds the rest. If this write is not confirmed the entry stays,
    // and the next run switches it on again, which Stripe and the store answer the same way.
    if (!(await counted([["HDEL", scheduleKey(statsId), id], ["ZREM", DUE_KEY, member]]))) return "unknown";
    return "activated";
  });
  return result === "busy" ? "unknown" : result;
}

/**
 * The scheduled codes now due, switched on, from the five-minute job: at most
 * DUE_PER_RUN a run and only until `deadline`. Each code's tries were paid for
 * when it was scheduled (SCHEDULE_UNITS studio requests).
 */
export async function activateScheduledCodes<S extends Shop = Store>(
  deadline: number,
  nowSeconds = Math.floor(Date.now() / 1000),
  deps: Deps<S> = DEFAULT_DEPS as unknown as Deps<S>,
): Promise<ActivationCounts> {
  const counts: ActivationCounts = { activated: 0, retried: 0, failed: 0, dropped: 0, unknown: 0 };
  if (!isRedisConfigured()) return counts;
  let due: string[] | null = null;
  try {
    const replies = repliesFor(await redisPipeline([["ZRANGEBYSCORE", DUE_KEY, "0", String(nowSeconds), "LIMIT", "0", String(DUE_PER_RUN)]]), 1);
    due = replies ? stringList(replies[0]) : null;
  } catch {
    due = null;
  }
  if (!due) {
    counts.unknown += 1;
    return counts;
  }
  for (const member of due) {
    if (Date.now() >= deadline) break;
    const parts = member.split("|");
    if (parts.length !== 3 || !HEX32.test(parts[0]) || !HEX32.test(parts[1]) || !PROMO_ID.test(parts[2])) {
      await drop(member);
      counts.dropped += 1;
      continue;
    }
    const [sid, statsId, id] = parts;
    let shop: S | null | "none" | "unknown";
    try {
      shop = await deps.findStore(sid);
    } catch {
      counts.unknown += 1;
      continue;
    }
    // Not read exactly: kept for the next run, never taken for a store that is gone.
    if (shop === "unknown") {
      counts.unknown += 1;
      continue;
    }
    // Gone, or not this store: its schedule is erased with the store (lib/data-families.ts).
    if (!shop || shop === "none" || shop.statsId !== statsId) {
      await drop(member);
      counts.dropped += 1;
      continue;
    }
    counts[await activateOne(shop, statsId, id, nowSeconds, deps)] += 1;
  }
  return counts;
}
