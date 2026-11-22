/**
 * What the email studio says when a month's list emails run low (357 [ES3], unit 1; added 12 November 2026): from
 * 80% of the month's emails used, how many are left; at 100%, that they are used up. The day the count starts again
 * is said only when it truly does: a paid plan that renews, on its billing month (`renews`, worked out by the page).
 * A plan set to end, a trial and a month that cannot be read say no day, never one that would not come. In a trial
 * the number left is "up to", because a trial's sending also waits on a free place (admitNonPaying).
 * Read from the counts the studio already has (no other meter, no read of its own). Unknown counts say nothing.
 * The way up to a larger plan stays where it is, offered only while one can be bought. Browser-safe.
 */

/** From this share of the month's emails used, the studio says how many are left. */
export const LOW_FROM_PERCENT = 80;

/** The sentence, or null when there is nothing true and worth saying. `renews` is the day the count starts again (UTC), or null. */
export function mailLeftWords(used: number, allowance: number, renews: string | null, trial = false): string | null {
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(allowance) || allowance <= 0 || used < 0) return null;
  const left = Math.max(0, allowance - used);
  const whose = trial ? "the trial's emails" : "this month's emails";
  if (left === 0) return renews && !trial ? `All of ${whose} are used. The count starts again on ${renews} (UTC).` : `All of ${whose} are used.`;
  const percent = Math.floor((used * 100) / allowance);
  if (percent < LOW_FROM_PERCENT) return null;
  const count = left.toLocaleString("en-US");
  if (trial) return `You have used ${percent}% of ${whose}: up to ${count} left.`;
  return renews ? `You have used ${percent}% of ${whose}: ${count} left until ${renews} (UTC).` : `You have used ${percent}% of ${whose}: ${count} left.`;
}
