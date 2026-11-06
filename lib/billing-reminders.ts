/**
 * Emails sent to a creator before we charge them in a way they might not see
 * coming: the first charge after the free trial, and a yearly renewal. And
 * one after a charge that did not go through (failedPlanEmail, below).
 *
 * The card networks require the first (Visa: at least seven days before the
 * first charge after a trial, with a way to cancel), the renewal laws require the
 * second (the 30th day before a yearly plan renews, see YEAR_NOTICE_DAYS), and both are simply how
 * a subscription should treat the person paying for it. Each is sent once per
 * charge, and says the date, the amount and the one click that stops it.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { isAddOn, keepCardThatPays, listSubscriptions, pastDueInGrace, periodEnd, planOf } from "@/lib/billing";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import { recordUnpaidRenewal } from "@/lib/billing-sync";
import { RENEWAL_KEPT_WORDS, RENEWAL_PAUSED_WORDS, RENEWAL_RESUME_WORDS } from "@/lib/renewal-unpaid-words";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { PLAN_NAMES, PLAN_PRICES, type Cycle, type Tier } from "@/lib/plan";

const DAY = 86_400;
/** Sent on the first daily run with at most this long left: seven to eight days. */
const TRIAL_NOTICE_SECONDS = 8 * DAY;
/**
 * Below this, a trial notice is late: the card networks' seven days
 * (California's floor for a trial over 31 days, three days, is inside it).
 */
export const TRIAL_FLOOR_SECONDS = 7 * DAY;
/**
 * Sent on the 30th calendar day before the charge's date, never earlier; if a
 * run misses that day, it is sent on the next run and marked late.
 * The official texts read on 30 Oct 2026 (queue 414 [KX1],
 * docs/kx1-renewal-legal-matrix-2026-10-30.md, sections 6 to 9) allow only
 * that day before an annual renewal in every jurisdiction read: Utah 30-60
 * days (Utah Code §13-70-201), Illinois, Virginia and DC 30-60 before the
 * cancellation deadline, Colorado 25-40, Massachusetts 5-30 (940 CMR
 * 38.05(4)), New York 15-45, California 15-45 (secondary).
 *
 * Days are calendar days in UTC (the daily run's own date), compared with
 * the charge's UTC date: counting elapsed seconds would let a charge late in
 * the day be noticed on the 29th day and still look on time. A customer's own
 * local date can differ from UTC near midnight; that limit is recorded in the
 * matrix as gap G16.
 */
export const YEAR_NOTICE_DAYS = 30;

/** The end of one full billing period that starts at `at` (calendar, UTC). */
export function fullPeriodAfter(at: number, cycle: Cycle): number {
  const date = new Date(at * 1000);
  if (cycle === "year") date.setUTCFullYear(date.getUTCFullYear() + 1);
  else date.setUTCMonth(date.getUTCMonth() + 1);
  return Math.floor(date.getTime() / 1000);
}

/** Whole UTC calendar days from the day of `now` to the day of `at`. */
export function calendarDaysBefore(at: number, now: number): number {
  return Math.floor(at / DAY) - Math.floor(now / DAY);
}

function daysWords(at: number, now: number): string {
  const days = calendarDaysBefore(at, now);
  return `${days} calendar day${days === 1 ? "" : "s"} (UTC)`;
}
/** Too close to the charge to be of use: left alone. */
const TOO_LATE_SECONDS = DAY;
const MAX_PAGES = 50;

export type Reminder = {
  kind: "trial" | "renewal";
  subscription: string;
  email: string;
  /** When the charge happens, in seconds. */
  at: number;
  tier: Tier;
  cycle: Cycle;
  amountCents: number;
  /**
   * Sent after its window's floor had passed (a missed run, or a plan made
   * inside it). Still sent, because the person is better told late than not
   * at all, but counted apart and never reported as on time.
   */
  late: boolean;
};

function day(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function money(cents: number): string {
  // "$2,388": a yearly charge in the thousands is written the way it is said.
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** The email itself. Plain text, so every word is exactly what arrives. */
export function reminderEmail(reminder: Reminder): { subject: string; text: string } {
  const date = day(reminder.at);
  const name = PLAN_NAMES[reminder.tier];
  const price = money(reminder.amountCents);
  const studio = `${SITE_URL}/studio#billing`;
  if (reminder.kind === "trial") {
    const then =
      reminder.cycle === "year"
        ? `${price} for a year, and then ${price} every year`
        : `${price}, and then ${price} every month`;
    return {
      subject: `Your ${name} trial ends on ${date}`,
      text: [
        "Hello,",
        "",
        `Your free trial of ${name} ends on ${date}. On that day your card will be charged ${then}, until you cancel.`,
        "",
        "If you do not want to be charged, cancel before then in your studio. It takes two clicks, with no email to us:",
        studio,
        "",
        "If you cancel, your card is never charged, and your store keeps taking payments until the trial ends.",
        "",
        `Questions: reply to this email, or write to ${SUPPORT_EMAIL}.`,
        "",
        "Marktmorgen",
      ].join("\n"),
    };
  }
  const monthly = money(PLAN_PRICES[reminder.tier].month);
  return {
    subject: `Your ${name} subscription renews on ${date}`,
    text: [
      "Hello,",
      "",
      `Your yearly subscription to ${name} renews automatically on ${date}. Your card will be charged ${price} for another year, unless you cancel before then.`,
      "",
      `To cancel, or to switch to paying ${monthly} a month instead, open your studio. Canceling takes two clicks, with no email to us:`,
      studio,
      "",
      `If you cancel, nothing more is charged, and your store keeps taking payments until ${date}.`,
      "",
      `Questions: reply to this email, or write to ${SUPPORT_EMAIL}.`,
      "",
      "Marktmorgen",
    ].join("\n"),
  };
}

/** Which reminder a subscription is due right now, if any. */
export function dueReminder(subscription: Record<string, unknown>, nowSeconds: number): Reminder | null {
  return noticeFor(subscription, nowSeconds, false);
}

/**
 * A notice that was due but was never sent, found when the charge is a day
 * or less away (too close to be of use, so it is not sent now): returned so
 * the run can count it as missed instead of dropping it silently.
 */
export function missedReminder(subscription: Record<string, unknown>, nowSeconds: number): Reminder | null {
  const at = periodEnd(subscription, subscription.status === "trialing");
  if (!at || at - nowSeconds > TOO_LATE_SECONDS || at <= nowSeconds) return null;
  return noticeFor(subscription, nowSeconds, true);
}

function noticeFor(subscription: Record<string, unknown>, nowSeconds: number, tooLate: boolean): Reminder | null {
  const id = typeof subscription.id === "string" ? subscription.id : "";
  // An add-on (the Store assistant) is not a plan: these words are about plans.
  if (!id || isAddOn(subscription)) return null;
  // Set to stop: nothing more will be charged, so there is nothing to warn of.
  if (subscription.cancel_at_period_end === true) return null;
  const customer = subscription.customer as { email?: unknown; deleted?: unknown } | string | null;
  const email = customer && typeof customer === "object" && typeof customer.email === "string" ? customer.email : "";
  if (!email) return null;

  const trialing = subscription.status === "trialing";
  const at = periodEnd(subscription, trialing);
  const left = at - nowSeconds;
  if (!at || (!tooLate && left <= TOO_LATE_SECONDS)) return null;
  const plan = planOf(subscription);
  if (!plan.amountCents) return null;
  // A cancellation already scheduled. On or before this charge: nothing will
  // be charged, so there is nothing to warn of. At least a full period after
  // it: this charge is the full price for a full period, which the email
  // says. In between, Stripe prorates the last period (API reference,
  // cancel_at), so the email's amount and "another year" would be untrue:
  // nothing is sent, and the gap is recorded (queue 414 [KX1], G17).
  if (typeof subscription.cancel_at === "number" && subscription.cancel_at > 0) {
    if (subscription.cancel_at < fullPeriodAfter(at, plan.cycle)) return null;
  }

  if (trialing) {
    return left <= TRIAL_NOTICE_SECONDS
      ? { kind: "trial", subscription: id, email, at, ...plan, late: left < TRIAL_FLOOR_SECONDS }
      : null;
  }
  if (subscription.status === "active" && plan.cycle === "year") {
    const days = calendarDaysBefore(at, nowSeconds);
    if (days > YEAR_NOTICE_DAYS) return null;
    return { kind: "renewal", subscription: id, email, at, ...plan, late: days < YEAR_NOTICE_DAYS };
  }
  return null;
}

/**
 * A creator's own plan whose payment failed, and the page that pays it.
 *
 * Measured before it was built (11 October 2026): Stan, the store this one is
 * first compared with, loses about 13% of its creators a month (Contrary,
 * August 2026). In subscription software a fifth to two fifths of that is a
 * card that expired, not a creator who chose to leave. Stripe retries the dead
 * card on its own and then ends the plan, and the creator, who never opened
 * the dashboard where the failure shows, finds out when their checkout stops
 * taking money. One email, sent the day it fails, with the link that pays it,
 * keeps most of those.
 *
 * The same care as a member's failed renewal (lib/payment-recovery.ts):
 * the invoice's own Stripe page, which pays that very invoice with whatever
 * card is typed, and the subscription told first to keep the card that pays.
 * Once per invoice: a second email about the same payment reads as a debt
 * collector.
 */
export type FailedPlan = {
  subscription: string;
  invoice: string;
  email: string;
  amountCents: number;
  payUrl: string;
  /** When Stripe tries the card again, in seconds, or 0 when it will not. */
  nextTry: number;
  /** The first charge after the free trial: nothing was ever paid. */
  afterTrial: boolean;
  tier: Tier;
};

const INVOICE_ID = /^in_[A-Za-z0-9]{6,64}$/;

/** The failed payment a past-due subscription is waiting on, if it can be paid from an email. */
export function failedPlan(subscription: Record<string, unknown>): FailedPlan | null {
  const id = typeof subscription.id === "string" ? subscription.id : "";
  // An add-on whose payment failed simply stops answering: the plan's words ("your checkout stops") are not about it.
  if (!id || subscription.status !== "past_due" || isAddOn(subscription)) return null;
  const customer = subscription.customer as { email?: unknown } | string | null;
  const email = customer && typeof customer === "object" && typeof customer.email === "string" ? customer.email.trim() : "";
  const invoice = subscription.latest_invoice as
    | { id?: unknown; status?: unknown; amount_due?: unknown; hosted_invoice_url?: unknown; next_payment_attempt?: unknown; billing_reason?: unknown }
    | string
    | null;
  if (!invoice || typeof invoice !== "object") return null;
  const invoiceId = typeof invoice.id === "string" && INVOICE_ID.test(invoice.id) ? invoice.id : "";
  const amountCents = typeof invoice.amount_due === "number" ? invoice.amount_due : 0;
  const payUrl = typeof invoice.hosted_invoice_url === "string" ? invoice.hosted_invoice_url : "";
  // Only an invoice still open, with money on it, a page to pay it on and an
  // address to write to. Anything else is Stripe's to settle.
  if (!email || !invoiceId || invoice.status !== "open" || amountCents <= 0 || !payUrl.startsWith("https://")) return null;
  // The first invoice after a trial is the one that ends it, and a store whose
  // first payment failed is not in the grace a renewal has (lib/billing.ts):
  // its checkout has already stopped, and the email must say so.
  const afterTrial = !pastDueInGrace(subscription);
  const nextTry = typeof invoice.next_payment_attempt === "number" && invoice.next_payment_attempt > 0 ? invoice.next_payment_attempt : 0;
  return { subscription: id, invoice: invoiceId, email, amountCents, payUrl, nextTry, afterTrial, tier: planOf(subscription).tier };
}

/** The email itself, plain text. */
export function failedPlanEmail(failed: FailedPlan): { subject: string; text: string } {
  const name = PLAN_NAMES[failed.tier];
  const price = money(failed.amountCents);
  const studio = `${SITE_URL}/studio#billing`;
  return {
    subject: failed.afterTrial
      ? `Your ${name} trial has ended: the first payment did not go through`
      : `Your ${name} payment did not go through`,
    text: [
      "Hello,",
      "",
      failed.afterTrial
        ? `Your free trial of ${name} has ended, and the first payment of ${price} did not go through. Your bank may have declined it, or the card may have expired.`
        : `The payment of ${price} for your ${name} plan did not go through. Your bank may have declined it, or the card may have expired.`,
      "",
      "Pay it here, with the same card or another one. It is Stripe's own page, and the card you use becomes the one your plan is charged on from now on:",
      failed.payUrl,
      "",
      failed.afterTrial
        ? "Until it is paid, your checkout cannot take money. Your store and your products stay up, and nothing you uploaded is removed without several emails well before."
        : [
            // What stops is what costs us to run (232 [CA1] unit 4, lib/plan-standing.ts costStandingOf, lib/billing.ts isPaidUp).
            `${RENEWAL_PAUSED_WORDS} ${RENEWAL_KEPT_WORDS} ${RENEWAL_RESUME_WORDS}`,
            "",
            failed.nextTry
              ? `We will try your card again on ${day(failed.nextTry)}. If it is still unpaid after the last try, your plan can end, and then your store closes as our Terms say.`
              : "If it is not paid, your plan can end, and then your store closes as our Terms say.",
          ].join("\n"),
      "",
      `If you meant to stop, you do not need to do anything, or you can cancel in your studio: ${studio}`,
      "",
      `Questions: reply to this email, or write to ${SUPPORT_EMAIL}.`,
      "",
      "Marktmorgen",
    ].join("\n"),
  };
}

/** Every plan whose payment failed and that has not been written to about it yet. */
export async function sendFailedPlanNotices(): Promise<{ sent: number; failed: number; seen: number }> {
  const counts = { sent: 0, failed: 0, seen: 0 };
  if (!isRedisConfigured() || !isSenderConfigured()) return counts;
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, hasMore } = await listSubscriptions("past_due", after);
    for (const subscription of data) {
      counts.seen += 1;
      const due = failedPlan(subscription);
      if (!due) continue;
      // Claimed before anything is done, so a second run never writes twice.
      const key = `nl:remind:failed:${due.invoice}`;
      const [claimed] = await redisPipeline([["SET", key, "1", "NX", "EX", 90 * DAY]]);
      if (claimed === null) continue;
      try {
        // A renewal's email says what has stopped, so it is written down
        // first (lib/billing-sync.ts); a failure waits for the next run.
        if (!due.afterTrial) await recordUnpaidRenewal(subscription);
        // First, so the card that pays is the one the next renewal uses.
        await keepCardThatPays(due.subscription);
        const { subject, text } = failedPlanEmail(due);
        const ok = await sendEmail({ meter: { by: "company" }, from: NIMBUS_FROM, to: due.email, subject, text, replyTo: SUPPORT_EMAIL });
        if (!ok) throw new Error("the email was not sent");
        counts.sent += 1;
      } catch (error) {
        counts.failed += 1;
        console.error("telling a creator their payment failed did not work", error);
        // Tried again on the next run rather than never.
        await redisPipeline([["DEL", key]]).catch(() => {});
      }
    }
    const last = data[data.length - 1];
    if (!hasMore || typeof last?.id !== "string") break;
    after = last.id;
  }
  return counts;
}

/**
 * Goes over every trial and every paying subscription and sends what is due.
 * Safe to run as often as it is called: each charge is warned of once.
 */
export async function sendReminders(nowSeconds = Math.floor(Date.now() / 1000)): Promise<{
  sent: number;
  /** Of those sent, how many went after their window's floor. */
  late: number;
  /** Due but never sent, found a day or less before the charge: counted, not sent. */
  missed: number;
  failed: number;
  seen: number;
}> {
  const counts = { sent: 0, late: 0, missed: 0, failed: 0, seen: 0 };
  if (!isRedisConfigured() || !isSenderConfigured()) return counts;

  for (const status of ["trialing", "active"] as const) {
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, hasMore } = await listSubscriptions(status, after);
      for (const subscription of data) {
        counts.seen += 1;
        const reminder = dueReminder(subscription, nowSeconds);
        if (!reminder) {
          const missed = missedReminder(subscription, nowSeconds);
          if (missed) {
            // The same key a sent notice holds: claimed here only if no notice
            // went for this charge, so a missed one is counted once.
            const missedKey = `nl:remind:${missed.kind}:${missed.subscription}:${missed.at}`;
            const [unsent] = await redisPipeline([["SET", missedKey, "1", "NX", "EX", 60 * DAY]]);
            if (unsent !== null) {
              counts.missed += 1;
              console.warn(`billing reminder missed: ${missed.kind}, ${daysWords(missed.at, nowSeconds)} before the charge`);
            }
          }
          continue;
        }
        const key = `nl:remind:${reminder.kind}:${reminder.subscription}:${reminder.at}`;
        const [claimed] = await redisPipeline([["SET", key, "1", "NX", "EX", 60 * DAY]]);
        if (claimed === null) continue;
        const { subject, text } = reminderEmail(reminder);
        const ok = await sendEmail({ meter: { by: "company" }, from: NIMBUS_FROM, to: reminder.email, subject, text, replyTo: SUPPORT_EMAIL });
        if (ok) {
          counts.sent += 1;
          if (reminder.late) {
            counts.late += 1;
            console.warn(`billing reminder sent late: ${reminder.kind}, ${daysWords(reminder.at, nowSeconds)} before the charge`);
          }
        } else {
          counts.failed += 1;
          // Tried again on the next run rather than never.
          await redisPipeline([["DEL", key]]).catch(() => {});
        }
      }
      const last = data[data.length - 1];
      if (!hasMore || typeof last?.id !== "string") break;
      after = last.id;
    }
  }
  return counts;
}
