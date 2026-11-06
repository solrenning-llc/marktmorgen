/**
 * A discount code with a start and an end set ahead (511 [CK3]).
 *
 * The code is made at once on the creator's own Stripe account, switched off
 * and with Stripe's own expiry as its end (lib/discount.ts, createCode), so a
 * buyer cannot use it before its start and Stripe stops it at its end with
 * nothing from us. What is kept here is only what the five-minute job
 * (app/api/cron/imports) needs to switch it on at its start:
 *
 *   nl:dsched:<statsId>        hash: promotion code id -> {c code, s start, e end, t tries, f failed,
 *                              n email tries, m email settled} (n and m written only once set)
 *   nl:dsched:due              sorted set: "<sid>|<statsId>|<promotion code id>" by when it is next tried
 *   nl:dsched:tell             sorted set: the same members, failed codes whose email is due (unit 2)
 *   nl:dsched:lock:<statsId>   one store's schedules changed by one hand at a time, a minute at most
 *
 * At most MAX_SCHEDULED_CODES a store; each goes once switched on (Stripe
 * holds the rest from then), or when the creator cancels it, or with the
 * store. A try is confirmed only by Stripe's exact answer (active true, this
 * code); anything else is tried again at the next run, ACTIVATION_TRIES times
 * in all, then kept as failed for the studio to say so, the code still off.
 * A code counts as switched on only once the checkout's code box is on too,
 * confirmed before its schedule goes; otherwise it is switched back off and
 * the try counted. Every Redis reply is read in its exact shape
 * (lib/redis-reply.ts): an unreadable one acts on nothing and leaves the
 * entry for the next run. A kept record that cannot be read leaves the due
 * list, its code still off, so it never holds the codes behind it.
 *
 * Unit 2: a code that reaches failed is put on the list to tell, and the same
 * job emails the creator once (lib/discount-schedule-notice.ts). The email is
 * marked settled in the code's record before it is sent, so a run that dies
 * after sending never sends it again; a send that did not go is unmarked and
 * tried again NOTICE_RETRY_SECONDS later, NOTICE_TRIES times in all, then
 * never. A code canceled before its email takes its email with it.
 */
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { activateCode, createCode, stopCode, type DiscountCode } from "@/lib/discount";
import type { CodeAsked } from "@/lib/discount-input";
import {
  ACTIVATION_TRIES,
  MAX_SCHEDULED_CODES,
  NOTICE_RETRY_SECONDS,
  NOTICE_TRIES,
  RETRY_SECONDS,
  type ScheduleEntry,
  type ScheduleWindow,
} from "@/lib/discount-schedule-rules";
import { tellActivationFailed } from "@/lib/discount-schedule-notice";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { type Store, setHasDiscounts, storeForId, storeRef } from "@/lib/store";

export const DUE_KEY = "nl:dsched:due";
/** Failed codes whose email to the creator is due (unit 2). */
export const TELL_KEY = "nl:dsched:tell";
const scheduleKey = (statsId: string) => `nl:dsched:${statsId}`;
const lockKey = (statsId: string) => `nl:dsched:lock:${statsId}`;
/** How long one change holds a store's schedules: inside a request's or a run's minute. */
const LOCK_SECONDS = 60;
/** Codes the job looks at in one run, at the most; the rest wait for the next. */
export const DUE_PER_RUN = 25;
/** Failed codes' emails the job tries in one run, at the most; the rest wait for the next. */
export const TELL_PER_RUN = 5;
const HEX32 = /^[0-9a-f]{32}$/;
const PROMO_ID = /^[A-Za-z0-9_]{1,80}$/;

type Shop = Pick<Store, "sid" | "statsId" | "stripeAccountId">;

const memberOf = (sid: string, statsId: string, id: string) => `${sid}|${statsId}|${id}`;

/** A kept schedule, with what this file alone needs of its email: tries made, and settled (sent, being sent, or given up). */
type Kept = ScheduleEntry & { notices: number; mailed: boolean };

/** A kept schedule, read in its exact shape, or null. */
function readRecord(id: string, raw: string): Kept | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { c, s, e, t, f } = record;
  const int = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (typeof c !== "string" || !c || !int(s) || !int(e) || e <= s || !int(t) || (f !== 0 && f !== 1)) return null;
  // Absent until the first email try; present, only in their own shape.
  const n = Object.hasOwn(record, "n") ? record.n : 0;
  const m = Object.hasOwn(record, "m") ? record.m : 0;
  if (!int(n) || n > NOTICE_TRIES || (m !== 0 && m !== 1)) return null;
  return { id, code: c, start: s, end: e, tries: t, failed: f === 1, notices: n, mailed: m === 1 };
}

const writeRecord = (entry: ScheduleEntry & Partial<Pick<Kept, "notices" | "mailed">>) =>
  JSON.stringify({
    c: entry.code, s: entry.start, e: entry.end, t: entry.tries, f: entry.failed ? 1 : 0,
    ...(entry.notices ? { n: entry.notices } : {}),
    ...(entry.mailed ? { m: 1 } : {}),
  });

/** What the studio is told of a kept schedule: nothing about the email. */
const shown = ({ id, code, start, end, tries, failed }: Kept): ScheduleEntry => ({ id, code, start, end, tries, failed });

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
  | { ok: false; reason: "busy" | "full" | "taken" | "stripe" | "unknown" };

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
      await stopCode(account, made.code.id);
      return { ok: false, reason: "stripe" };
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
      schedules.push(shown(entry));
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
  // Its email, if one is due, goes with it.
  const gone = await counted([
    ["HDEL", scheduleKey(statsId), id],
    ["ZREM", DUE_KEY, memberOf(shop.sid, statsId, id)],
    ["ZREM", TELL_KEY, memberOf(shop.sid, statsId, id)],
  ]);
  return gone ? "done" : "unknown";
}

/**
 * The creator cancels a scheduled code: its schedule goes, so the job never
 * switches it on, then Stripe is told to keep it off (it already is, unless
 * a try the job could not confirm did switch it on).
 */
export async function cancelSchedule(shop: Shop, id: string): Promise<"done" | "none" | "busy" | "unknown" | "stripe"> {
  const statsId = shop.statsId;
  if (!statsId || !HEX32.test(statsId) || !PROMO_ID.test(id) || !shop.stripeAccountId) return "unknown";
  const account = shop.stripeAccountId;
  const result = await holding(statsId, async () => {
    const taken = await unkeep(shop, statsId, id);
    if (taken !== "done") return taken;
    return (await stopCode(account, id)) ? "done" : "stripe";
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
type NoticeOutcome = "told" | "untold" | "dropped" | "unknown";
export type NoticeCounts = Record<NoticeOutcome, number>;
export type ActivationCounts = Record<Outcome, number> & { notices: NoticeCounts };

type Deps<S extends Shop> = {
  findStore: (sid: string) => Promise<S | null>;
  /**
   * The checkout's code box, switched on once a code is live (lib/store.ts,
   * hasDiscounts): `true` only when the store was read back with it on.
   */
  markDiscounts: (store: S) => Promise<unknown>;
  /** The email that a code failed (lib/discount-schedule-notice.ts): true only when it went. */
  tell?: (store: S, entry: ScheduleEntry, nowSeconds: number) => Promise<boolean>;
};

/** Whether the store setHasDiscounts answered with has the checkout's code box on: null or anything else is not. */
export const boxSwitchedOn = (store: Pick<Store, "hasDiscounts"> | null): boolean => store?.hasDiscounts === true;

const DEFAULT_DEPS: Deps<Store> = {
  findStore: storeForId,
  markDiscounts: async (store) => boxSwitchedOn(await setHasDiscounts(storeRef(store), true)),
  tell: tellActivationFailed,
};

/** The box switched on and confirmed; a throw or any answer but `true` is not. */
async function boxOn<S extends Shop>(shop: S, deps: Deps<S>): Promise<boolean> {
  try {
    return (await deps.markDiscounts(shop)) === true;
  } catch (error) {
    console.error("switching the checkout's code box on failed", error);
    return false;
  }
}

async function drop(member: string, key = DUE_KEY): Promise<void> {
  await counted([["ZREM", key, member]]);
}

/** A try that did not confirm: counted, and the next one set, or the code kept as failed. */
async function missed(shop: Shop, statsId: string, entry: Kept, nowSeconds: number, last = false): Promise<Outcome> {
  const tries = entry.tries + 1;
  const member = memberOf(shop.sid, statsId, entry.id);
  if (last || tries >= ACTIVATION_TRIES) {
    // Failed: out of the list to switch on, onto the list to tell the creator, in this same run.
    const kept = await counted([
      ["HSET", scheduleKey(statsId), entry.id, writeRecord({ ...entry, tries, failed: true })],
      ["ZREM", DUE_KEY, member],
      ["ZADD", TELL_KEY, nowSeconds, member],
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
    // A record that cannot be read is never acted on: its code stays off, the record is kept for the
    // studio, and it leaves the due list, so it can neither hold the codes behind it nor cost a run for ever.
    if (!entry) {
      await drop(member);
      return "dropped";
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
    // Live on Stripe, but no buyer can use it until the checkout's code box is on: that comes first,
    // confirmed, while the schedule is still kept. Not confirmed: the code is switched back off (never
    // "Live" in the studio while buyers have no box) and the try is counted, so the next run tries again,
    // within the tries already paid for, and the last one leaves it failed and off.
    if (!(await boxOn(shop, deps))) {
      await stopCode(shop.stripeAccountId, id);
      return missed(shop, statsId, entry, nowSeconds);
    }
    // Live and usable: the schedule goes, Stripe holds the rest. If this write is not confirmed the entry
    // stays, and the next run switches both on again, which Stripe and the store answer the same way.
    if (!(await counted([["HDEL", scheduleKey(statsId), id], ["ZREM", DUE_KEY, member]]))) return "unknown";
    return "activated";
  });
  return result === "busy" ? "unknown" : result;
}

/**
 * One failed code's email, holding the store's lock. The record is marked
 * settled, with the try counted, before the email is sent: a run that dies
 * after sending leaves it settled, so it is never sent twice. A send that did
 * not go is unmarked and set for NOTICE_RETRY_SECONDS later, until
 * NOTICE_TRIES tries are made; then it stays settled and is never tried again.
 */
async function tellOne<S extends Shop>(shop: S, statsId: string, id: string, nowSeconds: number, tell: NonNullable<Deps<S>["tell"]>): Promise<NoticeOutcome> {
  const member = memberOf(shop.sid, statsId, id);
  const result = await holding<NoticeOutcome>(statsId, async () => {
    let raw: unknown;
    try {
      const replies = repliesFor(await redisPipeline([["HGET", scheduleKey(statsId), id]]), 1);
      if (!replies) return "unknown";
      raw = replies[0];
    } catch {
      return "unknown";
    }
    // Canceled, or switched off by hand: nothing to tell.
    if (raw === null) {
      await drop(member, TELL_KEY);
      return "dropped";
    }
    if (typeof raw !== "string") return "unknown";
    const entry = readRecord(id, raw);
    // Unreadable: never told about on a guess, and moved an hour on, so it never holds the
    // front of the list (read lowest first) against the codes that can be told.
    if (!entry) {
      await counted([["ZADD", TELL_KEY, nowSeconds + NOTICE_RETRY_SECONDS, member]]);
      return "unknown";
    }
    // Not failed, already told (or being told), or out of tries: never sent.
    if (!entry.failed || entry.mailed || entry.notices >= NOTICE_TRIES) {
      await drop(member, TELL_KEY);
      return "dropped";
    }
    const notices = entry.notices + 1;
    const settled = await counted([
      ["HSET", scheduleKey(statsId), id, writeRecord({ ...entry, notices, mailed: true })],
      ["ZREM", TELL_KEY, member],
    ]);
    if (!settled) return "unknown";
    let sent = false;
    try {
      sent = await tell(shop, shown(entry), nowSeconds);
    } catch (error) {
      console.error("emailing that a scheduled discount code failed did not work", error);
      sent = false;
    }
    if (sent === true) return "told";
    // The last try: it stays settled, and is never tried again.
    if (notices >= NOTICE_TRIES) return "untold";
    // Not sent: unmarked, and tried again later. If this write is not confirmed it stays settled: never sent twice.
    await counted([
      ["HSET", scheduleKey(statsId), id, writeRecord({ ...entry, notices, mailed: false })],
      ["ZADD", TELL_KEY, nowSeconds + NOTICE_RETRY_SECONDS, member],
    ]);
    return "untold";
  });
  return result === "busy" ? "unknown" : result;
}

/** The failed codes' emails now due: at most TELL_PER_RUN a run, and only until `deadline`. */
async function tellFailedCodes<S extends Shop>(deadline: number, nowSeconds: number, deps: Deps<S>): Promise<NoticeCounts> {
  const counts: NoticeCounts = { told: 0, untold: 0, dropped: 0, unknown: 0 };
  const tell = deps.tell ?? (DEFAULT_DEPS.tell as unknown as NonNullable<Deps<S>["tell"]>);
  let due: string[] | null = null;
  try {
    const replies = repliesFor(await redisPipeline([["ZRANGEBYSCORE", TELL_KEY, "0", String(nowSeconds), "LIMIT", "0", String(TELL_PER_RUN)]]), 1);
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
      await drop(member, TELL_KEY);
      counts.dropped += 1;
      continue;
    }
    const [sid, statsId, id] = parts;
    let shop: S | null;
    try {
      shop = await deps.findStore(sid);
    } catch {
      counts.unknown += 1;
      continue;
    }
    if (!shop || shop.statsId !== statsId) {
      await drop(member, TELL_KEY);
      counts.dropped += 1;
      continue;
    }
    counts[await tellOne(shop, statsId, id, nowSeconds, tell)] += 1;
  }
  return counts;
}

/**
 * The scheduled codes now due, switched on, from the five-minute job: at most
 * DUE_PER_RUN a run and only until `deadline`; then the emails for codes that
 * failed (unit 2). Each code's tries, and its email's, were paid for when it
 * was scheduled (SCHEDULE_UNITS studio requests); the email itself is taken
 * from the store's email figure as it goes.
 */
export async function activateScheduledCodes<S extends Shop = Store>(
  deadline: number,
  nowSeconds = Math.floor(Date.now() / 1000),
  deps: Deps<S> = DEFAULT_DEPS as unknown as Deps<S>,
): Promise<ActivationCounts> {
  const counts: ActivationCounts = { activated: 0, retried: 0, failed: 0, dropped: 0, unknown: 0, notices: { told: 0, untold: 0, dropped: 0, unknown: 0 } };
  if (!isRedisConfigured()) return counts;
  await switchDueCodesOn(counts, deadline, nowSeconds, deps);
  counts.notices = await tellFailedCodes(deadline, nowSeconds, deps);
  return counts;
}

async function switchDueCodesOn<S extends Shop>(counts: ActivationCounts, deadline: number, nowSeconds: number, deps: Deps<S>): Promise<void> {
  let due: string[] | null = null;
  try {
    const replies = repliesFor(await redisPipeline([["ZRANGEBYSCORE", DUE_KEY, "0", String(nowSeconds), "LIMIT", "0", String(DUE_PER_RUN)]]), 1);
    due = replies ? stringList(replies[0]) : null;
  } catch {
    due = null;
  }
  if (!due) {
    counts.unknown += 1;
    return;
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
    let shop: S | null;
    try {
      shop = await deps.findStore(sid);
    } catch {
      counts.unknown += 1;
      continue;
    }
    // Gone, or not this store: its schedule is erased with the store (lib/data-families.ts).
    if (!shop || shop.statsId !== statsId) {
      await drop(member);
      counts.dropped += 1;
      continue;
    }
    counts[await activateOne(shop, statsId, id, nowSeconds, deps)] += 1;
  }
}
