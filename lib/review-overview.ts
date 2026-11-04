/**
 * Reviews by month, for the creator (636 [GL4](c); owner's HighLevel audit):
 * how many came in each of the last twelve months and their average. Pure;
 * lib/reviews.ts reviewsSince reads them.
 *
 * Every star counts alike: a one-star review is in the count and the average
 * like a five (16 CFR Part 465 forbids suppressing reviews by rating, and the
 * creator should see the same truth the buyers do). As on the product's page
 * (lib/review-summary.ts), a review whose purchase was refunded in full is
 * left out of the stars and counted apart; a hidden one still counts.
 */
import type { Review } from "@/lib/review-summary";

export const OVERVIEW_MONTHS = 12;

export type MonthRow = {
  /** "2026-11", in UTC. */
  month: string;
  /** "November 2026". */
  label: string;
  /** Reviews whose stars count. */
  count: number;
  stars: number;
  /** Reviews whose purchase was refunded in full: shown, not averaged. */
  refunded: number;
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The first moment (milliseconds, UTC) of the month `back` months before the one `now` is in. */
export function monthStart(now: number, back: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1);
}

/** The last twelve months, newest first, with their reviews counted. Reviews outside them are ignored. */
export function byMonth(reviews: Pick<Review, "createdAt" | "rating" | "refunded">[], now: number): MonthRow[] {
  const rows: MonthRow[] = [];
  for (let back = 0; back < OVERVIEW_MONTHS; back += 1) {
    const start = new Date(monthStart(now, back));
    const month = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
    rows.push({ month, label: `${MONTH_NAMES[start.getUTCMonth()]} ${start.getUTCFullYear()}`, count: 0, stars: 0, refunded: 0 });
  }
  const index = new Map(rows.map((row, i) => [row.month, i]));
  for (const review of reviews) {
    const d = new Date(review.createdAt);
    const row = rows[index.get(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`) ?? -1];
    if (!row || review.createdAt > now) continue;
    if (review.refunded) row.refunded += 1;
    else {
      row.count += 1;
      row.stars += review.rating;
    }
  }
  return rows;
}

/** The month's average to one decimal, as the product page prints one, or null with no counted review. */
export function monthAverage(row: MonthRow): number | null {
  return row.count ? Math.round((row.stars / row.count) * 10) / 10 : null;
}
