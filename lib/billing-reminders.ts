/**
 * Emails sent to a creator before we charge them in a way they might not see
 * coming: the first charge after the free trial, and a yearly renewal. And
 * one after a charge that did not go through (failedPlanEmail, below).
 *
 * The card networks require the first (Visa: at least seven days before the
 * first charge after a trial, with a way to cancel), California requires the
 * second (15 to 45 days before a yearly plan renews), and both are simply how
 * a subscription should treat the person paying for it. Each is sent once per
 * charge, and says the date, the amount and the one click that stops it.
 */
import { claimMark } from "@/lib/claim-mark";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
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
/** Sent on the first daily run with at most thirty days left, and never later than needed. */
const YEAR_NOTICE_SECONDS = 30 * DAY;
/** Too close to the charge to be of use: left alone. */
const TOO_LATE_SECONDS = DAY;
const MAX_PAGES = 50;
/**
 * Where a list was left when a run stopped at MAX_PAGES, so the next run goes on from there rather than from the top
 * again (rule 24, R24 crons item 6): a subscription past the first fifty pages used to be never reached, in silence.
 */
const afterKey = (status: string) => `nl:remind:after:${status}`;
const AFTER_SECONDS = 30 * DAY;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{6,64}$/;

/**
 * Every subscription of one status, a page at a time from where the last run left the list, at most MAX_PAGES a run.
 * `each` says whether a subscription was handled (sent, or nothing due). Where the next run reads from:
 *   - the list ended this run: the top, so a subscription not handled is read again there, with every newer one;
 *   - the cap stopped this run: from before the first not handled (its email did not go), or after the last page
 *     read when every one was. Not before the first not handled when that is where this run started: nothing moved,
 *     so a subscription whose email fails every time would hold the cursor for good, and every subscription after it
 *     would never be read (Claude 2 and Codex S on #3215). The walk then steps past that one only: from before the
 *     second not handled, or from the last page read when there is none, and that one is read again when the list
 *     comes round.
 * `more`: the cap stopped this run.
 */
async function walkList(
  status: "trialing" | "active" | "past_due",
  each: (subscription: Record<string, unknown>) => Promise<boolean>,
): Promise<{ seen: number; more: boolean }> {
  const [saved] = await redisPipeline([["GET", afterKey(status)]]);
  // Unreadable or absent: from the top, as every run read before this cursor existed. Never a send twice: each
  // reminder is held by its own mark.
  let after = typeof saved === "string" && SUBSCRIPTION_ID.test(saved) ? saved : "";
  const start = after;
  // Every subscription not handled, in list order, by where a reading starts to list it again.
  const notHandledFrom: string[] = [];
  let seen = 0;
  let more = true;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, hasMore } = await listSubscriptions(status, after || undefined);
    let previous = after;
    for (const subscription of data) {
      const from = previous;
      previous = String(subscription.id);
      seen += 1;
      if (!(await each(subscription))) notHandledFrom.push(from);
    }
    const last = data[data.length - 1];
    if (!hasMore || typeof last?.id !== "string") {
      after = "";
      more = false;
      break;
    }
    after = last.id;
  }
  if (more) console.error(`billing reminders: more ${status} subscriptions than one run reads; the next run goes on from where this one stopped`);
  const stopAt = notHandledFrom[0] ?? null;
  if (more && stopAt === start) console.error(`billing reminders: a ${status} subscription at the start of this run was not handled again; the walk goes on and reads it when the list comes round`);
  // Only that one is stepped past: the next one not handled, when there is one, is read again on the next run
  // (Claude 1 on #3215: a sender outage would otherwise skip every one the run read).
  const next = !more ? "" : stopAt === null ? after : stopAt === start ? (notHandledFrom[1] ?? after) : stopAt;
  await redisPipeline([next ? ["SET", afterKey(status), next, "EX", AFTER_SECONDS] : ["DEL", afterKey(status)]]);
  return { seen, more };
}

/**
 * Lets a reminder's mark go after its email did not go, so the next run tries again (rule 24, R24 crons item 6): tried
 * twice, and a mark still held is said (false, logged with its key), never swallowed, because it keeps that reminder
 * from being tried again until it runs out.
 */
async function letGo(key: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const reply = repliesFor(await redisPipeline([["DEL", key]]), 1);
      const deleted = reply ? countOf(reply[0]) : null;
      if (deleted === 0 || deleted === 1) return true;
    } catch {
      // Tried once more, then said.
    }
  }
  console.error("a billing reminder's mark could not be let go: that reminder is not tried again until the mark runs out", key);
  return false;
}

export type Reminder = {
  kind: "trial" | "renewal";
  subscription: string;
  email: string;
  /** When the charge happens, in seconds. */
  at: number;
  tier: Tier;
  cycle: Cycle;
  amountCents: number;
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
  const id = typeof subscription.id === "string" ? subscription.id : "";
  // An add-on (the Store assistant) is not a plan: these words are about plans.
  if (!id || isAddOn(subscription)) return null;
  // Set to stop: nothing more will be charged, so there is nothing to warn of.
  if (subscription.cancel_at_period_end === true) return null;
  if (typeof subscription.cancel_at === "number" && subscription.cancel_at > 0) return null;
  const customer = subscription.customer as { email?: unknown; deleted?: unknown } | string | null;
  const email = customer && typeof customer === "object" && typeof customer.email === "string" ? customer.email : "";
  if (!email) return null;

  const trialing = subscription.status === "trialing";
  const at = periodEnd(subscription, trialing);
  const left = at - nowSeconds;
  if (!at || left <= TOO_LATE_SECONDS) return null;
  const plan = planOf(subscription);
  if (!plan.amountCents) return null;

  if (trialing) {
    return left <= TRIAL_NOTICE_SECONDS
      ? { kind: "trial", subscription: id, email, at, ...plan }
      : null;
  }
  if (subscription.status === "active" && plan.cycle === "year" && left <= YEAR_NOTICE_SECONDS) {
    return { kind: "renewal", subscription: id, email, at, ...plan };
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

/**
 * Every plan whose payment failed and that has not been written to about it yet. `unreleased`: emails that did not go
 * and whose mark could not be let go, so they are not tried again until it runs out; `more`: the page cap stopped
 * this run, and the next goes on from there.
 */
export async function sendFailedPlanNotices(): Promise<{ sent: number; failed: number; seen: number; unreleased: number; more: boolean }> {
  const counts = { sent: 0, failed: 0, seen: 0, unreleased: 0, more: false };
  if (!isRedisConfigured() || !isSenderConfigured()) return counts;
  const walked = await walkList("past_due", async (subscription) => {
    const due = failedPlan(subscription);
    if (!due) return true;
    // Claimed before anything is done, so a second run never writes twice.
    const key = `nl:remind:failed:${due.invoice}`;
    // Ours, someone else's (told already), or unknown: no email on a guess, read again on the next run (rule 24).
    const claimed = await claimMark(key, 90 * DAY);
    if (claimed === "taken") return true;
    if (claimed !== "ours") return false;
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
      return true;
    } catch (error) {
      counts.failed += 1;
      console.error("telling a creator their payment failed did not work", error);
      // Tried again on the next run rather than never.
      if (!(await letGo(key))) counts.unreleased += 1;
      return false;
    }
  });
  counts.seen = walked.seen;
  counts.more = walked.more;
  return counts;
}

/**
 * Goes over every trial and every paying subscription and sends what is due.
 * Safe to run as often as it is called: each charge is warned of once.
 */
export async function sendReminders(nowSeconds = Math.floor(Date.now() / 1000)): Promise<{
  sent: number;
  failed: number;
  seen: number;
  /** Reminders whose email did not go and whose mark could not be let go: not tried again until it runs out. */
  unreleased: number;
  /** A list longer than one run reads: the next run goes on from where this one stopped. */
  more: boolean;
}> {
  const counts = { sent: 0, failed: 0, seen: 0, unreleased: 0, more: false };
  if (!isRedisConfigured() || !isSenderConfigured()) return counts;

  for (const status of ["trialing", "active"] as const) {
    const walked = await walkList(status, async (subscription) => {
      const reminder = dueReminder(subscription, nowSeconds);
      if (!reminder) return true;
      const key = `nl:remind:${reminder.kind}:${reminder.subscription}:${reminder.at}`;
      // Ours, someone else's (sent already), or unknown: no email on a guess, read again on the next run (rule 24).
      const claimed = await claimMark(key, 60 * DAY);
      if (claimed === "taken") return true;
      if (claimed !== "ours") return false;
      const { subject, text } = reminderEmail(reminder);
      const ok = await sendEmail({ meter: { by: "company" }, from: NIMBUS_FROM, to: reminder.email, subject, text, replyTo: SUPPORT_EMAIL });
      if (ok) {
        counts.sent += 1;
        return true;
      }
      counts.failed += 1;
      // Tried again on the next run rather than never.
      if (!(await letGo(key))) counts.unreleased += 1;
      return false;
    });
    counts.seen += walked.seen;
    counts.more ||= walked.more;
  }
  return counts;
}
