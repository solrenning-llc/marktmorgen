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
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { isAddOn, keepCardThatPays, listSubscriptions, noTryFrom, pastDueInGrace, periodEnd, planOf, retryLeft, stateOf } from "@/lib/billing";
import { noTryEndsAt } from "@/lib/no-try-rules";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import { recordUnpaidRenewal } from "@/lib/billing-sync";
import { storeForHandle } from "@/lib/store";
import { RENEWAL_KEPT_WORDS, RENEWAL_PAUSED_WORDS, RENEWAL_RESUME_WORDS } from "@/lib/renewal-unpaid-words";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { PLAN_NAMES, PLAN_PRICES, type Cycle, type Tier } from "@/lib/plan";
import { CLOSING_DAYS } from "@/lib/plan-closing-rules";

const DAY = 86_400;
/** Sent on the first daily run with at most this long left: seven to eight days. */
const TRIAL_NOTICE_SECONDS = 8 * DAY;
/** Sent on the first daily run with at most thirty days left, and never later than needed. */
const YEAR_NOTICE_SECONDS = 30 * DAY;
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
  /** When Stripe tries the card again, in seconds, or 0 when no try is scheduled. */
  nextTry: number;
  /**
   * With no try scheduled (pre-review M-a): "manual" for an invoice paid by
   * its link only (`send_invoice`), whose card is never tried on its own;
   * "waiting" while the plan has not ended (lib/billing.ts, retryLeft), until
   * `endsAt` when that can be read; "ended" once it has. "" with a try scheduled.
   */
  noTry: "" | "manual" | "waiting" | "ended";
  /** With noTry "waiting": the day the plan ends if it is still unpaid, in seconds; 0 when that cannot be read. */
  endsAt: number;
  /** The first charge after the free trial: nothing was ever paid. */
  afterTrial: boolean;
  tier: Tier;
};

const INVOICE_ID = /^in_[A-Za-z0-9]{6,64}$/;

/**
 * The failed payment a past-due subscription is waiting on, if it can be paid
 * from an email. `unpaidSince`: when the store that keeps it first recorded
 * the renewal unpaid (0 when not known), the clock its end is counted on
 * (lib/no-try-rules.ts; second pre-review M-1); `ended`: that store has
 * already written its plan ended.
 */
export function failedPlan(subscription: Record<string, unknown>, unpaidSince = 0, ended = false): FailedPlan | null {
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
  // A null next try ends the plan only NO_TRY_WAIT_DAYS after the renewal was
  // first unpaid, on the same clock the store ends it by (pre-review M-a;
  // second pre-review G-1, M-1); one paid by link is never said to be tried.
  const from = noTryFrom(subscription);
  const endsOn = from === undefined ? 0 : noTryEndsAt(unpaidSince, from);
  const read = stateOf(subscription);
  const over = !afterTrial && (ended || (read.state === "inactive" && read.reason === "past_due_no_retry") || (endsOn > 0 && Math.floor(Date.now() / 1000) >= endsOn));
  const noTry = nextTry ? "" : over ? "ended" : retryLeft(subscription) === "manual" ? "manual" : "waiting";
  const endsAt = noTry === "waiting" ? endsOn : 0;
  return { subscription: id, invoice: invoiceId, email, amountCents, payUrl, nextTry, noTry, endsAt, afterTrial, tier: planOf(subscription).tier };
}

/** The email itself, plain text. */
export function failedPlanEmail(failed: FailedPlan, endedSeconds = Math.floor(Date.now() / 1000)): { subject: string; text: string } {
  const name = PLAN_NAMES[failed.tier];
  // Once Stripe has stopped trying (noTry "ended"), the plan has ended (lib/billing.ts, retryLeft) and the
  // store closes as the Terms say: nothing is removed before CLOSING_DAYS
  // after the day its end is written down (lib/plan-closing.ts, removalDay),
  // the day the store records, or today when it has not been written yet.
  const keptUntil = day(endedSeconds + CLOSING_DAYS * DAY);
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
              : failed.noTry === "ended"
                ? "Stripe will not try your card again for it, so your plan has ended. If you pay it on that page, your plan goes on; if you do not, your store closes as our Terms say."
                : failed.noTry === "waiting"
                  ? failed.endsAt
                    ? `Stripe has not scheduled another try for it. If it is still unpaid on ${day(failed.endsAt)}, your plan ends, and then your store closes as our Terms say; nothing is removed before ${day(failed.endsAt + CLOSING_DAYS * DAY)}.`
                    : "Stripe has not scheduled another try for it. If it stays unpaid, your plan can end, and then your store closes as our Terms say."
                  : "If it is not paid, your plan can end, and then your store closes as our Terms say.",
          ].join("\n"),
      "",
      failed.noTry === "ended"
        ? `If you meant to stop, your plan has already ended and this card is not tried for it again. Your store closes as our Terms say, we email you before anything is removed, and nothing is removed before ${keptUntil}.`
        : `If you meant to stop, you do not need to do anything, or you can cancel in your studio: ${studio}`,
      "",
      `Questions: reply to this email, or write to ${SUPPORT_EMAIL}.`,
      "",
      "Marktmorgen",
    ].join("\n"),
  };
}

/**
 * The clock a failed renewal's end is counted on, for the store that keeps
 * this subscription: when it first recorded the renewal unpaid (0 when it has
 * not), and whether it already wrote the plan ended.
 */
export async function unpaidClock(subscription: Record<string, unknown>): Promise<{ unpaidSince: number; ended: boolean }> {
  const handle = (subscription.metadata as Record<string, unknown> | null | undefined)?.store;
  if (typeof handle !== "string" || !handle) return { unpaidSince: 0, ended: false };
  const store = await storeForHandle(handle);
  if (!store || store.subscriptionId !== subscription.id) return { unpaidSince: 0, ended: false };
  return { unpaidSince: store.subscriptionActive ? store.renewalUnpaidSince ?? 0 : 0, ended: !store.subscriptionActive && Boolean(store.planEndedAt) };
}

/**
 * When the store that keeps this subscription wrote its plan's end down, in
 * seconds, or now when it has not (the daily job writes it once it reads the
 * plan ended): the day its closing is counted from.
 */
export async function planEndedSeconds(subscription: Record<string, unknown>): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const handle = (subscription.metadata as Record<string, unknown> | null | undefined)?.store;
  if (typeof handle !== "string" || !handle) return now;
  const store = await storeForHandle(handle);
  const ended = store && store.subscriptionId === subscription.id ? Date.parse(store.planEndedAt) : NaN;
  return Number.isFinite(ended) ? Math.min(now, Math.floor(ended / 1000)) : now;
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
        // The end it names is counted on the store's own clock, now written down.
        const clock = await unpaidClock(subscription);
        if (!due.nextTry && !due.afterTrial) Object.assign(due, failedPlan(subscription, clock.unpaidSince, clock.ended) ?? {});
        // First, so the card that pays is the one the next renewal uses.
        await keepCardThatPays(due.subscription);
        const { subject, text } = failedPlanEmail(due, due.noTry === "ended" ? await planEndedSeconds(subscription) : undefined);
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
  failed: number;
  seen: number;
}> {
  const counts = { sent: 0, failed: 0, seen: 0 };
  if (!isRedisConfigured() || !isSenderConfigured()) return counts;

  for (const status of ["trialing", "active"] as const) {
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, hasMore } = await listSubscriptions(status, after);
      for (const subscription of data) {
        counts.seen += 1;
        const reminder = dueReminder(subscription, nowSeconds);
        if (!reminder) continue;
        const key = `nl:remind:${reminder.kind}:${reminder.subscription}:${reminder.at}`;
        const [claimed] = await redisPipeline([["SET", key, "1", "NX", "EX", 60 * DAY]]);
        if (claimed === null) continue;
        const { subject, text } = reminderEmail(reminder);
        const ok = await sendEmail({ meter: { by: "company" }, from: NIMBUS_FROM, to: reminder.email, subject, text, replyTo: SUPPORT_EMAIL });
        if (ok) counts.sent += 1;
        else {
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
