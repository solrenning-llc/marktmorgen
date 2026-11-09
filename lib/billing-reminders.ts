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
import { repliesFor } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { isAddOn, keepCardThatPays, listSubscriptions, pastDueInGrace, periodEnd, planOf } from "@/lib/billing";
import { NIMBUS_FROM, isSenderConfigured, sendEmailOutcome } from "@/lib/email";
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

/*
 * How every subscription is reached (audit A5). Stripe lists a status newest first, 100 a page. A run reads at most
 * REMINDER_PAGES_PER_RUN pages of each status, and stops a status at its own deadline (STATUS_SLICE_MS, inside the
 * run's), so a slow status never takes the next one's time and the route's later passes keep theirs. Where it stopped
 * is kept (CURSOR_KEY, the last subscription handled and when this lap began), and the next run reads on from there;
 * a run that reaches the end goes on from the newest, so a subscription created since is not left waiting a whole
 * lap, until it meets where it began (then every subscription was read in this one run). The marks of each notice
 * (lib/claim-mark.ts) still decide what goes: no lap sends anything twice.
 *
 * Declared ceiling (rule 24): at most REMINDER_PAGES_PER_RUN pages a status a run x REMINDER_RUNS_PER_DAY runs a day
 * (vercel.json, /api/cron/reminders, "0 10 * * *"): 3 x 50 x 1 = 150 Stripe list requests a day, and two Redis
 * commands a status a run for the cursor (a GET, then a SET or a DEL). Up to the subscriptions one run reads (5,000 a
 * status, fewer when Stripe is slow and the deadline comes first), every run reads them all, as before. Above it a lap
 * takes several runs, and each such run says so (console.error, with the pages read and when the lap began); a lap
 * longer than LAP_IN_TIME_SECONDS of its status means a notice can go later than its rule wants (a trial's 7 days, a
 * yearly renewal's 15 days, a failed payment's same day), and that is said too, never hidden. A subscription is never
 * left out: it is read on a later run of its lap.
 */
/** Pages of 100 subscriptions one run reads of one status at the most (lib/billing.ts listSubscriptions). */
export const REMINDER_PAGES_PER_RUN = 50;
/** Runs of /api/cron/reminders a day (vercel.json: "0 10 * * *"); tests/billing-reminders-complete.test.ts holds it. */
export const REMINDER_RUNS_PER_DAY = 1;
type Walked = "trialing" | "active" | "past_due";
/** Each status's own share of a run, in ms: 24 s together at the most, inside the route's 60 s. */
const STATUS_SLICE_MS: Record<Walked, number> = { trialing: 6_000, active: 12_000, past_due: 6_000 };
/**
 * How long a lap may take and every notice still go in time: a trial's is first due 8 days before its charge and
 * must go 7 days before (Visa); a yearly renewal's 30 days before and must go 15 days before (California); a failed
 * payment's the day it fails.
 */
const LAP_IN_TIME_SECONDS: Record<Walked, number> = { trialing: TRIAL_NOTICE_SECONDS - 7 * DAY, active: YEAR_NOTICE_SECONDS - 15 * DAY, past_due: DAY };
const CURSOR_KEY = (status: Walked) => `nl:remind:cursor:${status}`;
/** Refreshed by every run that leaves a lap unfinished: lapses only when no run has come for a week, and then the walk starts from the newest. */
const CURSOR_SECONDS = 7 * DAY;
/** "<last subscription handled> <when this lap began, in seconds>". */
const CURSOR_VALUE = /^(sub_[A-Za-z0-9]{6,64}) (\d{1,12})$/;

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

/*
 * How both passes below claim an email (sendFailedPlanNotices, sendReminders). The mark an email stands for is
 * taken with a value only this run writes (lib/claim-mark.ts, CX-123 rule 24): "ours" sends; "taken" (another run's value, or a "1" written before marks carried their own value) was sent
 * already or is being sent, and nothing goes. When the SET NX answers in another shape or not at all, the mark is
 * read back, so a write that landed while its answer was lost (a timeout, "QUEUED") is still this run's and the
 * email still goes, once. Read back as nothing known ("unknown"), nothing is sent, the charge is said as failed, the
 * mark is let go while it still holds this run's own value (releaseMark, best effort: nothing was sent on it, so the
 * next run can send the notice, once; if the release cannot run either, the mark runs out at its own expiry and no
 * run sends twice), and the rest of that pass is given up: Redis is not answering, and each further claim would only
 * wait out its own timeout.
 * The mark is let go only after this run took it and its send was refused for certain, and only while it still holds
 * this run's value (releaseMark), never somebody else's. What the send answered decides (lib/email.ts
 * sendEmailOutcome): "sent" keeps the mark; "refused" (known not taken: no sender, a 4xx, a refusal Amazon said) lets
 * this run's own mark go, so the next run sends the notice, once; "uncertain" (a 5xx or no answer after the request
 * may have reached a sender) keeps the mark, counts the notice as uncertain, never as sent or failed, and logs it:
 * it may have gone, and sending it again could write to the creator twice. The cost of that choice: a notice that did
 * not in fact go is not sent by email. The studio still shows a past-due plan, after a trial too, with its pay link
 * (app/studio/page.tsx, components/renewal-unpaid-notice.tsx); a trial or yearly renewal notice has no second channel.
 */

type Cursor = { after: string; lapStart: number };

/**
 * Where the last run stopped, read exactly (CX-123 rule 24): the cursor, or null when GET answers that nothing is
 * kept. Any other answer is not known, and the walk starts from the newest: every subscription is reached again, and
 * the marks keep any notice from going twice, so nothing is skipped on an unreadable cursor.
 */
async function savedCursor(status: Walked): Promise<Cursor | null> {
  try {
    const raw = repliesFor(await redisPipeline([["GET", CURSOR_KEY(status)]]), 1)?.[0];
    if (raw === null) return null;
    const match = typeof raw === "string" ? CURSOR_VALUE.exec(raw) : null;
    if (match) return { after: match[1], lapStart: Number(match[2]) };
  } catch {
    // Not known: from the newest, below.
  }
  console.error(`reading where the ${status} billing reminders stopped failed (the cursor); starting from the newest`);
  return null;
}

/** Keeps where this run stopped, or lets it go once a lap ended. An unknown answer is said, never thrown. */
async function saveCursor(status: Walked, cursor: Cursor | null): Promise<void> {
  const command = cursor
    ? ["SET", CURSOR_KEY(status), `${cursor.after} ${cursor.lapStart}`, "EX", CURSOR_SECONDS]
    : ["DEL", CURSOR_KEY(status)];
  try {
    const reply = repliesFor(await redisPipeline([command]), 1)?.[0];
    if (cursor ? reply === "OK" : reply === 0 || reply === 1) return;
  } catch {
    // Said below.
  }
  // Not kept: the next run starts from the newest, and reads again what this one read (the marks keep each notice
  // once). Not let go: the next run starts after a subscription this run handled, and reaches the newest on its lap.
  console.error(`keeping where the ${status} billing reminders stopped failed (the cursor)`, cursor?.after ?? "the end");
}

function lapLate(status: Walked, lapStart: number, nowSeconds: number): string {
  const took = nowSeconds - lapStart;
  return took > LAP_IN_TIME_SECONDS[status]
    ? `; this lap has taken ${Math.round((took / DAY) * 10) / 10} days, longer than the ${LAP_IN_TIME_SECONDS[status] / DAY} its notices allow, so a notice may go later than its rule wants`
    : "";
}

/**
 * Walks one status from where the last run stopped, at most REMINDER_PAGES_PER_RUN pages and never past `deadline`
 * (epoch ms), handing each subscription to `handle` in Stripe's order. `handle` answers "stop" when the pass must end
 * before that subscription was handled (a claim not known): the cursor stays on the one before it. A page that cannot
 * be read throws, after keeping where the walk got to.
 */
async function walkStatus(
  status: Walked,
  nowSeconds: number,
  deadline: number,
  handle: (subscription: Record<string, unknown>) => Promise<"next" | "stop">,
): Promise<{ pages: number; stopped: boolean; seen: number }> {
  const out = { pages: 0, stopped: false, seen: 0 };
  if (Date.now() >= deadline) return out;
  const saved = await savedCursor(status);
  // Where this run began: a lap that comes round to it has read every subscription in this one run.
  const began = saved?.after;
  let after = began;
  let lapStart = saved?.lapStart ?? nowSeconds;
  let restarted = false;
  let wrapped = false;
  let moved = false;
  const keep = async (cursor: Cursor | null) => {
    await saveCursor(status, cursor);
    return out;
  };
  const unfinished = async (why: string) => {
    console.error(
      `the ${status} billing reminders stopped at ${why} after ${out.pages} pages (${out.seen} subscriptions); the rest are read on the next run, from where this one stopped (lap begun ${new Date(lapStart * 1000).toISOString()})${lapLate(status, lapStart, nowSeconds)}`,
    );
    return keep(after ? { after, lapStart } : null);
  };
  for (;;) {
    if (out.pages >= REMINDER_PAGES_PER_RUN) return unfinished(`their ${REMINDER_PAGES_PER_RUN} pages`);
    if (Date.now() >= deadline) return unfinished("their deadline");
    let listed: Awaited<ReturnType<typeof listSubscriptions>>;
    try {
      listed = await listSubscriptions(status, after);
    } catch (error) {
      if (began && after === began && !restarted && !moved) {
        // Stripe would not page from where the last run stopped (that subscription gone): from the newest, now.
        console.error(`the ${status} billing reminders could not read on from where the last run stopped; starting from the newest`, began);
        restarted = true;
        after = undefined;
        lapStart = nowSeconds;
        continue;
      }
      // Kept where it got to, when it got anywhere; otherwise the saved place stays as it was.
      if (moved) await saveCursor(status, after ? { after, lapStart } : null);
      throw error;
    }
    out.pages += 1;
    for (const subscription of listed.data) {
      const id = subscription.id as string;
      // Round to where this run began: every subscription was read in this one run, and the next starts from the newest.
      if (wrapped && id === began) return keep(null);
      if (Date.now() >= deadline) return unfinished("their deadline");
      out.seen += 1;
      if ((await handle(subscription)) === "stop") {
        out.stopped = true;
        return moved ? keep(after ? { after, lapStart } : null) : out;
      }
      after = id;
      moved = true;
    }
    if (!listed.hasMore) {
      // The end of the list: a lap is over.
      const late = lapLate(status, lapStart, nowSeconds);
      if (late) console.error(`the ${status} billing reminders finished a lap${late}`);
      // Begun from the newest (or begun again from it): every subscription was read in this run.
      if (!began || restarted || wrapped) return keep(null);
      // Begun on from the last run's place: on from the newest, until it meets that place, inside this run's pages and time.
      wrapped = true;
      after = undefined;
      lapStart = nowSeconds;
    }
  }
}

/** Every plan whose payment failed and that has not been written to about it yet. */
export async function sendFailedPlanNotices(
  deadline = Date.now() + STATUS_SLICE_MS.past_due,
): Promise<{ sent: number; failed: number; uncertain: number; seen: number }> {
  const counts = { sent: 0, failed: 0, uncertain: 0, seen: 0 };
  if (!isRedisConfigured() || !isSenderConfigured()) return counts;
  const walked = await walkStatus("past_due", Math.floor(Date.now() / 1000), deadline, async (subscription) => {
    const due = failedPlan(subscription);
    if (!due) return "next";
    // Claimed before anything is done, so a second run never writes twice.
    const key = `nl:remind:failed:${due.invoice}`;
    const mine = claimValue();
    const claimed = await claimMark(key, 90 * DAY, mine);
    if (claimed === "unknown") {
      // Not known whether it was taken (CX-123 rule 24): nothing is sent, the invoice is said as failed, the mark is
      // let go only while it holds this run's own value (nothing was sent on it; never throws), and this pass ends
      // here (the route's other passes still run); the cursor stays before it, so the next run reads it again.
      counts.failed += 1;
      console.error("reading whether a failed payment was written about failed; this pass stops", due.invoice);
      await releaseMark(key, mine);
      return "stop";
    }
    if (claimed !== "ours") return "next";
    try {
      // A renewal's email says what has stopped, so it is written down
      // first (lib/billing-sync.ts); a failure waits for the next run.
      if (!due.afterTrial) await recordUnpaidRenewal(subscription);
      // First, so the card that pays is the one the next renewal uses.
      await keepCardThatPays(due.subscription);
      const { subject, text } = failedPlanEmail(due);
      const outcome = await sendEmailOutcome({ meter: { by: "company" }, from: NIMBUS_FROM, to: due.email, subject, text, replyTo: SUPPORT_EMAIL });
      if (outcome === "uncertain") {
        // It may have gone (rule 24): the mark stays, so no run sends it twice; said, never as sent or failed.
        counts.uncertain += 1;
        console.error("a failed payment notice may have gone, and is not sent again", due.invoice);
        return "next";
      }
      if (outcome !== "sent") throw new Error("the email was not sent");
      counts.sent += 1;
    } catch (error) {
      counts.failed += 1;
      console.error("telling a creator their payment failed did not work", error);
      // Tried again on a later run rather than never, while the mark is still this run's own (never throws).
      await releaseMark(key, mine);
    }
    return "next";
  });
  counts.seen = walked.seen;
  return counts;
}

/**
 * Goes over every trial and every paying subscription and sends what is due.
 * Safe to run as often as it is called: each charge is warned of once. Every
 * subscription is reached within its lap (the walk above), each status in its
 * own share of the run, never past `deadline` (epoch ms).
 */
export async function sendReminders(
  nowSeconds = Math.floor(Date.now() / 1000),
  deadline = Date.now() + STATUS_SLICE_MS.trialing + STATUS_SLICE_MS.active,
): Promise<{
  sent: number;
  failed: number;
  uncertain: number;
  seen: number;
}> {
  const counts = { sent: 0, failed: 0, uncertain: 0, seen: 0 };
  if (!isRedisConfigured() || !isSenderConfigured()) return counts;

  for (const status of ["trialing", "active"] as const) {
    const walked = await walkStatus(status, nowSeconds, Math.min(deadline, Date.now() + STATUS_SLICE_MS[status]), async (subscription) => {
      const reminder = dueReminder(subscription, nowSeconds);
      if (!reminder) return "next";
      const key = `nl:remind:${reminder.kind}:${reminder.subscription}:${reminder.at}`;
      const mine = claimValue();
      const claimed = await claimMark(key, 60 * DAY, mine);
      if (claimed === "unknown") {
        // Not known whether it was taken (CX-123 rule 24): nothing is sent, the charge is said as failed, the mark is
        // let go only while it holds this run's own value (nothing was sent on it; never throws), and this pass ends
        // here, trials and renewals both (the route's other passes still run); the cursor stays before it.
        counts.failed += 1;
        console.error("reading whether a billing reminder was sent failed; this pass stops", reminder.subscription);
        await releaseMark(key, mine);
        return "stop";
      }
      if (claimed !== "ours") return "next";
      const { subject, text } = reminderEmail(reminder);
      const outcome = await sendEmailOutcome({ meter: { by: "company" }, from: NIMBUS_FROM, to: reminder.email, subject, text, replyTo: SUPPORT_EMAIL });
      if (outcome === "sent") counts.sent += 1;
      else if (outcome === "uncertain") {
        // It may have gone (rule 24): the mark stays, so no run sends it twice; said, never as sent or failed.
        counts.uncertain += 1;
        console.error(`a billing reminder may have gone, and is not sent again: ${reminder.kind}`, reminder.subscription);
      } else {
        counts.failed += 1;
        // Refused for certain: tried again on a later run rather than never, while the mark is still this run's own
        // (never throws).
        await releaseMark(key, mine);
      }
      return "next";
    });
    counts.seen += walked.seen;
    if (walked.stopped) return counts;
  }
  return counts;
}
