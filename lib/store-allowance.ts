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
import { LONGEST_WINDOW_DAYS, WINDOW_ID, type WindowFields, allowanceWindow, keepSecondsFor, opensAgainWords, resetWords, windowAt } from "@/lib/allowance-window";
import { poolPlace } from "@/lib/free-pool";
import { PLANS_ON_SALE } from "@/lib/opening";
import { standingOf } from "@/lib/plan-standing";
import { planAboveSold } from "@/lib/larger-plan";
import { poolFullWords } from "@/lib/free-pool-rules";
import type { Tier } from "@/lib/plan";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type AllowanceKind, KIND_WORDS, NON_PAYING_ALLOWANCES, allowanceFor, askedCeiling, usedWords } from "@/lib/store-allowance-rules";

export type AllowanceStore = WindowFields & { tier?: Tier; sid?: string; statsId?: string | null; handle?: string };

/**
 * What taking from a figure answered. A refusal for being used says, when
 * the count was read, how many were `left` before this asked (from the
 * figure's own count, never read again) and when they come back (`reset`).
 */
export type Taken = { ok: true; left: number } | { ok: false; reason: "used" | "unknown" | "pool"; limit: number; message: string; left?: number; reset?: string };

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
    const reset = resetWords(store, now, NON_PAYING_ALLOWANCES.ended[kind] === 0);
    return { ok: false, reason: "used", limit, message: usedWords(kind, limit, reset, standing, PLANS_ON_SALE, planAboveSold(store.tier ?? "creator")), left: Math.max(0, limit - (counted - n)), reset };
  } catch {
    return refuse("unknown", "This can't be counted right now. Try again in a minute.");
  }
}

/**
 * Counts `n` of a kind that was already used, past the figure if it must
 * (Claude 4, C4-20261106-1740/1810-C3: a read settled at what it really read,
 * lib/cart-link-products.ts). Never a way to use more: it is only the true
 * count of what was already spent, so the figure shows it and the next use is
 * refused as usual. true once Redis confirms the count, false when it is not
 * known.
 */
export async function forceAllowance(store: AllowanceStore, kind: AllowanceKind, n: number, now = Date.now()): Promise<boolean> {
  if (!Number.isSafeInteger(n) || n < 1) return false;
  const window = allowanceWindow(store, now);
  const id = idOf(store);
  if (!window || !id || !isRedisConfigured()) return false;
  try {
    const k = key(kind, id, window.id);
    const reply: unknown = await redisPipeline([
      ["SET", k, "0", "NX", "EX", keepSecondsFor(window, now)],
      ["INCRBY", k, n],
    ]);
    return acknowledgedAllowanceCount(reply, n) !== null;
  } catch {
    return false;
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

/** What holding for a later moment answered: the window it is held in, or why nothing was held. */
export type Held = { ok: true; window: string } | { ok: false; reason: "used" | "unknown" | "pool" | "ended"; message: string };

/**
 * Holds `n` of a kind for a use written down now and made at `atMs`
 * (lib/broadcasts.ts: a scheduled email's readings of its buyers), in the
 * window the store will be in then (windowAt): the window running now is
 * taken from as takeAllowance takes; a later one is counted in that window's
 * own figure, by the same key and the same two commands, so all that is held
 * for one month never passes that month's figure and the month's other uses
 * find it taken. Refused, nothing held, when that month is not one the plan
 * pays for as it stands (set to end before it, its period unknown) or it
 * would pass the figure, with the sentence to show.
 */
export async function holdAllowanceAt(store: AllowanceStore, kind: AllowanceKind, n: number, atMs: number, now = Date.now()): Promise<Held> {
  const unknown: Held = { ok: false, reason: "unknown", message: "This can't be counted right now. Try again in a minute." };
  if (!Number.isSafeInteger(n) || n < 1 || !Number.isFinite(atMs)) return unknown;
  const current = allowanceWindow(store, now);
  if (!current) return { ok: false, reason: "unknown", message: resetWords(store, now) };
  const target = atMs < current.end ? current : windowAt(store, atMs);
  if (!target || (target.id !== current.id && standingOf(store, atMs / 1000) !== "paid")) {
    const dayOf = (ms: number) => opensAgainWords({ ...current, end: ms }, now);
    // In a trial, the day it ends (what comes after is a month not paid for yet); a plan set to end, its last day.
    if (standingOf(store, now / 1000) === "trial") return { ok: false, reason: "ended", message: `Your trial ends on ${dayOf(store.trialEnds * 1000)} (UTC), so this can only be set for a day before then.` };
    const ends = store.period && !store.period.renews && store.subscriptionActive ? dayOf(store.period.end * 1000) : null;
    return { ok: false, reason: "ended", message: ends ? `Your plan ends on ${ends} (UTC), so this can only be set for a day before then.` : "This can only be set for a month your plan pays for." };
  }
  if (target.id === current.id) {
    const taken = await takeAllowance(store, kind, n, now);
    if (taken.ok) return { ok: true, window: current.id };
    // How many this needs and how many are left, when the count was read; otherwise the figure's own words.
    if (taken.reason === "used" && taken.left !== undefined) {
      const left = taken.left === 0 ? "none are left" : taken.left === 1 ? "only 1 is left" : `only ${taken.left.toLocaleString("en-US")} are left`;
      return { ok: false, reason: "used", message: `This needs ${n.toLocaleString("en-US")} of your ${KIND_WORDS[kind].many} this month, and ${left}.${taken.reset ? ` ${taken.reset}` : ""}` };
    }
    return { ok: false, reason: taken.reason, message: taken.message };
  }
  const limit = allowanceFor(store, kind, atMs / 1000);
  const id = idOf(store);
  if (!id || !isRedisConfigured()) return unknown;
  const from = opensAgainWords({ ...target, end: target.start }, now);
  if (!Number.isSafeInteger(limit) || limit < n) return { ok: false, reason: "used", message: `This needs ${n.toLocaleString("en-US")} of your ${KIND_WORDS[kind].many} in the month it is set for (from ${from}, UTC), more than that month has.` };
  try {
    const k = key(kind, id, target.id);
    const reply: unknown = await redisPipeline([
      ["SET", k, "0", "NX", "EX", keepSecondsFor(target, now)],
      ["INCRBY", k, n],
    ]);
    const counted = acknowledgedAllowanceCount(reply, n);
    if (counted === null) return unknown;
    if (counted <= limit) return { ok: true, window: target.id };
    await redisPipeline([["DECRBY", k, n]]).catch(() => {});
    const left = Math.max(0, limit - (counted - n));
    return { ok: false, reason: "used", message: `This needs ${n.toLocaleString("en-US")} of your ${KIND_WORDS[kind].many} in the month it is set for (from ${from}, UTC), and ${left === 0 ? "none are left" : left === 1 ? "only 1 is left" : `only ${left.toLocaleString("en-US")} are left`} for that month after what is already set aside in it. Choose another day.` };
  } catch {
    return unknown;
  }
}

/**
 * Gives back `n` of a kind held in the window named `window` (holdAllowanceAt)
 * that no use drew: a hold called off, or one whose moment came in another
 * window. Best effort: a give-back that fails leaves the figure counted
 * higher, never lower.
 */
export async function giveAllowanceIn(store: AllowanceStore, kind: AllowanceKind, n: number, window: string, now = Date.now()): Promise<void> {
  if (!Number.isSafeInteger(n) || n < 1 || !WINDOW_ID.test(window)) return;
  // A window long over has no counter left to give back to: one would be made, below zero and kept for ever.
  if (now > Date.parse(window.length === 7 ? `${window}-01T00:00:00Z` : `${window}T00:00:00Z`) + (LONGEST_WINDOW_DAYS + 1) * 86_400_000) return;
  const id = idOf(store);
  if (!id || !isRedisConfigured()) return;
  const k = key(kind, id, window);
  try {
    // Only a counter that is there: one gone (expired, erased) is not made again below zero, with no expiry.
    const [left] = await redisPipeline([["DECRBY", k, n]]);
    const after = Number(left);
    if (Number.isSafeInteger(after) && after < 0) await redisPipeline([["INCRBY", k, -after], ["EXPIRE", k, (LONGEST_WINDOW_DAYS + 1) * 86_400]]);
  } catch {
    // Best effort: counted higher, never lower.
  }
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
      // Only what INCRBY writes is a count: a confirmed none (null), its decimal text with no sign, space, point,
      // exponent, base prefix or leading zero, or the same whole number. Number() would read "", " ", "0x0", "0.0"
      // and "0e4" as 0, an unknown count taken for nothing used (Codex Z on #3169).
      if (raw !== null && typeof raw !== "number" && !(typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw))) return null;
      const n = raw === null ? 0 : Number(raw);
      if (!Number.isSafeInteger(n) || n < 0) return null;
      out.push({ kind, used: n, figure: allowanceFor(store, kind, now / 1000) });
    }
    return out;
  } catch {
    return null;
  }
}

/** The words a use of `kind` is refused with once the store's figure for it is used, as takeAllowance says them (lib/webhooks.ts, a message not kept). */
export function allowanceUsedWords(store: AllowanceStore, kind: AllowanceKind, now = Date.now()): string {
  return usedWords(kind, allowanceFor(store, kind, now / 1000), resetWords(store, now, NON_PAYING_ALLOWANCES.ended[kind] === 0), standingOf(store, now / 1000), PLANS_ON_SALE, planAboveSold(store.tier ?? "creator"));
}

/**
 * What has been taken of a kind in the store's window, read exactly (rule 24): null when it cannot be read (no
 * window, no Redis, a lost or malformed reply), 0 only for a count never taken. Every decision that spends (a model
 * call, an email) and every screen that says a figure reads this one, and a null is never room or "0 used".
 */
export async function allowanceUsedExact(store: AllowanceStore, kind: AllowanceKind, now = Date.now()): Promise<number | null> {
  return (await allowancesUsedStrict(store, [kind], now))?.[0]?.used ?? null;
}

/**
 * The same count with an unread one taken as 0. Kept only for the studio's main page (app/studio/page.tsx, held by
 * another agent's unit; its "0 of N used" when the count is unread is still to be changed there) and for tests that
 * measure what a call took. Never use it for a decision or a new screen: read allowanceUsedExact.
 */
export async function allowanceUsed(store: AllowanceStore, kind: AllowanceKind, now = Date.now()): Promise<number> {
  return (await allowanceUsedExact(store, kind, now)) ?? 0;
}
