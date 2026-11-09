/**
 * Taking from the budget for a person's own data rights (lib/rights-budget-rules.ts),
 * and scheduling what a month cannot pay for, so it is done later by itself
 * (lib/rights-queue.ts, run every hour by app/api/cron/rights).
 *
 *   nl:rights:s:<store id>:<month>    units a paying store's plan paid for, this UTC month
 *   nl:rights:f:<store id>:<month>    units the company paid for one store that pays nothing
 *   nl:rights:co:<month>              units the company paid for, all stores together
 *   nl:rights:p:<hash>:<month>        times one person drew one store's budget
 *   nl:rights:q                       what waits, by when it is next looked at
 *   nl:rights:i:<hash>                one waiting deletion: the store, the address, who asked, when, its deadline
 *
 * Each figure is taken as the store figures are (lib/store-allowance.ts):
 * counted first, and given back whole when any one of them would pass its cap,
 * so a refused take costs nothing and no cap is ever passed but by
 * takeCompanyPastCap. An answer that does not read exactly is unknown: nothing
 * is given back for it and nothing is done on it.
 */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { standingOf } from "@/lib/plan-standing";
import type { PlanFields } from "@/lib/plan-standing";
import type { Tier } from "@/lib/plan";
import {
  RIGHTS_COMPANY_UNITS,
  RIGHTS_FREE_STORE_UNITS,
  RIGHTS_ITEM_SECONDS,
  RIGHTS_PERSON_REQUESTS,
  RIGHTS_PLAN_UNITS,
  RIGHTS_SCHEDULE_UNITS,
  legalDeadline,
  nextRightsMonth,
  rightsDue,
  rightsMonth,
} from "@/lib/rights-budget-rules";

export type RightsStore = PlanFields & { sid: string; tier?: Tier };
/** Who asked: the person by the emailed link, or the store's team from the studio, with who pressed and their role. */
export type RightsBy = { kind: "person" } | { kind: "team"; who: string; role: string };
/** Who paid for a take: the store's plan, or the company. */
export type RightsPayer = "plan" | "company";
export type RightsTaken = { ok: true; payer: RightsPayer } | { ok: false; reason: "full" | "unknown" };

const STORE_ID = /^[0-9a-f]{32}$/;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const planKey = (sid: string, month: string) => `nl:rights:s:${sid}:${month}`;
const freeKey = (sid: string, month: string) => `nl:rights:f:${sid}:${month}`;
const companyKey = (month: string) => `nl:rights:co:${month}`;
const personCountKey = (sid: string, email: string, month: string) => `nl:rights:p:${sha(`rights-person:${sid}:${email}`).slice(0, 40)}:${month}`;
export const RIGHTS_QUEUE = "nl:rights:q";
const itemId = (sid: string, email: string) => sha(`rights-item:${sid}:${email}`).slice(0, 40);
export const rightsItemKey = (id: string) => `nl:rights:i:${id}`;

/** A month's counter is kept to the end of its month and a day more. */
const keepSeconds = (now: number) => Math.ceil((nextRightsMonth(now) - now) / 1000) + 86_400;

type Figure = { key: string; cap: number; n: number };

/** The counts after INCRBY, one a figure, read exactly: null when any reply is not the integer it must be. */
function counted(reply: unknown, figures: Figure[]): number[] | null {
  const slots = repliesFor(reply, figures.length * 2);
  if (!slots) return null;
  const out: number[] = [];
  for (let i = 0; i < figures.length; i++) {
    const set = slots[2 * i];
    const count = slots[2 * i + 1];
    if ((set !== null && set !== "OK") || typeof count !== "number" || !Number.isSafeInteger(count) || count < figures[i].n) return null;
    out.push(count);
  }
  return out;
}

/** Counts every figure, all or nothing: what would pass a cap is given back whole. */
async function takeFigures(figures: Figure[], now: number, overCap = false): Promise<"ok" | "full" | "unknown"> {
  if (!isRedisConfigured()) return "unknown";
  const ttl = keepSeconds(now);
  let reply: unknown;
  try {
    reply = await redisPipeline(figures.flatMap((f) => [["SET", f.key, "0", "NX", "EX", ttl], ["INCRBY", f.key, f.n]]));
  } catch {
    return "unknown";
  }
  // A committed increment with a lost or malformed reply stays counted: never coerced, never given back on a guess.
  const counts = counted(reply, figures);
  if (!counts) return "unknown";
  if (overCap || counts.every((c, i) => c <= figures[i].cap)) return "ok";
  await redisPipeline(figures.map((f) => ["DECRBY", f.key, f.n])).catch(() => {});
  return "full";
}

/** The most a store's own month may pay for: its plan's budget when it pays, its share of the company's otherwise. */
export function rightsCap(store: RightsStore, now: number): number {
  return standingOf(store, now / 1000) === "paid" ? (RIGHTS_PLAN_UNITS[store.tier ?? "creator"] ?? RIGHTS_PLAN_UNITS.creator) : RIGHTS_FREE_STORE_UNITS;
}

/**
 * Takes `units` for one person's request in one store, in the UTC month `now` is in: from the plan's budget when
 * the store pays (standingOf "paid"), from the company's otherwise, within the store's share of it; or, `from`
 * "company", from the company's budget alone (what the store's own month can never pay for: larger than its whole
 * rightsCap). `asking`: this is the person's request itself, not the rest of one already counted, so it also counts
 * as one of theirs.
 */
export async function takeRights(store: RightsStore, email: string, units: number, now: number, asking: boolean, from: "store" | "company" = "store"): Promise<RightsTaken> {
  if (!Number.isSafeInteger(units) || units < 1 || !STORE_ID.test(store.sid) || !email) return { ok: false, reason: "unknown" };
  const month = rightsMonth(now);
  const paid = from === "store" && standingOf(store, now / 1000) === "paid";
  const figures: Figure[] = from === "company"
    ? [{ key: companyKey(month), cap: RIGHTS_COMPANY_UNITS, n: units }]
    : paid
      ? [{ key: planKey(store.sid, month), cap: rightsCap(store, now), n: units }]
      : [{ key: freeKey(store.sid, month), cap: RIGHTS_FREE_STORE_UNITS, n: units }, { key: companyKey(month), cap: RIGHTS_COMPANY_UNITS, n: units }];
  if (asking) figures.push({ key: personCountKey(store.sid, email, month), cap: RIGHTS_PERSON_REQUESTS, n: 1 });
  const taken = await takeFigures(figures, now);
  return taken === "ok" ? { ok: true, payer: paid ? "plan" : "company" } : { ok: false, reason: taken };
}

/**
 * Gives back the one request a person's take counted (takeRights with `asking`) when it did not end in a deletion
 * (the database did not answer, part of it failed, or it was scheduled), so pressing again after a failure is never
 * held to RIGHTS_PERSON_REQUESTS. The units stay counted: they were spent. Best effort: a give-back that fails leaves
 * the count higher, never lower.
 */
export async function giveRightsRequest(store: RightsStore, email: string, now: number): Promise<void> {
  if (!STORE_ID.test(store.sid) || !email || !isRedisConfigured()) return;
  await redisPipeline([["DECRBY", personCountKey(store.sid, email, rightsMonth(now)), 1]]).catch(() => {});
}

/** Takes `units` from the company's budget alone, for what is near its deadline (lib/rights-queue.ts). */
export async function takeCompanyRights(units: number, now: number): Promise<RightsTaken> {
  if (!Number.isSafeInteger(units) || units < 1) return { ok: false, reason: "unknown" };
  const taken = await takeFigures([{ key: companyKey(rightsMonth(now)), cap: RIGHTS_COMPANY_UNITS, n: units }], now);
  return taken === "ok" ? { ok: true, payer: "company" } : { ok: false, reason: taken };
}

/**
 * Counts `units` in the company's budget past its cap: only for what the law says must be done by now and every
 * budget is used up for (lib/rights-queue.ts), and for the few commands scheduling writes. Said in the log by the
 * caller; true once the count is confirmed.
 */
export async function takeCompanyPastCap(units: number, now: number): Promise<boolean> {
  if (!Number.isSafeInteger(units) || units < 1) return false;
  return (await takeFigures([{ key: companyKey(rightsMonth(now)), cap: RIGHTS_COMPANY_UNITS, n: units }], now, true)) === "ok";
}

/** One waiting deletion, as kept in nl:rights:i:<id>. */
export type RightsItem = { s: string; e: string; b: RightsBy; a: number; d: number; f: number };

function parseItem(raw: unknown): RightsItem | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<RightsItem>;
    const by = v.b;
    const byOk = !!by && typeof by === "object" && (by.kind === "person" || (by.kind === "team" && typeof by.who === "string" && typeof by.role === "string"));
    if (typeof v.s !== "string" || !STORE_ID.test(v.s) || typeof v.e !== "string" || !v.e || !byOk) return null;
    if (![v.a, v.d, v.f].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) || (v.a as number) >= (v.d as number)) return null;
    return { s: v.s, e: v.e, b: by as RightsBy, a: v.a as number, d: v.d as number, f: v.f as number };
  } catch {
    return null;
  }
}

/**
 * Writes down a deletion this month cannot pay for, to be done by the hourly job (lib/rights-queue.ts) by its
 * legal deadline. One a person a store: asked again while one waits, the one waiting is kept, with its own (earlier)
 * deadline, which is the one answered. `before`: commands to send first in the same pipeline (the fingerprint that
 * keeps the store from writing to them meanwhile). Null when it could not be written down: unknown, never "done".
 */
export async function scheduleRights(store: RightsStore, email: string, by: RightsBy, now: number, before: (string | number)[][] = []): Promise<{ deadline: number } | null> {
  if (!STORE_ID.test(store.sid) || !email || !isRedisConfigured()) return null;
  const id = itemId(store.sid, email);
  const deadline = legalDeadline(now);
  const item: RightsItem = { s: store.sid, e: email, b: by, a: now, d: deadline, f: 0 };
  // What scheduling writes is the company's: one record and one place a person and store, bounded by that.
  if (!(await takeCompanyPastCap(RIGHTS_SCHEDULE_UNITS, now))) return null;
  let reply: unknown;
  try {
    reply = await redisPipeline([
      ...before,
      ["SET", rightsItemKey(id), JSON.stringify(item), "NX", "EX", RIGHTS_ITEM_SECONDS],
      ["GET", rightsItemKey(id)],
      ["ZADD", RIGHTS_QUEUE, "NX", rightsDue(now, deadline), id],
    ]);
  } catch {
    return null;
  }
  const slots = repliesFor(reply, before.length + 3);
  if (!slots) return null;
  const kept = parseItem(slots[before.length + 1]);
  if (!kept || kept.s !== store.sid || kept.e !== email) return null;
  return { deadline: kept.d };
}

/** The ids of the waiting deletions due by `now`, the earliest first, at most `limit`. Null when the queue does not read. */
export async function dueRights(now: number, limit: number): Promise<string[] | null> {
  const reply = await redisPipeline([["ZRANGEBYSCORE", RIGHTS_QUEUE, "-inf", now, "LIMIT", 0, limit]]).catch(() => null);
  const slots = repliesFor(reply, 1);
  const ids = slots ? slots[0] : null;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && /^[0-9a-f]{40}$/.test(id))) return null;
  return ids as string[];
}

/** One waiting deletion; "gone" when its record is confirmed absent, null when it does not read. */
export async function readRightsItem(id: string): Promise<RightsItem | "gone" | null> {
  const reply = await redisPipeline([["GET", rightsItemKey(id)]]).catch(() => null);
  const slots = repliesFor(reply, 1);
  if (!slots) return null;
  if (slots[0] === null) return "gone";
  return parseItem(slots[0]);
}

/** Done: its record and its place go together. */
export async function finishRights(id: string): Promise<void> {
  await redisPipeline([["DEL", rightsItemKey(id)], ["ZREM", RIGHTS_QUEUE, id]]);
}

/**
 * Not done this time: looked at again at `at`, with how many times it was done past the cap so far. Its record keeps
 * the end it was written with (RIGHTS_ITEM_SECONDS from when it was asked), never a later one.
 */
export async function postponeRights(id: string, item: RightsItem, at: number, now: number): Promise<void> {
  const left = Math.ceil((item.a + RIGHTS_ITEM_SECONDS * 1000 - now) / 1000);
  if (left < 1) {
    // Only a deletion that kept failing reaches this, long past its deadline: said, never dropped quietly.
    console.error(`a scheduled deletion of a person is dropped, ${Math.round((now - item.d) / 86_400_000)} days past its deadline, still not done`);
    await finishRights(id);
    return;
  }
  await redisPipeline([
    ["SET", rightsItemKey(id), JSON.stringify(item), "XX", "EX", left],
    ["ZADD", RIGHTS_QUEUE, "XX", at, id],
  ]);
}

/** A record that is gone or does not read leaves the queue only when it is confirmed gone. */
export async function dropRightsPlace(id: string): Promise<void> {
  await redisPipeline([["ZREM", RIGHTS_QUEUE, id]]);
}
