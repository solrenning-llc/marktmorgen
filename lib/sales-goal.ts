/**
 * Where the month's goal is kept (lib/sales-goal-rules.ts says what it means):
 * one figure for the store, in its currency's smallest unit, used for every
 * month from the one it was set in until it is changed. Kept with that month
 * and the currency it was typed in, so a month that ended before the goal was
 * set is never measured against it, and a store that changes its currency is
 * not shown $3,000 as ¥3,000.
 *
 *   nl:goal:<statsId>   JSON { cents, currency, since: "2026-10" }
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { readGoal } from "@/lib/sales-goal-rules";

const key = (statsId: string) => `nl:goal:${statsId}`;
const MONTH = /^\d{4}-\d{2}$/;

export type SalesGoal = { cents: number; since: string };
const NONE: SalesGoal = { cents: 0, since: "" };

/** The goal as kept, in the store's currency; none when it was set in another. */
export function parseSalesGoal(raw: unknown, currency: string): SalesGoal {
  if (typeof raw !== "string" || !raw) return NONE;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const cents = readGoal(value.cents);
    if (!cents || value.currency !== currency || typeof value.since !== "string" || !MONTH.test(value.since)) return NONE;
    return { cents, since: value.since };
  } catch {
    return NONE;
  }
}

export async function readSalesGoal(statsId: string | null, currency: string): Promise<SalesGoal> {
  if (!statsId || !isRedisConfigured()) return NONE;
  const [raw] = await redisPipeline([["GET", key(statsId)]]);
  return parseSalesGoal(raw, currency);
}

/** Sets the goal from this month on, or takes it away with 0. Null when the figure is not one a goal can be. */
export async function setSalesGoal(statsId: string, raw: unknown, currency: string, now = Date.now()): Promise<number | null> {
  const cents = readGoal(raw);
  if (cents === null || !isRedisConfigured()) return null;
  const since = new Date(now).toISOString().slice(0, 7);
  const reply = await redisPipeline([cents ? ["SET", key(statsId), JSON.stringify({ cents, currency, since })] : ["DEL", key(statsId)]]);
  if (!Array.isArray(reply) || reply.length !== 1 || (cents ? reply[0] !== "OK" : reply[0] !== 0 && reply[0] !== 1)) throw new Error("Goal update could not be confirmed");
  return cents;
}

/** The goal a month is measured against: only one set in that month or before it. */
export function goalForMonth(goal: SalesGoal, month: string): number {
  return goal.cents && goal.since && goal.since <= month ? goal.cents : 0;
}
