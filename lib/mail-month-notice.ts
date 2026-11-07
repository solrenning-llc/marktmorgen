/**
 * More sends at the moment they run out (357 [ES3], unit 1; added
 * 6 November 2026): the note in the email studio's "This month" card when a
 * store has sent 80% or more of the month's list emails.
 *
 * It says, in plain words, how many are left, when the count starts again,
 * and at 100% what stops (one-off emails, refused by lib/broadcasts.ts) and
 * what waits (sequence emails, held by lib/flows.ts until the month turns).
 * The only ways on it names are the ones that work today: the existing
 * "Need more?" move up to Scale, when the page offers it, and writing to a
 * smaller group. Scale is the largest plan and is never given an invented
 * one; email packs (344 [RN2]) are not on sale, so they are not named.
 *
 * Read from the numbers the page already has (the month's count and the
 * plan's allowance), so it adds no request. A count that could not be read
 * gives no note: the card says it is unknown instead (never 0, never a
 * percentage). A store without list email (Store) has its own card.
 *
 * Browser-safe: a pure function.
 */

export type MailMonthFacts = {
  /** List emails sent in this window, or null when the count could not be read. */
  used: number | null;
  /** The window's list emails (lib/mail.ts monthlyAllowance); 0 for a plan without list email. */
  allowance: number;
  /** "December 4 (UTC)": the day the window ends, or null when the window is not known. */
  reset: string | null;
  /** Whether the window follows a payment (a billing month) rather than the calendar. */
  billing: boolean;
  /** In the free trial, the whole trial is one window. */
  trial: boolean;
  /** On the largest plan (Scale): no plan holds more. */
  biggest: boolean;
  /** The move up the page already offers beside the count, or null. */
  moveUp: { emails: number } | null;
};

export type MailMonthNotice = { level: "near" | "out"; title: string; lines: string[] };

const n = (value: number) => value.toLocaleString("en-US");
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The note for this month, or null below 80% or when the numbers are not counts. */
export function mailMonthNotice(facts: MailMonthFacts): MailMonthNotice | null {
  const { used, allowance } = facts;
  if (!count(allowance) || allowance === 0 || !count(used)) return null;
  // 80% in whole numbers: used / allowance >= 4 / 5.
  if (used * 5 < allowance * 4) return null;
  const left = Math.max(0, allowance - used);

  const when = facts.reset === null
    ? "The day the count starts again could not be read just now."
    : facts.trial
      ? `The free trial's emails are counted for the whole trial, which ends on ${facts.reset}.`
      : facts.billing
        ? `The count starts again with your next billing month, on ${facts.reset}.`
        : `The count starts again on ${facts.reset}.`;
  const moveUp = facts.moveUp && count(facts.moveUp.emails) && facts.moveUp.emails > allowance
    ? `Scale holds up to ${n(facts.moveUp.emails)} emails a month. "Need more?" below shows its price and moves you up.`
    : null;
  const largest = facts.biggest && !facts.trial;

  if (left === 0) {
    return {
      level: "out",
      title: facts.trial ? "The free trial's emails are used up" : "This month's emails are used up",
      lines: [
        facts.trial
          ? "One-off emails can't go out now. Sequence emails wait until there are emails again."
          : "One-off emails can't go out until the count starts again. Sequence emails wait and go out once it does.",
        when,
        ...(moveUp ? [moveUp] : largest ? ["Scale is the largest plan, so no plan holds more emails."] : []),
      ],
    };
  }

  return {
    level: "near",
    title: `${n(left)} ${left === 1 ? "email is" : "emails are"} left ${facts.trial ? "in the free trial" : "this month"}`,
    lines: [
      `You have sent ${n(used)} of ${facts.trial ? "the free trial's" : "this month's"} ${n(allowance)} emails to your list, one-off and sequences together.`,
      when,
      moveUp ?? (largest ? "Scale is the largest plan. To make the rest last, write to a smaller group of your list." : "To make the rest last, write to a smaller group of your list."),
    ],
  };
}
