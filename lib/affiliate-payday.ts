/**
 * The email a creator gets on the day they said they pay their affiliates.
 *
 * The promise a creator makes on their affiliate page — "paid on the 5th of
 * each month" — is only worth what it is kept at, and the way a promise like
 * that gets broken is never bad faith. It is a person with a store to run
 * forgetting which day it is. So Marktmorgen keeps the date instead: on the morning
 * of that day, if anybody is owed something that has cleared, the creator gets
 * one message saying how much and to how many, with the link that opens the
 * batch.
 *
 * Nothing here moves money, and nothing here can. It reads the book, counts
 * what is payable, and writes an email. The creator still downloads the file
 * and pays it from their own account, which is the whole architecture and does
 * not bend for convenience.
 *
 * Sent once per store per month: the day's key is claimed in Redis before the
 * message goes out, so a second run of the job on the same day — a retry, an
 * overlap, a store seen twice while it moves between addresses — finds the day
 * taken and does nothing.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { claimMark } from "@/lib/claim-mark";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import { storesAfter, type Store } from "@/lib/store";
import { affiliatesOn, readBook } from "@/lib/affiliates";
import { batchTotal } from "@/lib/affiliate-payouts";
import { onTheirWay, payableLines, payWithPayPal, paysAutomatically } from "@/lib/paypal-payouts";
import { ordinal } from "@/lib/affiliate-setting";
import { formatMoney } from "@/lib/money";

/** How long the mark on a month lasts: long enough that next month is a new one. */
const CLAIM_SECONDS = 40 * 86_400;
/** A ceiling on one run, so a job that is behind still ends. */
const MAX_STEPS = 10_000;
/**
 * How many days after its payday a store the payday run reached but did not finish is still caught up
 * (webhooks/cron audit, Claude 1, 12/11/2026). The job runs once a day (vercel.json, "0 13 * * *"): a store whose
 * payday failed (a Redis or PayPal read that threw, a claim answered unknown) used to wait until the same day next
 * month, with its affiliates unpaid and the creator never told. A store the payday did handle (an email sent, or
 * nobody owed anything that day: both claim the month) is never caught up, so a sale that clears after the payday
 * still joins next month's batch, as before.
 *
 * Only a payday that was in force on its day is caught up (Claude 2 nuvem F/B on #4255): the day's run marks each
 * store it reaches as due (dueKey) before reading its book, and a catch-up needs that mark. A payday moved onto a day
 * that just passed, affiliates turned on after the day, or a store created after it, was never due, so nothing
 * failed and nothing is sent until the next payday. A store the day's deadline never reached carries no mark either,
 * and waits for next month as it did before this catch-up existed.
 */
export const PAYDAY_CATCH_UP_DAYS = 3;

export type PaydayCounts = {
  /** Stores looked at. */
  seen: number;
  /** Stores whose payday is today and who had somebody to pay. */
  due: number;
  /** Emails that went out. */
  sent: number;
  failed: number;
  complete: boolean;
};

/** The month a claim is made for: "2026-10". */
function monthOf(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Claims this store's payday for this month. True the first time, false
 * every time after, which is what makes the job safe to run twice. Read
 * exactly (lib/claim-mark.ts, CX-123 rule 24): a claim answered in another
 * shape and not read back as ours is never ours, and throws, so the store is
 * counted as failed and nobody is written to or paid on it.
 */
async function claimMonth(statsId: string, month: string): Promise<boolean> {
  const got = await claimMark(claimKey(statsId, month), CLAIM_SECONDS);
  if (got === "unknown") throw new UnknownReplyError("a store's payday claim");
  return got === "ours";
}

function claimKey(statsId: string, month: string): string {
  return `nl:aff:payday:${statsId}:${month}`;
}

/** Set by the payday's own run when it reaches the store, before its book is read: the payday was in force that day. */
function dueKey(statsId: string, month: string): string {
  return `nl:aff:payday:due:${statsId}:${month}`;
}

/**
 * Marks the store's payday as reached by its own day's run. A mark that cannot be written only means no catch-up
 * if this run fails too: the store then waits for next month, as before the catch-up.
 */
async function markDue(statsId: string, month: string): Promise<void> {
  await redisPipeline([["SET", dueKey(statsId, month), "1", "NX", "EX", CLAIM_SECONDS]]).catch(() => undefined);
}

/**
 * The payday a run on `now` is for, if any: today's, or one up to PAYDAY_CATCH_UP_DAYS back (in its own month,
 * so a payday on the 28th caught up on the 1st is still the earlier month's), with how many days late it is.
 */
export function paydayDue(payday: number, now: Date): { month: string; late: number } | null {
  for (let late = 0; late <= PAYDAY_CATCH_UP_DAYS; late += 1) {
    const day = new Date(now.getTime() - late * 86_400_000);
    if (day.getUTCDate() === payday) return { month: monthOf(day), late };
  }
  return null;
}

/**
 * Whether a missed-looking payday is one to catch up: its own day's run reached the store (the due mark) and did not
 * handle it (no claim on the month, which an email that went or a payday that found nobody owed both write). Read
 * exactly (CX-123 rule 24): any answer but a count of 0 or 1 throws, and the store is counted as failed this run and
 * looked at again tomorrow, never paid on a guess.
 */
async function toCatchUp(statsId: string, month: string): Promise<boolean> {
  const replies = repliesFor(await redisPipeline([["EXISTS", dueKey(statsId, month)], ["EXISTS", claimKey(statsId, month)]]), 2);
  const [due, claimed] = [countOf(replies?.[0]), countOf(replies?.[1])];
  if ((due !== 0 && due !== 1) || (claimed !== 0 && claimed !== 1)) throw new UnknownReplyError("whether a store's payday was handled");
  return due === 1 && claimed === 0;
}

/** The message itself. Plain text, so every word is what arrives. */
export function paydayEmail(input: {
  storeName: string;
  payday: number;
  people: number;
  totalCents: number;
  currency: string;
  waitingCents: number;
  hold: number;
  refundsChecked: boolean;
  /** Of what is waiting, the leads in hold or waiting for the creator's approval (lib/affiliate-leads.ts). */
  leadsCents?: number;
  /** Days since the payday, when it is caught up after a run that did not finish it (PAYDAY_CATCH_UP_DAYS). */
  late?: number;
  /** A caught-up payday of a store that pays by itself: nothing is paid late by us, and the email says so. */
  autoSkipped?: boolean;
}): { subject: string; text: string } {
  // What can be paid today, not what is owed in all: when a wait is set the
  // two differ, and a subject line that calls the smaller number "owed" tells
  // the creator something untrue about their own book.
  const amount = formatMoney(input.totalCents, input.currency);
  const who = `${input.people} ${input.people === 1 ? "affiliate" : "affiliates"}`;
  const studio = `${SITE_URL}/studio/affiliates`;
  const lines = [
    "Hello,",
    "",
    input.late
      ? `The ${ordinal(input.payday)}, ${daysAgo(input.late)}, was the day you told your affiliates you pay them. We could not finish this email that day, so here it is now. ${who} can be paid ${amount}.`
      : `Today is the ${ordinal(input.payday)}, the day you told your affiliates you pay them. ${who} can be paid ${amount}.`,
    ...(input.autoSkipped
      ? ["", "You asked us to pay them by ourselves on payday. That did not happen on the day, and we do not pay late by ourselves, in case you have paid them since. If you have not, pay them with one press on your affiliate page, or download the batch."]
      : []),
    "",
    "Open your affiliate page, download the batch, and upload it to your own PayPal or Wise. The money goes straight from your account to theirs — it never passes through us, so there is nothing to wait for once you have sent it:",
    studio,
    "",
    "When it has gone out, mark the batch as paid on that same page. Each affiliate then sees it on their own page, with the date and your reference.",
  ];
  const leads = Math.max(0, Math.min(input.leadsCents ?? 0, input.waitingCents));
  if (input.waitingCents - leads > 0) {
    lines.push(
      "",
      `A further ${formatMoney(input.waitingCents - leads, input.currency)} is owed but still inside your ${input.hold}-day wait, so it is not in this batch. It joins the next one.`,
    );
  }
  if (leads > 0) {
    lines.push(
      "",
      `${formatMoney(leads, input.currency)} more is for leads still in their hold or waiting for your approval on the same page, so it is not in this batch either. A lead joins a batch once you approve it.`,
    );
  }
  if (!input.refundsChecked) {
    lines.push(
      "",
      "One thing first: we could not check every refund on your Stripe account just now, so these figures are not settled. Open the page and look before you pay — it will have checked again by then.",
    );
  }
  lines.push("", "— Marktmorgen");
  return { subject: input.late ? `${amount} to pay your affiliates` : `${amount} to pay your affiliates today`, text: lines.join("\n") };
}

/** "yesterday", "2 days ago". */
function daysAgo(late: number): string {
  return late === 1 ? "yesterday" : `${late} days ago`;
}

/** The payday email of a store that pays by itself: what PayPal was asked to send, or why not. */
export function autoPayEmail(paid: Awaited<ReturnType<typeof payWithPayPal>>, currency: string, late = 0): { subject: string; text: string } {
  const studio = `${SITE_URL}/studio/affiliates`;
  // Caught up after a run that did not finish the payday (PAYDAY_CATCH_UP_DAYS): never "it is your payday" on another day.
  const opening = late ? `Your affiliate payday was ${daysAgo(late)}` : "It is your affiliate payday";
  if (paid.ok) {
    const amount = formatMoney(paid.cents, currency);
    const who = `${paid.people} ${paid.people === 1 ? "affiliate" : "affiliates"}`;
    return {
      subject: `${amount} sent to ${who} from your PayPal`,
      text: [
        "Hello,",
        "",
        `${opening}, and you asked us to pay by ourselves. ${amount} went to ${who} from your own PayPal, in PayPal batch ${paid.batch}.`,
        "",
        "Each payment shows as paid on your affiliate page, and on the affiliate's own page, as soon as PayPal confirms it. Anyone PayPal cannot pay stays owed, to be paid again. The money went from your PayPal to theirs; it never passed through us.",
        studio,
        "",
        "— Marktmorgen",
      ].join("\n"),
    };
  }
  if (paid.reason === "unknown") {
    return {
      subject: "Check your PayPal: your affiliates' payment may have gone",
      text: [
        "Hello,",
        "",
        `${opening}, and you asked us to pay by ourselves. We sent the batch to PayPal, but PayPal's answer did not reach us, so we do not know whether it was paid.`,
        "",
        "Nobody in it will be paid again by us while this is not known: they show as on their way on your affiliate page. Look at your PayPal activity to see whether the payment went.",
        studio,
        "",
        "— Marktmorgen",
      ].join("\n"),
    };
  }
  const why: Record<string, string> = {
    funds: "your PayPal balance did not cover it. Add money to your PayPal balance",
    refused: "PayPal refused the app you connected. Connect it again, with Payouts switched on",
    reconnect: "the app you connected has to be connected again",
    "not-connected": "no PayPal app is connected",
    busy: "another payment was being sent at the same moment",
    refunds: "we could not check every refund on your Stripe account just now",
    nothing: "nobody is owed anything that has cleared",
    error: "PayPal could not be reached",
  };
  return {
    subject: late ? "Your affiliates were not paid" : "Your affiliates were not paid today",
    text: [
      "Hello,",
      "",
      `${opening}, and nothing was sent: ${why[paid.reason] ?? why.error}. Nothing left your PayPal.`,
      "",
      "Open your affiliate page to pay them with one press, or download the batch for PayPal or Wise:",
      studio,
      "",
      "— Marktmorgen",
    ].join("\n"),
  };
}

/** One store, on its payday (or that payday caught up `late` days after), if anybody is owed. True when sent. */
async function payday(store: Store, month: string, late: number): Promise<boolean> {
  if (!affiliatesOn(store)) return false;
  if (!store.statsId || !store.email) return false;
  // On the payday itself, the store is marked as reached before anything can fail, so a run that fails here can be
  // caught up. A payday caught up only when that day's run reached the store and did not handle it: never twice,
  // never for a payday that was not in force on its day, never for a store with nobody owed.
  if (late === 0) await markDue(store.statsId, month);
  else if (!(await toCatchUp(store.statsId, month))) return false;
  const book = await readBook(store);
  // Anyone with a PayPal payment already on its way is not due again.
  const lines = payableLines(book, await onTheirWay(store));
  // Nobody to pay is not a message worth sending. The month is claimed all
  // the same (the job runs once a day, so no later run that day could send
  // it), so the days after do not catch this payday up when a sale clears:
  // that sale joins next month's batch, as before. A claim that cannot be
  // written only means one more look tomorrow.
  if (lines.length === 0) {
    await claimMark(claimKey(store.statsId, month), CLAIM_SECONDS).catch(() => undefined);
    return false;
  }
  // Claimed last, so that whichever run gets here first is the only one that
  // sends. A second run reads the same book and stops here.
  if (!(await claimMonth(store.statsId, month))) return false;
  // Paying by itself, from the creator's own PayPal (lib/paypal-payouts.ts):
  // the email then says what was sent, or why it could not be.
  // Never late (Claude 1 cloud on #4255): a creator who saw nothing go on the day may have paid the batch by hand
  // since, and a payment they made leaves no record here, so a late automatic payout could pay everyone twice.
  const auto = await paysAutomatically(store);
  if (late === 0 && book.refundsChecked && auto) {
    const paid = await payWithPayPal(store);
    const { subject, text } = autoPayEmail(paid, book.currency, late);
    return sendEmail({ meter: { by: "store", store: store, kind: "email" }, from: NIMBUS_FROM, to: store.email, subject, text, idempotencyKey: `aff-payday-${store.statsId}-${month}` });
  }
  const { subject, text } = paydayEmail({
    storeName: store.name,
    payday: store.affiliates.payday,
    people: lines.length,
    totalCents: batchTotal(lines),
    currency: book.currency,
    waitingCents: book.rows.reduce((sum, row) => sum + row.waiting, 0),
    hold: store.affiliates.hold,
    refundsChecked: book.refundsChecked,
    leadsCents: book.lines.filter((l) => l.how === "lead" && l.status !== "approved" && l.currency === book.currency).reduce((sum, l) => sum + l.commission, 0),
    late,
    autoSkipped: late > 0 && auto,
  });
  return sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: NIMBUS_FROM,
    to: store.email,
    subject,
    text,
    idempotencyKey: `aff-payday-${store.statsId}-${month}`,
  });
}

/**
 * Every store, once, for whichever of them pays today, and for any whose
 * payday in the last PAYDAY_CATCH_UP_DAYS a run did not finish. `deadline` is
 * when the run has to stop whatever it has reached; the next run (tomorrow:
 * the job runs once a day) starts again from the beginning, and the month's
 * claim keeps anybody already emailed from being emailed twice.
 */
export async function sendPaydayEmails(deadline: number, now = new Date()): Promise<PaydayCounts> {
  const counts: PaydayCounts = { seen: 0, due: 0, sent: 0, failed: 0, complete: false };
  if (!isRedisConfigured() || !isSenderConfigured()) return counts;
  let cursor = "0";
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (Date.now() >= deadline) return counts;
    const { stores, next } = await storesAfter(cursor);
    for (const store of stores) {
      counts.seen += 1;
      const due = paydayDue(store.affiliates.payday, now);
      if (!due) continue;
      counts.due += 1;
      try {
        if (await payday(store, due.month, due.late)) counts.sent += 1;
      } catch (error) {
        counts.failed += 1;
        console.error("sending an affiliate payday email failed", error);
      }
    }
    cursor = next;
    if (cursor === "0") break;
  }
  counts.complete = true;
  return counts;
}
