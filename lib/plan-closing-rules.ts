/**
 * A store whose plan has ended, and what it still keeps: the days.
 *
 * lib/plan-closing.ts says what is done and why. These are the figures it
 * is done by, kept apart from it so that the pages that publish them read
 * the same ones the job runs on without bringing the job with them. They
 * are imported by client pages too, so nothing here reaches the server's
 * own modules.
 */
import { SETUP_STORAGE_BYTES } from "@/lib/plan-standing";

/**
 * Days from the end of a plan to the day what the store keeps is removed.
 *
 * Long enough for three notices, the last two two weeks and a week before
 * the day, and short enough that a store which paid for a single month, ran
 * every limit of its plan in it and then left all it may keep here until
 * this day has still not cost more than that month brought in, on the
 * smallest plan's price (tests/plan-margin.test.ts).
 *
 * Thirty since October 12, 2026: it was sixty, and at sixty that store cost
 * more than the $22 the smallest plan was set at (lib/plan.ts).
 */
export const CLOSING_DAYS = 30;
/** How long before that day the second and the last notice go out. */
export const WARN_MONTH_DAYS = 14;
export const WARN_WEEK_DAYS = 7;
/** A store found to fit is measured again after this many days, and not before. */
export const RECHECK_DAYS = 7;

/**
 * Plans that end on or after this day (18 October 2026, UTC) keep none of
 * their files past their closing day: the three notices, the week after the
 * last and the check with Stripe are the same, and they apply to all of
 * what the store keeps, files, lesson videos, podcast episodes, students'
 * hand-ins and community pictures. Until this day a store whose plan ended
 * kept the room of a store with no plan (SETUP_STORAGE_BYTES) with no date
 * on it, for as long as it liked: storage nobody paid for, for ever, which
 * no plan's price could cover (tests/plan-cost-registry.ts, retained-files).
 * A plan that ended before this day keeps what it was told it would.
 */
export const KEEP_NOTHING_FROM = Date.UTC(2026, 9, 18);

/** What a store whose plan ended at `endedAtMs` may keep with no date on it. */
export function keptRoomFor(endedAtMs: number): number {
  return Number.isFinite(endedAtMs) && endedAtMs < KEEP_NOTHING_FROM ? SETUP_STORAGE_BYTES : 0;
}

/**
 * Whether a plan that ended at `endedAtMs` closes the whole store on its
 * closing day (since 18 October 2026, the same day as KEEP_NOTHING_FROM):
 * its files that day, and its records in the database within
 * ERASE_WITHIN_DAYS after it (lib/closed-store-data.ts). Nothing of its
 * sales is kept: they are on its owner's own Stripe account, and the
 * company's own records of the store are its invoices and fees, on the
 * company's Stripe account (docs/tax-uncertainty.md, question 13). Every
 * such store has the three notices and the closing day, whether it keeps
 * any file or not. A plan that ended before keeps the rule it ended under,
 * and its records stay.
 */
export function closesStore(endedAtMs: number): boolean {
  return Number.isFinite(endedAtMs) && endedAtMs >= KEEP_NOTHING_FROM;
}

/**
 * The most days after the closing day before a closed store's records are
 * gone from the database. The deletion walks the whole database once for
 * every store that came due since the last walk (lib/closed-store-data.ts),
 * and a walk starts at most every ERASE_EVERY_DAYS, so what a walk costs is
 * paid a few times a month at the most, however many stores close.
 */
export const ERASE_EVERY_DAYS = 7;
/** A walk that has not reached the end of the database by then is finished on the next runs; the database is read a part a run. */
export const ERASE_WITHIN_DAYS = ERASE_EVERY_DAYS + 7;

/**
 * How the deletion of a closing store's records is done, which is what it
 * costs (lib/closed-store-data.ts; tests/plan-cost-registry.ts, closure):
 * keys deleted DEL_BATCH at a command, about half a megabyte of names,
 * well inside what one request may carry; keys a follower reads FOLLOW_BATCH
 * at a command; renewals stopped at Stripe RENEWALS_AT_ONCE at a time, well
 * under what Stripe takes in a second from one account.
 */
export const DEL_BATCH = 4000;
export const FOLLOW_BATCH = 1000;
/**
 * The most pages of a closing store's host's claims (HSCAN, 500 asked for a page) one walk's preparation reads
 * (lib/closed-store-data.ts, clearClaims); claims not at their end by then are never all of them: the store waits a
 * walk and the next goes on from where this one stopped (Claude 4 on #3660). A host's claims are times that never
 * overlap (lib/host-claims.ts, CLAIM_HOST_TIMES refuses one within the gap of another), of 15 minutes at the least
 * (CALL_LENGTHS), from two days past to the call's horizon (90 days at the most, HORIZON_CHOICES): under 9,000, fewer
 * than 18 pages, so one walk is enough. Not a proof (a paid claim is written whatever is there, confirmClaim, and
 * COUNT is only a hint to Redis): past it, each further walk reads CLAIM_PAGES more pages a host, at the same cost.
 */
export const CLAIM_PAGES = 50;
/** How long where a closing store's preparation stopped in its hosts' claims is kept between walks (clearClaims). */
export const CLAIMS_LEFT_DAYS = ERASE_WITHIN_DAYS;
export const RENEWALS_AT_ONCE = 25;

/**
 * Whole exports a store's owner may take once its plan has ended, before it
 * closes (app/api/store/export, what=store): the store's own, counted for
 * that ending, never taken from a studio figure or the share of stores that
 * pay nothing, so taking one's data away is never refused for want of room.
 * Each is priced at the largest store there can be, with the rest of its
 * closing, once for each store against its own payments
 * (tests/plan-cost-registry.ts, closure). While a plan runs, an export is
 * taken from the store's studio figure at its size (lib/store-export.ts).
 */
export const ENDED_STORE_EXPORTS = 1;
