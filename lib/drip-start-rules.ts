/**
 * What a drip run counts before it reads one student's start (lib/learn.ts, sendDripEmails): the read the course
 * page makes (courseLedger), counted with the store's public requests before it is made, so a run never reads past
 * the store's window and never pays for a read the store's figures do not. Priced in tests/plan-cost-registry.ts
 * (dripStartRead) and held at every size in tests/plan-cost-registry.test.ts.
 */

/**
 * Database commands one student's start read makes at the most, besides those sized by the store's courses: the
 * kept answer, the courses written down and brought over, a community's level and what it handed over, the answer
 * kept again, the mark let go, and a start moved (its row read, the early marks forgotten, the row written). A
 * review ceiling.
 */
export const DRIP_START_COMMANDS = 16;
/** Public requests the read counts as at the least: the commands above and two calls to the creator's Stripe account, each with its page. */
export const DRIP_START_UNITS = 4;
/** Course products of the store each further request covers: each one's listing read twice, whether the student was taken off it, and its entries in what is kept and written down. */
export const DRIP_START_COURSES_PER_UNIT = 6;

/** The public requests one student's start read counts as, for a store of `courses` course products. */
export function dripStartUnits(courses: number): number {
  return DRIP_START_UNITS + (Number.isFinite(courses) && courses > 0 ? Math.ceil(courses / DRIP_START_COURSES_PER_UNIT) : 0);
}
