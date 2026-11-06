/**
 * A plain sentence beside a plan's monthly email number (459 [EL3]): what the
 * number is enough for, worked out here from the number itself, never typed.
 *
 * "7,000 emails a month" asks the creator to do arithmetic they should not
 * have to. The question behind it is "how big a list can I write to every
 * week?", so that is what the sentence answers. A month holds at most five of
 * any weekday (29 to 31 days), so a weekly email goes out at most five times
 * in a month, and the list size is the allowance divided by five, rounded
 * down: the promise holds in every month, the longest included.
 *
 * Everything a store sends to people counts against the same allowance:
 * one-off emails, sequences, announcements, imports' welcome emails, review
 * requests, win-back and offer emails, product updates and waitlist notices.
 * So the sentence says "as many as": it is the most the allowance holds on
 * its own, not a promise beside everything else the store sends.
 *
 * Not shown in the free trial: the trial is one window of TRIAL_DAYS, not a
 * month, and its emails come from a shared pool that can be spent
 * (lib/free-pool.ts), so no weekly figure can be promised for it.
 *
 * Pure, so the studio's client components can use it.
 */

/** The most times one weekday comes round in a month: a weekly email's worst month. */
export const WEEKLY_SENDS_IN_LONGEST_MONTH = 5;

/** How many people a monthly allowance reaches with one email a week, in every month. */
export function weeklyReach(monthlyEmails: number): number {
  if (!Number.isFinite(monthlyEmails) || monthlyEmails <= 0) return 0;
  return Math.floor(monthlyEmails / WEEKLY_SENDS_IN_LONGEST_MONTH);
}

/** The same, short, for a plan card: "one a week to as many as 1,400 people". Empty when there are no emails. */
export function weeklyReachShort(monthlyEmails: number): string {
  const people = weeklyReach(monthlyEmails);
  if (people <= 0) return "";
  return `one a week to as many as ${people === 1 ? "1 person" : `${people.toLocaleString("en-US")} people`}`;
}

/** The sentence, e.g. "That is one email a week to as many as 1,400 people, in any month." Empty when there are no emails. */
export function emailEquivalence(monthlyEmails: number): string {
  const people = weeklyReach(monthlyEmails);
  if (people <= 0) return "";
  const who = people === 1 ? "1 person" : `${people.toLocaleString("en-US")} people`;
  return `That is one email a week to as many as ${who}, in any month.`;
}
