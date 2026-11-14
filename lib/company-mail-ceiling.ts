import { essentialLimitState, type LimitState } from "@/lib/request-guard";

/**
 * A ceiling for the whole company on the emails a stranger can ask us to
 * send (MR rule, 27 October 2026: every spend has an automatic ceiling
 * before it happens). These emails are paid by the company (lib/email.ts,
 * meter "company"), and the address is typed by whoever asks: the limits per
 * connection and per address bound one machine and one inbox, but machines
 * and addresses that change bound nothing on their own. So each queue counts
 * every ask in the UTC hour, whoever asks and whatever the address, before
 * anything about the address is read or any email is sent; past its ceiling
 * nothing is sent and the person is told plainly to try again in an hour.
 *
 * Counted by the hour, not the day, so "try again in an hour" is true, and
 * a flood early in the day cannot shut the door until midnight.
 *
 * The figures, at PER_EMAIL ($0.0009 an email, tests/plan-cost-registry.ts,
 * the dearer provider's price) plus the request around it:
 *
 *   SIGN_IN_LINKS_PER_HOUR      100 links an hour, 2,400 a day: about $2.16
 *                               a day, $67 a month at the most. Twenty times
 *                               a busy hour of real logins before launch.
 *   LOST_EMAIL_LINKS_PER_HOUR    20 asks an hour; an ask with a recovery
 *                               address sends two emails, so 40 emails, 960 a
 *                               day: about $0.86 a day at the most. Losing an
 *                               inbox is rare; twenty an hour is far above it.
 *   ERASE_LINKS_PER_HOUR         20 asks an hour, one email each: 480 a day,
 *                               about $0.43 a day at the most. A deletion
 *                               asked for is rare; twenty an hour is far above it.
 *
 * Together at most about $3.45 a day, $107 a 31-day month, a company exposure
 * under MR item 2 (docs/funded-exposure-review.md), never a plan's cost.
 */
export const SIGN_IN_LINKS_PER_HOUR = 100;
export const LOST_EMAIL_LINKS_PER_HOUR = 20;
export const ERASE_LINKS_PER_HOUR = 20;

/** What the person is told past a ceiling: true for any address, so it says nothing about who has an account. */
export const COMPANY_MAIL_BUSY = "We couldn't send the email right now. Try again in an hour.";

export type CompanyMailQueue = "sign-in" | "lost-email" | "erase";

/** The UTC hour a count belongs to; kept two hours, so an hour's count is gone well after it ends. */
const hourOf = (now: number) => String(Math.floor(now / 3_600_000));
const KEEP_SECONDS = 2 * 3_600;

/**
 * Takes one ask from the queue's hour, before anything is read or sent:
 * "within" may send, "exceeded" sends nothing and says so, "unknown" (a
 * count that cannot be read) sends nothing and is our side's trouble.
 */
export async function companyMailRoom(queue: CompanyMailQueue, now = Date.now()): Promise<LimitState> {
  const hour = hourOf(now);
  // One literal scope a queue, so tests/plan-cost-registry.ts classifies each.
  switch (queue) {
    case "sign-in":
      return essentialLimitState("company-mail-sign-in", hour, SIGN_IN_LINKS_PER_HOUR, KEEP_SECONDS);
    case "lost-email":
      return essentialLimitState("company-mail-lost-email", hour, LOST_EMAIL_LINKS_PER_HOUR, KEEP_SECONDS);
    case "erase":
      return essentialLimitState("company-mail-erase", hour, ERASE_LINKS_PER_HOUR, KEEP_SECONDS);
  }
}
