/**
 * When a workflow step that has to wait is tried again, and when a run stops
 * waiting (added 18 October 2026, ClickFunnels audit row F23).
 *
 * A wait whose end is known is tried once, at that end: the month's emails
 * at the turn of the store's allowance window, the company's daily room at
 * the next UTC day, a pause on the store's email at the pause's end.
 * A store switched off after notices about its content (lib/takedown.ts) is
 * tried again a day later, each time.
 * Anything else (the sender's ceiling, a portion of a new list, a read that
 * did not answer, the deals board) is tried again after a delay that grows
 * threefold each time: 10 minutes, 30, 90, 4.5 hours, 13.5, then a day.
 *
 * Every wait is counted on the run (lib/flow-runs.ts, countWaits), and a run
 * stops once it would wait more than MAX_WAITS_PER_RUN times, or one step has
 * waited more than MAX_WAIT_DAYS_PER_STEP days (lib/flow-limits.ts). It stops
 * with nothing done at that step, and its history says why. A count that
 * cannot be read stops it too: an unknown count is not room for one more.
 *
 * Pure and browser-safe.
 */
import { MAX_WAIT_DAYS_PER_STEP, MAX_WAITS_PER_RUN } from "@/lib/flow-limits";

/** Why a step waits. */
export type WaitReason = "allowance" | "day" | "paused" | "sender" | "portion" | "retry" | "board" | "email_off" | "switched_off";

export const FIRST_DELAY_SECONDS = 600;
export const LONGEST_DELAY_SECONDS = 86_400;
/** A known end is tried a minute after it, so the new window is surely open. */
const AFTER_END_SECONDS = 60;

/** The delay before the `n`th try of a wait without a known end (n counts from 1). */
export function backoffSeconds(n: number): number {
  const k = Math.max(1, Math.min(30, Math.floor(n)));
  return Math.min(LONGEST_DELAY_SECONDS, FIRST_DELAY_SECONDS * 3 ** (k - 1));
}

/**
 * When to try a waiting step again, in seconds. `n` is this wait's number in
 * the run (1 for the first). `windowEnd` and `pauseUntil` are in seconds,
 * when known.
 */
export function nextTry(reason: WaitReason, n: number, nowSeconds: number, known: { windowEnd?: number | null; pauseUntil?: number | null } = {}): number {
  const soonest = nowSeconds + FIRST_DELAY_SECONDS;
  if (reason === "allowance" && known.windowEnd && known.windowEnd > nowSeconds) return Math.max(soonest, known.windowEnd + AFTER_END_SECONDS);
  if (reason === "paused" && known.pauseUntil && known.pauseUntil > nowSeconds) return Math.max(soonest, known.pauseUntil + AFTER_END_SECONDS);
  if (reason === "switched_off") return nowSeconds + LONGEST_DELAY_SECONDS;
  if (reason === "day") return Math.max(soonest, (Math.floor(nowSeconds / 86_400) + 1) * 86_400 + 5 * AFTER_END_SECONDS);
  const delay = backoffSeconds(n);
  return nowSeconds + (reason === "portion" ? Math.max(900, delay) : delay);
}

export type WaitCount = { waits: number; since: number } | null;

/** Why this wait stops the run, or null when it may wait again. A count that is not known stops it. */
export function stopWaiting(count: WaitCount, nowSeconds: number): string | null {
  if (!count) return "Stopped here: how often this run had waited could not be confirmed, so nothing more is tried. Nothing was done at this step.";
  if (count.waits > MAX_WAITS_PER_RUN) return `Stopped here: this run had already waited ${MAX_WAITS_PER_RUN} times, the most one run may. Nothing was done at this step.`;
  if (nowSeconds - count.since > MAX_WAIT_DAYS_PER_STEP * 86_400) return `Stopped here: this step had waited more than ${MAX_WAIT_DAYS_PER_STEP} days. Nothing was done at this step.`;
  return null;
}
