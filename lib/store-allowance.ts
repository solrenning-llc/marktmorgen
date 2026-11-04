/**
 * Taking from a store's monthly figures for what had none until 17 October
 * 2026 (lib/store-allowance-rules.ts): studio requests, API requests, inbox
 * messages, store emails, access emails and calls to connected services.
 *
 *   nl:allow:<kind>:<store>:<window>   what was taken in the store's window
 *
 * Taken before the cost is incurred, all or nothing: what does not fit is
 * refused and nothing is kept for it. A store that pays nothing must also
 * hold one of the month's places (lib/free-pool.ts). Unknown is closed: no
 * window (a paying store whose period is not known), no place, or a count
 * that cannot be made, and nothing is taken and the use is refused.
 */
import { createHash } from "node:crypto";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { type WindowFields, allowanceWindow, keepSecondsFor, resetWords } from "@/lib/allowance-window";
import { poolPlace } from "@/lib/free-pool";
import { PLANS_ON_SALE } from "@/lib/opening";
import { standingOf } from "@/lib/plan-standing";
import { planAboveSold } from "@/lib/larger-plan";
import { poolFullWords } from "@/lib/free-pool-rules";
import type { Tier } from "@/lib/plan";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type AllowanceKind, NON_PAYING_ALLOWANCES, allowanceFor, askedCeiling, usedWords } from "@/lib/store-allowance-rules";

export type AllowanceStore = WindowFields & { tier?: Tier; sid?: string; statsId?: string | null; handle?: string };

export type Taken = { ok: true; left: number } | { ok: false; reason: "used" | "unknown" | "pool"; limit: number; message: string };

const key = (kind: AllowanceKind, id: string, window: string) => `nl:allow:${kind}:${id}:${window}`;

/** What a store is counted by: its id, or what it is kept under, hashed. */
function idOf(store: AllowanceStore): string | null {
  const raw = store.sid || store.statsId || store.handle || "";
  return raw ? createHash("sha256").update(`allowance:${raw}`).digest("hex").slice(0, 32) : null;
}


/**
 * The words for a page's "allowance-<reason>" code (lib/metered-limits.ts, serviceRefusalCode): the store's calls
 * to connected services used, in its own window; no place this month; or not counted just now. Null for any other code.
 */
export function serviceAllowanceWords(store: AllowanceStore, code: string, now = Date.now()): string | null {
  if (code === "allowance-pool") return poolFullWords(PLANS_ON_SALE);
  if (code === "allowance-unknown") return "This can't be counted right now. Try again in a minute.";
  if (code !== "allowance-used") return null;
  return usedWords("integration", allowanceFor(store, "integration", now / 1000), resetWords(store, now, NON_PAYING_ALLOWANCES.ended.integration === 0), standingOf(store, now / 1000), PLANS_ON_SALE, planAboveSold(store.tier ?? "creator"));
}

/**
 * Takes `n` of a kind from the store's window, or refuses with the sentence to
 * show. `asked`: a confirmation to an address a visitor typed, which may take
 * the figure only to askedCeiling of it, so the rest is kept for the buyers it
 * is for (lib/store-allowance-rules.ts, ASKED_SHARE_BPS). It is counted in the
 * same figure, by the same two commands.
 */
export async function takeAllowance(store: AllowanceStore, kind: AllowanceKind, n = 1, now = Date.now(), asked = false): Promise<Taken> {
  const whole = allowanceFor(store, kind, now / 1000);
  const limit = asked ? askedCeiling(whole) : whole;
  const refuse = (reason: "used" | "unknown" | "pool", message: string): Taken => ({ ok: false, reason, limit, message });
  if (!Number.isSafeInteger(n) || n < 1) return refuse("unknown", "That could not be counted. Try again.");
  const window = allowanceWindow(store, now);
  if (!window) return refuse("unknown", resetWords(store, now));
  const standing = standingOf(store, now / 1000);
  if (!Number.isSafeInteger(limit) || limit < n) return refuse("used", usedWords(kind, limit, resetWords(store, now, NON_PAYING_ALLOWANCES.ended[kind] === 0), standing, PLANS_ON_SALE, planAboveSold(store.tier ?? "creator")));
  const id = idOf(store);
  if (!id || !isRedisConfigured()) return refuse("unknown", "This can't be counted right now. Try again in a minute.");
  // Each outbound webhook attempt creates provider work and needs its paid cohort.
  // General API/studio authorization also admits removal and disconnection:
  // their operation-specific guards must retain that distinction.
  if (kind === "webhook" && store.period?.funded === true && (!store.tier || !(await reservePaidResourceWindow({ ...store, tier: store.tier, statsId: store.statsId ?? null })))) {
    return refuse("unknown", "This can't be counted right now. Try again in a minute.");
  }
  // No place this month, or none could be counted: each is said as it is.
  const place = await poolPlace(store, now);
  if (place === "full") return refuse("pool", poolFullWords(PLANS_ON_SALE));
  if (place === "unknown") return refuse("unknown", "This can't be counted right now. Try again in a minute.");
  try {
    const k = key(kind, id, window.id);
    const reply: unknown = await redisPipeline([
      ["SET", k, "0", "NX", "EX", keepSecondsFor(window, now)],
      ["INCRBY", k, n],
    ]);
    // A committed increment with a lost or malformed reply remains consumed.
    // Never coerce unknown evidence, inspect getters, retry or read it back.
    const counted = acknowledgedAllowanceCount(reply, n);
    if (counted === null) return refuse("unknown", "This can't be counted right now. Try again in a minute.");
    if (counted <= limit) return { ok: true, left: limit - counted };
    // Over: what this asked for is given back, so a refused use costs the figure nothing.
    await redisPipeline([["DECRBY", k, n]]).catch(() => {});
    return refuse("used", usedWords(kind, limit, resetWords(store, now, NON_PAYING_ALLOWANCES.ended[kind] === 0), standing, PLANS_ON_SALE, planAboveSold(store.tier ?? "creator")));
  } catch {
    return refuse("unknown", "This can't be counted right now. Try again in a minute.");
  }
}

/**
 * Gives back `n` of a kind that this same use took at `now` and did not need
 * (lib/api-guard.ts, holdMoreApi: a reading set aside at its most, then
 * measured). Only ever what was taken a moment before, in the same window;
 * best effort: a give-back that fails leaves the figure counted higher, never
 * lower.
 */
export async function giveAllowance(store: AllowanceStore, kind: AllowanceKind, n: number, now = Date.now()): Promise<void> {
  if (!Number.isSafeInteger(n) || n < 1) return;
  const window = allowanceWindow(store, now);
  const id = idOf(store);
  if (!window || !id || !isRedisConfigured()) return;
  await redisPipeline([["DECRBY", key(kind, id, window.id), n]]).catch(() => {});
}

/** Fixed-size own-data reply from the existing SET NX + INCRBY pipeline. */
function acknowledgedAllowanceCount(reply: unknown, n: number): number | null {
 try {
  if (!Array.isArray(reply) || Object.getOwnPropertySymbols(reply).length) return null;
  const length = Object.getOwnPropertyDescriptor(reply, "length");
  if (!length || !Object.hasOwn(length, "value") || length.value !== 2) return null;
  if (Object.getOwnPropertyNames(reply).length !== 3) return null;
  const set = Object.getOwnPropertyDescriptor(reply, "0"), count = Object.getOwnPropertyDescriptor(reply, "1");
  if (!set || !Object.hasOwn(set, "value") || (set.value !== null && set.value !== "OK") ||
      !count || !Object.hasOwn(count, "value") || !Number.isSafeInteger(count.value) || count.value < n) return null;
  return count.value;
 } catch { return null; }
}

/**
 * What has been taken of every kind in the store's window, read strictly for
 * the studio's checkup (491 [PP2]): one read for all of them, and null when
 * the window or any count could not be read, so a missing answer is never
 * taken for nothing used. Each figure is the store's own, beside its count.
 */
export async function allowancesUsedStrict(store: AllowanceStore, kinds: readonly AllowanceKind[], now = Date.now()): Promise<{ kind: AllowanceKind; used: number; figure: number }[] | null> {
  const window = allowanceWindow(store, now);
  const id = idOf(store);
  if (!window || !id || !isRedisConfigured() || !kinds.length) return null;
  try {
    const reply: unknown = await redisPipeline(kinds.map((kind) => ["GET", key(kind, id, window.id)]));
    if (!Array.isArray(reply) || reply.length !== kinds.length) return null;
    const out: { kind: AllowanceKind; used: number; figure: number }[] = [];
    for (const [i, kind] of kinds.entries()) {
      const raw: unknown = reply[i];
      if (raw !== null && typeof raw !== "string" && typeof raw !== "number") return null;
      const n = raw === null ? 0 : Number(raw);
      if (!Number.isSafeInteger(n) || n < 0) return null;
      out.push({ kind, used: n, figure: allowanceFor(store, kind, now / 1000) });
    }
    return out;
  } catch {
    return null;
  }
}

/** What has been taken of a kind in the store's window, for the studio; 0 when it cannot be read. */
export async function allowanceUsed(store: AllowanceStore, kind: AllowanceKind, now = Date.now()): Promise<number> {
  const window = allowanceWindow(store, now);
  const id = idOf(store);
  if (!window || !id || !isRedisConfigured()) return 0;
  try {
    const [raw] = await redisPipeline([["GET", key(kind, id, window.id)]]);
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
