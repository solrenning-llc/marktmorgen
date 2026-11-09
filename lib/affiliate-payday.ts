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
import { isRedisConfigured } from "@/lib/redis";
import { claimMark } from "@/lib/claim-mark";
import { UnknownReplyError } from "@/lib/redis-reply";
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
  const got = await claimMark(`nl:aff:payday:${statsId}:${month}`, CLAIM_SECONDS);
  if (got === "unknown") throw new UnknownReplyError("a store's payday claim");
  return got === "ours";
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
    `Today is the ${ordinal(input.payday)}, the day you told your affiliates you pay them. ${who} can be paid ${amount}.`,
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
  return { subject: `${amount} to pay your affiliates today`, text: lines.join("\n") };
}

/** The payday email of a store that pays by itself: what PayPal was asked to send, or why not. */
export function autoPayEmail(paid: Awaited<ReturnType<typeof payWithPayPal>>, currency: string): { subject: string; text: string } {
  const studio = `${SITE_URL}/studio/affiliates`;
  if (paid.ok) {
    const amount = formatMoney(paid.cents, currency);
    const who = `${paid.people} ${paid.people === 1 ? "affiliate" : "affiliates"}`;
    return {
      subject: `${amount} sent to ${who} from your PayPal`,
      text: [
        "Hello,",
        "",
        `It is your affiliate payday, and you asked us to pay by ourselves. ${amount} went to ${who} from your own PayPal, in PayPal batch ${paid.batch}.`,
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
        "It is your affiliate payday, and you asked us to pay by ourselves. We sent the batch to PayPal, but PayPal's answer did not reach us, so we do not know whether it was paid.",
        "",
        "Nobody in it will be paid again by us while this is not known: they show as on their way on your affiliate page. Look at your PayPal activity to see whether the payment went.",
        studio,
        "",
        "— Marktmorgen",
      ].join("\n"),
    };
  }
  if (paid.reason === "pending") {
    return {
      subject: "Your affiliates' payment may still go out from your PayPal",
      text: [
        "Hello,",
        "",
        "It is your affiliate payday, and you asked us to pay by ourselves. We could not confirm that the batch was saved, so we did not send it now. If it was saved, our daily check sends it within a day, from your PayPal, to the same people for the same amounts.",
        "",
        "Until then, they show as on their way on your affiliate page. Do not pay them another way, or they could be paid twice.",
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
    subject: "Your affiliates were not paid today",
    text: [
      "Hello,",
      "",
      `It is your affiliate payday, and nothing was sent: ${why[paid.reason] ?? why.error}. Nothing left your PayPal.`,
      "",
      "Open your affiliate page to pay them with one press, or download the batch for PayPal or Wise:",
      studio,
      "",
      "— Marktmorgen",
    ].join("\n"),
  };
}

/** One store, if today is its payday and anybody is owed. True when sent. */
async function payday(store: Store, month: string, dayOfMonth: number): Promise<boolean> {
  if (!affiliatesOn(store) || store.affiliates.payday !== dayOfMonth) return false;
  if (!store.statsId || !store.email) return false;
  const book = await readBook(store);
  // Anyone with a PayPal payment already on its way is not due again.
  const lines = payableLines(book, await onTheirWay(store));
  // Nobody to pay is not a message worth sending, and it must not spend the
  // month's claim either: a sale that lands later today should still be able
  // to bring the email.
  if (lines.length === 0) return false;
  // Claimed last, so that whichever run gets here first is the only one that
  // sends. A second run reads the same book and stops here.
  if (!(await claimMonth(store.statsId, month))) return false;
  // Paying by itself, from the creator's own PayPal (lib/paypal-payouts.ts):
  // the email then says what was sent, or why it could not be.
  if (book.refundsChecked && (await paysAutomatically(store))) {
    const paid = await payWithPayPal(store);
    const { subject, text } = autoPayEmail(paid, book.currency);
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
 * Every store, once, for whichever of them pays today. `deadline` is when the
 * run has to stop whatever it has reached; the next run starts again from the
 * beginning, and the month's claim keeps anybody already emailed from being
 * emailed twice.
 */
export async function sendPaydayEmails(deadline: number, now = new Date()): Promise<PaydayCounts> {
  const counts: PaydayCounts = { seen: 0, due: 0, sent: 0, failed: 0, complete: false };
  if (!isRedisConfigured() || !isSenderConfigured()) return counts;
  const month = monthOf(now);
  const dayOfMonth = now.getUTCDate();
  let cursor = "0";
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (Date.now() >= deadline) return counts;
    const { stores, next } = await storesAfter(cursor);
    for (const store of stores) {
      counts.seen += 1;
      if (store.affiliates.payday !== dayOfMonth) continue;
      counts.due += 1;
      try {
        if (await payday(store, month, dayOfMonth)) counts.sent += 1;
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
