/**
 * A goal for the month's money, and how far along it is (added 11 October
 * 2026). Baremetrics and Crazy Egg sell goals for the same reason a creator
 * sets one on paper: "$1,240 so far" says little, "$1,240 of $3,000, with
 * $88 a day needed for the 20 days left" says what today has to do.
 *
 * Counted on the store's money as the numbers count it: paid sales and the
 * renewals of memberships and plans, before Stripe's fee and any refund, in
 * the store's currency, by the calendar month in UTC. Pure, so the panel, the
 * emails and the tests read it the same way; kept by lib/sales-goal.ts.
 */
import { ledgerPaymentsComplete, type PaymentLedgerReading } from "@/lib/payment-ledger-coverage";
import type { ChannelDays } from "@/lib/stats";

/** Ten million in the store's currency: no month's goal a creator types is over it. */
export const MAX_GOAL_CENTS = 1_000_000_000;
/** A private sentinel: zero is confirmed no goal; this value means the saved goal was unreadable. */
export const UNKNOWN_SALES_GOAL_CENTS = -1;
export const GOAL_UNAVAILABLE_LINE = "Your saved goal could not be checked. Goal progress is unavailable. Try again later.";

/** A goal as typed: a whole number of cents above zero, at most MAX_GOAL_CENTS; 0 to have none. */
export function readGoal(raw: unknown): number | null {
  if (typeof raw !== "number" && (typeof raw !== "string" || !/^\d+$/.test(raw.trim()))) return null;
  const cents = Number(raw);
  if (!Number.isInteger(cents) || cents < 0 || cents > MAX_GOAL_CENTS) return null;
  return cents;
}

/** The store's money on each day, every channel together. */
export function moneyByDay(channelDays: ChannelDays | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const days of Object.values(channelDays ?? {})) {
    for (const [day, cents] of Object.entries(days)) out[day] = (out[day] ?? 0) + cents;
  }
  return out;
}

/** Unknown purchase or renewal amounts must not become goal progress, pace or achievement. */
export function goalMoneyByDay(data: PaymentLedgerReading): Record<string, number> | null {
  return ledgerPaymentsComplete(data) ? moneyByDay(data.channelDays) : null;
}

const daysIn = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

export type GoalProgress = {
  /** "2026-10". */
  month: string;
  goal: number;
  /** So far this month. */
  done: number;
  /** done / goal, not capped at 1. */
  share: number;
  /** Today's day of the month, and the month's length. */
  day: number;
  days: number;
  /** A day's money needed from tomorrow on to reach it, 0 once reached. */
  perDay: number;
  /** Where the month ends if every day left brings what the days so far did on average. */
  onPace: number;
  /** The day it was reached, or null. */
  reachedOn: string | null;
};

/** The month `today` is in, against a goal. Null with no goal. */
export function goalProgress(goal: number, byDay: Record<string, number>, today: string): GoalProgress | null {
  if (!Number.isSafeInteger(goal) || goal <= 0 || goal > MAX_GOAL_CENTS || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const month = today.slice(0, 7);
  const days = daysIn(month);
  const day = Number(today.slice(8, 10));
  let done = 0;
  let reachedOn: string | null = null;
  for (let d = 1; d <= day; d += 1) {
    const key = `${month}-${String(d).padStart(2, "0")}`;
    done += byDay[key] ?? 0;
    if (!reachedOn && done >= goal) reachedOn = key;
  }
  const left = days - day;
  return {
    month,
    goal,
    done,
    share: done / goal,
    day,
    days,
    perDay: done >= goal ? 0 : left > 0 ? Math.ceil((goal - done) / left) : goal - done,
    onPace: Math.round((done / day) * days),
    reachedOn,
  };
}

/** The month's name, "October 2026", from "2026-10". */
export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
