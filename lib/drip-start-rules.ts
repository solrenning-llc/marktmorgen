/**
 * What a drip run spends before it reads one student's start (lib/learn.ts, sendDripEmails): the read the course
 * page makes (courseLedger), taken from the store's own monthly figure for these reads (dripMonthUnits, counted in
 * the store's allowance window by lib/drip-start.ts) before it is made, never from the store's public requests,
 * which its buyers' pages use. Priced in every plan's worst month (tests/plan-cost-registry.ts, COST_LINES
 * "drip-start-read"), with the share of the stores that pay nothing in nonPayingWorst; each read's worst is held
 * under its units at every size in tests/plan-cost-registry.test.ts (dripStartRead).
 */
import type { PlanFields } from "@/lib/plan-standing";
import type { Tier } from "@/lib/plan";
import { allowanceFor } from "@/lib/store-allowance-rules";

/**
 * Database commands one student's start read makes at the most, besides those sized by the store's courses: the
 * kept answer, the courses written down and brought over, a community's level and what it handed over, the answer
 * kept again, the mark let go, and a start moved (its row read, the early marks forgotten, the row written). A
 * review ceiling.
 */
export const DRIP_START_COMMANDS = 16;
/** Units the read takes at the least: the commands above and two calls to the creator's Stripe account, each with its page. */
export const DRIP_START_UNITS = 4;
/** Course products of the store each further unit covers: each one's listing read twice, whether the student was taken off it, and its entries in what is kept and written down. */
export const DRIP_START_COURSES_PER_UNIT = 6;

/** The units one student's start read takes, for a store of `courses` course products. */
export function dripStartUnits(courses: number): number {
  return DRIP_START_UNITS + (Number.isFinite(courses) && courses > 0 ? Math.ceil(courses / DRIP_START_COURSES_PER_UNIT) : 0);
}

/**
 * Units of the store's monthly start-read figure each of its monthly "email" figure gives: a one-course store's
 * read (dripStartUnits(1)), so in one window the job reads at most as many students of such a store as the store
 * may email in it, the figure its drip emails are themselves taken from (lib/email.ts, meter "email").
 */
export const DRIP_MONTH_UNITS_PER_STORE_EMAIL = 5;

/**
 * What the daily job may spend on one store's start reads in the store's allowance window (lib/allowance-window.ts:
 * its billing period, its trial, or the calendar month), in units: its "email" figure where it stands
 * (lib/store-allowance-rules.ts; none once its plan has ended, when no drip email can go). It does not come back
 * with each run: past it, the student's mark is let go, and the store's next window reads them.
 */
export function dripMonthUnits(store: PlanFields & { tier?: Tier }, nowSeconds: number): number {
  return allowanceFor(store, "email", nowSeconds) * DRIP_MONTH_UNITS_PER_STORE_EMAIL;
}
