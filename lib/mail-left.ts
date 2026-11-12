/**
 * What the email studio says when a month's list emails run low (357 [ES3], unit 1; added 12 November 2026): from
 * 80% of the month's emails used, how many are left and when the count starts again; at 100%, that they are used
 * up and when they start again. Read from the counts the studio already has (no other meter, no read of its own).
 * Unknown is said as nothing: no count, no allowance or no known date says no sentence, never a guessed one.
 * The way up to a larger plan stays where it is, offered only while one can be bought. Browser-safe.
 */

/** From this share of the month's emails used, the studio says how many are left. */
export const LOW_FROM_PERCENT = 80;

/** The sentence, or null when there is nothing true and worth saying. `renews` is a date, said as UTC. */
export function mailLeftWords(used: number, allowance: number, renews: string | null): string | null {
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(allowance) || allowance <= 0 || used < 0 || !renews) return null;
  const left = Math.max(0, allowance - used);
  if (left === 0) return `All of this month's emails are used. The count starts again on ${renews} (UTC).`;
  const percent = Math.floor((used * 100) / allowance);
  if (percent < LOW_FROM_PERCENT) return null;
  return `You have used ${percent}% of this month's emails: ${left.toLocaleString("en-US")} left until ${renews} (UTC).`;
}
