/**
 * A member moving the day their own membership is charged: the rules only
 * (lib/billing-day-rules.ts; 630 [HN6], item 13, unit 1). Synthetic
 * subscriptions only; nothing here reaches Stripe. Checked:
 *
 *   - every refusal: the schedule, a trial, a payment behind, other states,
 *     a pause, an end, a payment plan, items, a discount (on the
 *     subscription, an item or the customer), an affiliate's share for set
 *     months, a schedule or pending update, a last invoice not paid, a
 *     customer balance, a payment method that is not a card, a billing mode
 *     not read (flexible, until proven), a change
 *     waiting, and once a billing period, counted only by completed changes;
 *   - the days offered: 1 to 28, never the day paid on now, only before the
 *     payment already due and at least a day ahead;
 *   - the date math: noon where the member lives, across month ends (31st to
 *     28th), leap years and daylight-saving changes, and the payments after
 *     wherever in its window the change really ran;
 *   - the request is signed (HMAC-SHA256 here under a synthetic key, as the
 *     server will): an edited amount, ceiling or moment, or a request copied
 *     from another subscription or customer, is read as no request;
 *   - when a waiting change may run (`mayRun`, the only door): never when the
 *     period changed since the request, never when the fresh preview at run
 *     time is above the ceiling (the full new period with its tax, here 27%
 *     on top), and never with pending invoice items or a balance on the
 *     invoice; above the amount shown but under the ceiling, it may;
 *   - the amount shown is the preview's whole amount_due, and its ceiling
 *     the sum of its lines that are not prorations, with their tax;
 *   - after a declined change, the sweep's query (a minute's leeway), every
 *     invoice to clear and how (`invoicesToVoid`: drafts stopped, then
 *     deleted; open ones voided; unrelated ones left), the signed sweep
 *     marker that keeps the member refused until a later sweep finds
 *     nothing (`sweepAction`), kept through a refused or lapsed request's
 *     cleanup, due on its own schedule (`sweepDue`), and the refusal while
 *     any open or draft
 *     invoice is known or the list was not read;
 *   - after a 402, paid invoices of the change refunded in full, the 402's
 *     own invoice kept in the marker and re-read by id, invoices listed by
 *     the customer too, a five-minute window, and the sweep's schedule
 *     (`nextSweepAt`, slower after the limit; an unsigned marker due at once);
 *   - the server's record of the last change winning over a tampered one;
 *   - a send with no confirmed result: its record, the resend with the
 *     same key, the window from the first send, `mayClearRequest` and
 *     `moveApplied`; the server's copy of the marker holding when the
 *     metadata's is gone, and a stale sweep never clearing a newer marker;
 *     an unlinked invoice tied to the 402 only by its payment;
 *   - after the change, the excess above the ceiling to refund
 *     (`overCeiling`);
 *   - the last change made is signed: an edit only refuses, never allows;
 *   - flexible billing refused, with its own reason "mode", while
 *     `FLEXIBLE_MOVE_PROVEN` is false, and
 *     a metered price refused;
 *   - the Stripe request bodies, the metadata cleared after a declined or
 *     lapsed run, the idempotency key, and the words shown before confirming.
 */
import {
  FIRST_DAY,
  FLEXIBLE_MOVE_PROVEN,
  LAST_DAY,
  META_AT,
  META_CEILING,
  META_DONE,
  META_DONE_SIG,
  META_END,
  META_MONTHS,
  META_ON,
  META_PRICE,
  META_SHOWN,
  META_SIG,
  META_SWEEP,
  META_SWEEP_SIG,
  MOVE_GRACE_SECONDS,
  MOVE_LEAD_SECONDS,
  RUN_SKEW_SECONDS,
  SWEEP_MAX_SECONDS,
  SWEEP_WINDOW_SECONDS,
  SWEEP_AGAIN_SECONDS,
  type BillingDaySub,
  type MoveContext,
  type MovePreview,
  type RequestVerifier,
  cannotMove,
  ceilingOf,
  cannotRun,
  clearRequestBody,
  clearSweepBody,
  currentDay,
  dateWords,
  doneSigText,
  daysOffered,
  invoicesToVoid,
  lastDone,
  localNoon,
  localParts,
  mayRun,
  moveBody,
  moveIdempotencyKey,
  moveDue,
  moveInstant,
  moveOn,
  moveWords,
  ordinal,
  refusalWords,
  type RunOutcome,
  overCeiling,
  paymentsAfter,
  pendingMove,
  periodKnown,
  periodMonths,
  previewAmount,
  previewCeiling,
  previewMoveBody,
  previewRefusal,
  requestMeta,
  requestSigText,
  runPreviewRefusal,
  shownOf,
  stopAdvanceBody,
  sweepAction,
  sweepDue,
  sweepMarkBody,
  sweepMarker,
  sweepQueries,
  sweepMarkInvoiceBody,
  sweepMarkerBody,
  sendRecordFor,
  sendResult,
  mayResend,
  moveApplied,
  mayClearRequest,
  finalizeBody,
  RESEND_MAX_SECONDS,
  nextSweepAt,
  refundBody,
  refundIdempotencyKey,
  SWEEP_SLOW_SECONDS,
  SWEEP_SKEW_SECONDS,
  RUN_END_CLEAR_SECONDS,
  sweepSigText,
  withinCeiling,
  zoneOf,
} from "@/lib/billing-day-rules";
import { RECURRING_ALWAYS } from "@/lib/affiliate-setting";
import { addMonths } from "@/lib/membership-pause-rules";
import { createHmac, timingSafeEqual } from "node:crypto";
import { done, is, part } from "./check";

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const DAY = 86_400;

// The server's signer and verifier, as the route will build them: HMAC-SHA256
// under a key of this feature's own (here a synthetic one), compared with
// timingSafeEqual.
const KEY = Buffer.from("synthetic billing-day-request key, tests only");
const sign = (text: string) => createHmac("sha256", KEY).update(text).digest("hex");
const verify: RequestVerifier = (text, sig) =>
  /^[0-9a-f]{64}$/.test(sig) && timingSafeEqual(Buffer.from(sign(text), "hex"), Buffer.from(sig, "hex"));
/** What the route read beside the subscription: no open or draft invoice of it. */
const ctx: MoveContext = { verify, openInvoices: [] };
/** The last change made, signed as the change writes it. */
const doneAt = (base: BillingDaySub, t: number) => ({ [META_DONE]: String(t), [META_DONE_SIG]: sign(doneSigText(base, String(t))!) });

/** The last invoice, paid, for one period of the item's price ($10.00). */
const LAST = {
  id: "in_1",
  status: "paid",
  lines: { data: [{ amount: 1000, pricing: { price_details: { price: "price_1" } }, parent: { type: "subscription_item_details", subscription_item_details: { proration: false } } }] },
};

/** A licensed monthly price of $10.00, as Stripe reads it. */
const PRICE = { id: "price_1", unit_amount: 1000, recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } };

function sub(over: Partial<BillingDaySub> & { interval?: string; count?: number; end?: number } = {}): BillingDaySub {
  const { interval = "month", count = 1, end = at("2026-11-20T15:00:00Z"), ...rest } = over;
  const start = addMonths(end, interval === "year" ? -12 : -1);
  return {
    id: "sub_1",
    status: "active",
    billing_mode: { type: "classic" },
    cancel_at: null,
    cancel_at_period_end: false,
    pause_collection: null,
    discount: null,
    discounts: [],
    schedule: null,
    pending_update: null,
    collection_method: "charge_automatically",
    latest_invoice: LAST,
    default_payment_method: { id: "pm_1", type: "card" },
    customer: { id: "cus_1", balance: 0, discount: null, invoice_settings: { default_payment_method: null } },
    metadata: { store: "shop" },
    items: { data: [{ quantity: 1, discounts: [], current_period_start: start, current_period_end: end, price: { id: "price_1", unit_amount: 1000, recurring: { interval, interval_count: count, usage_type: "licensed" } } }] },
    ...rest,
  };
}

/** The same subscription with its one item changed. */
function withItem(base: BillingDaySub, item: Record<string, unknown>): BillingDaySub {
  return { ...base, items: { data: [{ ...base.items!.data![0], ...item }] } };
}

const NOW = at("2026-11-04T12:00:00Z");

/** A request as the server writes it, signed; the amount shown and the ceiling in cents. */
function req(base: BillingDaySub, on: number, shown = 667, ceiling = 1270, now = NOW): Record<string, string> {
  const meta = requestMeta(base, on, shown, ceiling, now, sign);
  if (!meta) throw new Error("no request");
  return meta;
}

/** Metadata signed again after an edit, as only the server could. */
function resigned(base: BillingDaySub, meta: Record<string, string>): Record<string, string> {
  return { ...meta, [META_SIG]: sign(requestSigText(base, meta)!) };
}

part("Who may move the day");
is("a monthly membership running normally may", cannotMove(sub(), NOW, ctx), null);
is("a yearly one may", cannotMove(sub({ interval: "year", end: at("2027-06-15T10:00:00Z") }), NOW, ctx), null);
is("periodMonths: monthly", periodMonths(sub()), 1);
is("periodMonths: yearly", periodMonths(sub({ interval: "year" })), 12);
is("weekly is refused", cannotMove(sub({ interval: "week" }), NOW, ctx), "interval");
is("every three months is refused", cannotMove(sub({ count: 3 }), NOW, ctx), "interval");
is("no price schedule is refused", cannotMove({ ...sub(), items: { data: [{ quantity: 1, current_period_end: NOW + DAY, price: { recurring: null } }] } }, NOW, ctx), "interval");
is("in a trial is refused", cannotMove(sub({ status: "trialing" }), NOW, ctx), "trial");
is("past due is refused", cannotMove(sub({ status: "past_due" }), NOW, ctx), "behind");
is("unpaid is refused", cannotMove(sub({ status: "unpaid" }), NOW, ctx), "behind");
is("incomplete is refused", cannotMove(sub({ status: "incomplete" }), NOW, ctx), "state");
is("canceled is refused", cannotMove(sub({ status: "canceled" }), NOW, ctx), "state");
is("paused is refused", cannotMove(sub({ status: "paused" }), NOW, ctx), "state");
is("payments paused is refused", cannotMove(sub({ pause_collection: { behavior: "void", resumes_at: NOW + 30 * DAY } }), NOW, ctx), "paused");
is("a pause set to start is refused", cannotMove(sub({ metadata: { pause_from: String(NOW + 10 * DAY) } }), NOW, ctx), "paused");
is("set to end at the period's end is refused", cannotMove(sub({ cancel_at_period_end: true }), NOW, ctx), "ending");
is("set to end on a date is refused", cannotMove(sub({ cancel_at: NOW + 40 * DAY }), NOW, ctx), "ending");
is("sold to end after a set number of payments is refused", cannotMove(sub({ metadata: { ends_after: "6" } }), NOW, ctx), "fixed");
is("a payment plan is refused", cannotMove(sub({ metadata: { kind: "plan" } }), NOW, ctx), "plan");
is("two items are refused", cannotMove({ ...sub(), items: { data: [sub().items!.data![0], sub().items!.data![0]] } }, NOW, ctx), "items");
is("no items: no price schedule to read, refused", cannotMove({ ...sub(), items: { data: [] } }, NOW, ctx), "interval");
is("two of one item are refused", cannotMove({ ...sub(), items: { data: [{ ...sub().items!.data![0], quantity: 2 }] } }, NOW, ctx), "items");
is("a discount is refused", cannotMove(sub({ discount: { id: "di_1" } }), NOW, ctx), "discount");
is("discounts are refused", cannotMove(sub({ discounts: ["di_1"] }), NOW, ctx), "discount");
is("a discount on the item is refused", cannotMove(withItem(sub(), { discounts: ["di_item_3_months"] }), NOW, ctx), "discount");
is("a discount on the customer is refused", cannotMove(sub({ customer: { id: "cus_1", balance: 0, discount: { id: "di_c" } } }), NOW, ctx), "discount");
is("a last invoice still open is refused", cannotMove(sub({ latest_invoice: { id: "in_1", status: "open", amount_remaining: 1000 } }), NOW, ctx), "invoice");
is("a last invoice not read (not expanded) is refused", cannotMove(sub({ latest_invoice: "in_1" }), NOW, ctx), "invoice");
is("no last invoice is refused", cannotMove(sub({ latest_invoice: null }), NOW, ctx), "invoice");
const lastLine = (o: Record<string, unknown>) => ({ ...LAST, lines: { data: [{ ...LAST.lines.data[0], ...o }] } });
is("the last invoice paid the price at $10.00: may move", cannotMove(sub(), NOW, ctx), null);
is("the older line shape (price on the line) is read too", cannotMove(sub({ latest_invoice: lastLine({ pricing: undefined, price: { id: "price_1" } }) }), NOW, ctx), null);
is("the last invoice paid another price (changed mid-period): refused", cannotMove(sub({ latest_invoice: lastLine({ pricing: { price_details: { price: "price_0" } } }) }), NOW, ctx), "changed");
is("the last invoice paid another amount: refused", cannotMove(sub({ latest_invoice: lastLine({ amount: 800 }) }), NOW, ctx), "changed");
is("a last invoice of prorations only: refused", cannotMove(sub({ latest_invoice: lastLine({ amount: -200, parent: { subscription_item_details: { proration: true } } }) }), NOW, ctx), "changed");
is("a last invoice with more lines than one page: refused", cannotMove(sub({ latest_invoice: { ...LAST, lines: { ...LAST.lines, has_more: true } } }), NOW, ctx), "changed");
is("a last invoice whose lines were not read: refused", cannotMove(sub({ latest_invoice: { id: "in_1", status: "paid" } }), NOW, ctx), "changed");
is(
  "a last invoice with two periods: refused",
  cannotMove(sub({ latest_invoice: { ...LAST, lines: { data: [LAST.lines.data[0], LAST.lines.data[0]] } } }), NOW, ctx),
  "changed",
);
is("a customer who owes a balance is refused", cannotMove(sub({ customer: { id: "cus_1", balance: 500 } }), NOW, ctx), "balance");
is("a customer holding a credit is refused", cannotMove(sub({ customer: { id: "cus_1", balance: -500 } }), NOW, ctx), "balance");
is("a customer not read (not expanded) is refused", cannotMove(sub({ customer: "cus_1" }), NOW, ctx), "balance");
is("a deleted customer is refused", cannotMove(sub({ customer: { id: "cus_1", deleted: true } }), NOW, ctx), "state");
is("a bank debit that settles later is refused", cannotMove(sub({ default_payment_method: { id: "pm_1", type: "us_bank_account" } }), NOW, ctx), "card");
is("a SEPA debit is refused", cannotMove(sub({ default_payment_method: { id: "pm_1", type: "sepa_debit" } }), NOW, ctx), "card");
is("a payment method not read (not expanded) is refused", cannotMove(sub({ default_payment_method: "pm_1" }), NOW, ctx), "card");
is(
  "the customer's default card is read when the subscription has none",
  cannotMove(sub({ default_payment_method: null, customer: { id: "cus_1", balance: 0, invoice_settings: { default_payment_method: { id: "pm_2", type: "card" } } } }), NOW, ctx),
  null,
);
is(
  "the customer's default bank debit is refused",
  cannotMove(sub({ default_payment_method: null, customer: { id: "cus_1", balance: 0, invoice_settings: { default_payment_method: { id: "pm_2", type: "us_bank_account" } } } }), NOW, ctx),
  "card",
);
is("an old source that is not a card is refused", cannotMove(sub({ default_payment_method: null, default_source: "src_1" }), NOW, ctx), "card");
is("an old card source is a card", cannotMove(sub({ default_payment_method: null, default_source: "card_1" }), NOW, ctx), null);
is("an old card source, expanded, is a card", cannotMove(sub({ default_payment_method: null, default_source: { id: "card_1", object: "card" } }), NOW, ctx), null);
is("an expanded source that is not a card is refused", cannotMove(sub({ default_payment_method: null, default_source: { id: "ba_1", object: "bank_account" } }), NOW, ctx), "card");
is("no payment method at all is refused", cannotMove(sub({ default_payment_method: null }), NOW, ctx), "card");
is(
  "an affiliate share for a set number of months, still running, is refused",
  cannotMove(sub({ metadata: { via: "ann", via_months: "3", via_at: String(NOW - 30 * DAY) } }), NOW, ctx),
  "affiliate",
);
is(
  "an affiliate share whose months are over is not",
  cannotMove(sub({ metadata: { via: "ann", via_months: "3", via_at: String(NOW - 200 * DAY) } }), NOW, ctx),
  null,
);
is(
  "an affiliate share for as long as the member pays is not",
  cannotMove(sub({ metadata: { via: "ann", via_months: String(RECURRING_ALWAYS), via_at: String(NOW - 30 * DAY) } }), NOW, ctx),
  null,
);
is("a subscription schedule is refused", cannotMove(sub({ schedule: "sub_sched_1" }), NOW, ctx), "managed");
is("a pending update is refused", cannotMove(sub({ pending_update: { expires_at: NOW + DAY } }), NOW, ctx), "managed");
is("paying by invoice is refused", cannotMove(sub({ collection_method: "send_invoice" }), NOW, ctx), "managed");
is("no period end known is refused", cannotMove({ ...sub(), items: { data: [{ quantity: 1, price: PRICE }] } }, NOW, ctx), "state");
is("classic: the period end on the subscription is read when the item has none", cannotMove({ ...sub(), billing_mode: { type: "classic" }, current_period_end: NOW + 10 * DAY, items: { data: [{ quantity: 1, price: PRICE }] } }, NOW, ctx), null);

part("Once a billing period, counted by completed changes, and one change waiting at a time");
const waiting = sub({ metadata: req(sub(), NOW + 3 * DAY) });
is("a change waiting refuses another", cannotMove(waiting, NOW, ctx), "pending");
is("pendingMove reads it", pendingMove(waiting, NOW, verify), NOW + 3 * DAY);
is("changed 10 days ago on a monthly membership: refused", cannotMove(sub({ metadata: doneAt(sub(), NOW - 10 * DAY) }), NOW, ctx), "recent");
is("changed a calendar month ago less one second: refused", cannotMove(sub({ metadata: doneAt(sub(), at("2026-10-04T12:00:01Z")) }), NOW, ctx), "recent");
is("changed exactly a calendar month ago: allowed", cannotMove(sub({ metadata: doneAt(sub(), at("2026-10-04T12:00:00Z")) }), NOW, ctx), null);
is("yearly, changed 200 days ago: refused", cannotMove(sub({ interval: "year", end: at("2027-06-15T10:00:00Z"), metadata: doneAt(sub(), NOW - 200 * DAY) }), NOW, ctx), "recent");
is("yearly, changed 370 days ago: allowed", cannotMove(sub({ interval: "year", end: at("2027-06-15T10:00:00Z"), metadata: doneAt(sub(), NOW - 370 * DAY) }), NOW, ctx), null);
is("asked 10 days ago, never completed: allowed", cannotMove(sub({ metadata: { [META_AT]: String(NOW - 10 * DAY) } }), NOW, ctx), null);
{
  // Asked on November 4; the run on November 10 was declined (402: Stripe
  // changed nothing, so the request stays in the metadata) or it lapsed.
  const lapsedOn = at("2026-11-10T12:00:00Z");
  const lapsed = sub({ metadata: req(sub(), lapsedOn) });
  const later = lapsedOn + MOVE_GRACE_SECONDS + 60;
  is("a lapsed request not yet cleared still waits: the member may not ask a second time", cannotMove(lapsed, later, ctx), "pending");
  const lapsedCleared = sub({ metadata: { store: "shop" } });
  is("once the route clears it, the member may ask again", cannotMove(lapsedCleared, later, ctx), null);
  is("and days are offered again", daysOffered(lapsedCleared, "UTC", later, ctx).length > 0, true);
  is("while its grace runs, it still waits", cannotMove(lapsed, lapsedOn + 60, ctx), "pending");
}
is("a stale change, past its grace, no longer waits", pendingMove(sub({ metadata: req(sub(), NOW - MOVE_GRACE_SECONDS - 1) }), NOW, verify), null);
is("a garbled request is read as nothing", cannotMove(sub({ metadata: { [META_ON]: "x", [META_SIG]: "zz" } }), NOW, ctx), null);
is("a garbled last change is read as made just now: refused, never allowed", cannotMove(sub({ metadata: { [META_DONE]: "soon" } }), NOW, ctx), "recent");
{
  const old = doneAt(sub(), NOW - 40 * DAY);
  is("a signed last change long ago: allowed", cannotMove(sub({ metadata: old }), NOW, ctx), null);
  is("its time moved back by an edit: read as just now, refused", cannotMove(sub({ metadata: { ...old, [META_DONE]: String(NOW - 400 * DAY) } }), NOW, ctx), "recent");
  is("its time deleted, its signature left: read as just now, refused", cannotMove(sub({ metadata: { [META_DONE_SIG]: old[META_DONE_SIG] } }), NOW, ctx), "recent");
  is("its signature deleted, its time left: read as just now, refused", cannotMove(sub({ metadata: { [META_DONE]: old[META_DONE] } }), NOW, ctx), "recent");
  is("copied from another subscription: read as just now, refused", cannotMove(sub({ id: "sub_2", metadata: old }), NOW, ctx), "recent");
  is("lastDone: signed is read, none is 0, edited is now", [lastDone(sub({ metadata: old }), NOW, verify), lastDone(sub(), NOW, verify), lastDone(sub({ metadata: { ...old, [META_DONE]: "1700000000" } }), NOW, verify)], [NOW - 40 * DAY, 0, NOW]);
  is("the text signed for the last change", doneSigText(sub(), "1700000000"), "billing-day-done:v1|sub_1|cus_1|1700000000");
  const tampered = sub({ metadata: { ...old, [META_DONE]: String(NOW - 400 * DAY) } });
  is("a tampered record with the server's own: the server's wins, not \"now\" forever", lastDone(tampered, NOW, verify, NOW - 40 * DAY), NOW - 40 * DAY);
  is("so the member may change once a period has passed by the server's record", cannotMove(tampered, NOW, { ...ctx, lastDone: NOW - 40 * DAY }), null);
  is("and is refused while it has not", cannotMove(tampered, NOW, { ...ctx, lastDone: NOW - 10 * DAY }), "recent");
  is("deleted from the metadata, the server's record still refuses", cannotMove(sub(), NOW, { ...ctx, lastDone: NOW - 10 * DAY }), "recent");
  is("an older signed pair put back loses to the server's newer record", lastDone(sub({ metadata: old }), NOW, verify, NOW - 5 * DAY), NOW - 5 * DAY);
  is("a server record that is not a whole time is not read", lastDone(tampered, NOW, verify, 12.5), NOW);
  is("a server record of 0 (never changed) does not unlock a tampered one", lastDone(tampered, NOW, verify, 0), NOW);
}
is("nothing is offered while refused", daysOffered(sub({ status: "trialing" }), "UTC", NOW, ctx), []);

part("The days offered (UTC)");
const monthly = sub();
is("current day is the 20th", currentDay(monthly, "UTC"), 20);
is("day 0 is not offered", moveOn(monthly, 0, "UTC", NOW), null);
is("day 29 is not offered", moveOn(monthly, 29, "UTC", NOW), null);
is("day 31 is not offered", moveOn(monthly, 31, "UTC", NOW), null);
is("a fraction is not offered", moveOn(monthly, 10.5, "UTC", NOW), null);
is("the day paid on now is not offered", moveOn(monthly, 20, "UTC", NOW), null);
is("the 10th: noon on November 10", moveOn(monthly, 10, "UTC", NOW), at("2026-11-10T12:00:00Z"));
is("the 5th: exactly a day ahead is allowed", moveOn(monthly, 5, "UTC", NOW), NOW + MOVE_LEAD_SECONDS);
is("the 4th: less than a day ahead is not", moveOn(monthly, 4, "UTC", NOW), null);
is("the 21st: after the payment due, not now", moveOn(monthly, 21, "UTC", NOW), null);
is("the 1st: already past this period", moveOn(monthly, 1, "UTC", NOW), null);
const offered = daysOffered(monthly, "UTC", NOW, ctx);
is("days 5 to 19 are offered", offered.map((o) => o.day), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
is("each is before the payment due and a day ahead", offered.every((o) => o.on < at("2026-11-20T15:00:00Z") && o.on >= NOW + MOVE_LEAD_SECONDS), true);
is("every offered day lies within 1 to 28", offered.every((o) => o.day >= FIRST_DAY && o.day <= LAST_DAY), true);
const nextPeriod = daysOffered(sub({ end: at("2026-12-20T15:00:00Z") }), "UTC", at("2026-11-21T00:00:00Z"), ctx);
is("after the payment, the later days come back, still in November", nextPeriod.filter((o) => o.day > 20).map((o) => new Date(o.on * 1000).toISOString().slice(0, 10)), ["2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28"]);
is("and the earlier ones fall in December, before the payment due", nextPeriod.filter((o) => o.day < 20).map((o) => o.day).length, 19);

part("Month ends: a member billed on the 31st");
const jan31 = sub({ end: at("2027-01-31T08:00:00Z") });
is("current day is the 31st, so all of 1 to 28 can be chosen", currentDay(jan31, "UTC"), 31);
is("the 28th: January 28", moveOn(jan31, 28, "UTC", at("2027-01-05T12:00:00Z")), at("2027-01-28T12:00:00Z"));
is("days 6 to 28 offered on January 5", daysOffered(jan31, "UTC", at("2027-01-05T12:00:00Z"), ctx).map((o) => o.day).join(","), "6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28");
const feb28 = sub({ end: at("2027-02-28T08:00:00Z") });
is("in February (anchored on the 31st, paid on the 28th) the 28th is the day paid on now", moveOn(feb28, 28, "UTC", at("2027-02-01T12:00:00Z")), null);
is("the 27th is February 27", moveOn(feb28, 27, "UTC", at("2027-02-01T12:00:00Z")), at("2027-02-27T12:00:00Z"));
is(
  "payments after January 28 stay on the 28th, February included",
  paymentsAfter(at("2027-01-28T12:00:00Z"), 1, 3).map((s) => new Date(s * 1000).toISOString()),
  ["2027-02-28T12:00:00.000Z", "2027-03-28T12:00:00.000Z", "2027-04-28T12:00:00.000Z"],
);

part("Leap years");
const leapYearly = sub({ interval: "year", end: at("2028-02-29T10:00:00Z") });
is("paid on February 29: the current day is the 29th", currentDay(leapYearly, "UTC"), 29);
is("the 28th: February 28, 2028", moveOn(leapYearly, 28, "UTC", at("2028-01-10T00:00:00Z")), at("2028-02-28T12:00:00Z"));
is(
  "the years after: February 28, every year, leap or not",
  paymentsAfter(at("2028-02-28T12:00:00Z"), 12, 4).map((s) => new Date(s * 1000).toISOString().slice(0, 10)),
  ["2029-02-28", "2030-02-28", "2031-02-28", "2032-02-28"],
);
is(
  "a monthly member in a leap February: the 28th comes before March 1",
  moveOn(sub({ end: at("2028-03-01T09:00:00Z") }), 28, "UTC", at("2028-02-10T00:00:00Z")),
  at("2028-02-28T12:00:00Z"),
);

part("Yearly memberships: the payment is brought forward, by less than a month");
const yearly = sub({ interval: "year", end: at("2027-06-15T10:00:00Z") });
is("the 3rd: June 3, 2027", moveOn(yearly, 3, "UTC", NOW), at("2027-06-03T12:00:00Z"));
is("the 20th: May 20, 2027", moveOn(yearly, 20, "UTC", NOW), at("2027-05-20T12:00:00Z"));
is("every offered day is less than a month before the payment due", daysOffered(yearly, "UTC", NOW, ctx).every((o) => at("2027-06-15T10:00:00Z") - o.on < 31 * DAY), true);
is("27 days offered (all but the 15th)", daysOffered(yearly, "UTC", NOW, ctx).length, 27);

part("Time zones and daylight saving");
is("an unknown zone is UTC", zoneOf("Mars/Base"), "UTC");
is("a number is UTC", zoneOf(42), "UTC");
is("a zone with odd characters is UTC", zoneOf("America/New_York; drop"), "UTC");
is("a known zone is kept", zoneOf("America/Fortaleza"), "America/Fortaleza");
is("noon in New York before spring forward (EST)", localNoon(2027, 3, 10, "America/New_York"), at("2027-03-10T17:00:00Z"));
is("noon in New York after spring forward (EDT)", localNoon(2027, 3, 15, "America/New_York"), at("2027-03-15T16:00:00Z"));
is("noon on the day clocks spring forward", localNoon(2026, 3, 8, "America/New_York"), at("2026-03-08T16:00:00Z"));
is("noon on the day clocks fall back", localNoon(2027, 11, 7, "America/New_York"), at("2027-11-07T17:00:00Z"));
is("noon in Auckland in its summer (UTC+13) is 23:00 UTC the day before", localNoon(2026, 12, 1, "Pacific/Auckland"), at("2026-11-30T23:00:00Z"));
is("noon in Kiritimati (UTC+14)", localNoon(2026, 11, 10, "Pacific/Kiritimati"), at("2026-11-09T22:00:00Z"));
is("a month past 12 rolls into the next year", localNoon(2026, 13, 5, "UTC"), at("2027-01-05T12:00:00Z"));
is("a month below 1 rolls into the year before", localNoon(2027, 0, 5, "UTC"), at("2026-12-05T12:00:00Z"));
const nyLate = sub({ end: at("2026-11-20T03:00:00Z") });
is("paid at 03:00 UTC on the 20th is the 19th in New York", currentDay(nyLate, "America/New_York"), 19);
is("so in New York the 19th is not offered", moveOn(nyLate, 19, "America/New_York", NOW), null);
is("and the 20th would come after the payment due", moveOn(nyLate, 20, "America/New_York", NOW), null);
is("the 18th is noon on November 18 in New York", moveOn(nyLate, 18, "America/New_York", NOW), at("2026-11-18T17:00:00Z"));

let steady = true;
const ny = localNoon(2026, 11, 15, "America/New_York");
for (const s of paymentsAfter(ny, 1, 24)) {
  const p = localParts(s, "America/New_York");
  if (p.day !== 15 || p.hour < 11 || p.hour > 13) steady = false;
}
is("New York, the 15th: 24 payments, all on the 15th between 11 and 13 local", steady, true);

const akl = moveInstant(2026, 12, 1, "Pacific/Auckland");
is("Auckland, the 1st: 01:00 UTC on December 1, so the UTC day is the 1st too", akl, at("2026-12-01T01:00:00Z"));
is("Kiritimati (UTC+14), the 10th: 01:00 UTC on the 10th", moveInstant(2026, 11, 10, "Pacific/Kiritimati"), at("2026-11-10T01:00:00Z"));
is("Pago Pago (UTC-11), the 10th: 21:00 UTC, so the run's grace stays on the 10th", moveInstant(2026, 11, 10, "Pacific/Pago_Pago"), at("2026-11-10T21:00:00Z"));
is("UTC, the 10th: noon", moveInstant(2026, 11, 10, "UTC"), at("2026-11-10T12:00:00Z"));
is("New York, the 10th: local noon", moveInstant(2026, 11, 10, "America/New_York"), at("2026-11-10T17:00:00Z"));
steady = true;
for (const s of paymentsAfter(akl, 1, 24)) if (localParts(s, "Pacific/Auckland").day !== 1) steady = false;
is("Auckland, the 1st: 24 payments, all on the 1st locally", steady, true);

const ZONES = [
  "UTC", "America/New_York", "America/Los_Angeles", "America/St_Johns", "America/Fortaleza", "Pacific/Honolulu", "Pacific/Pago_Pago",
  "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Kathmandu", "Asia/Tokyo", "Australia/Sydney", "Australia/Lord_Howe",
  "Pacific/Norfolk", "Pacific/Auckland", "Pacific/Chatham", "Pacific/Tongatapu", "Pacific/Kiritimati",
];
const wrong: string[] = [];
for (const zone of ZONES) {
  for (let d = FIRST_DAY; d <= LAST_DAY; d += 1) {
    for (const [y, m] of [[2026, 11], [2027, 3], [2027, 10], [2028, 2]]) {
      const start = moveInstant(y, m, d, zone);
      for (const s of [start, ...paymentsAfter(start, 1, 24)]) {
        for (const t of [s, s + MOVE_GRACE_SECONDS]) {
          if (localParts(t, zone).day !== d || new Date(t * 1000).getUTCDate() !== d) wrong.push(`${zone} ${d} ${new Date(t * 1000).toISOString()}`);
        }
      }
    }
  }
}
is("19 zones, days 1 to 28, four starting months, 24 payments each, with the run's grace: always day d locally and in UTC", wrong.slice(0, 5), []);

// The zones whose daylight-saving rules or offsets are the hardest, two
// years of starts: the moment and its grace keep an hour clear of the local
// day's edges on that very date (a sample, so the suite stays fast).
const HARD = [
  "Pacific/Chatham", "Pacific/Auckland", "Australia/Lord_Howe", "Pacific/Norfolk", "America/Havana", "America/Santiago",
  "Asia/Beirut", "Pacific/Apia", "Pacific/Kiritimati", "Pacific/Pago_Pago", "America/Adak",
];
const near: string[] = [];
for (const zone of HARD) {
  for (let y = 2026; y <= 2027; y += 1) {
    for (let m = 1; m <= 12; m += 1) {
      for (const d of [1, 2, 14, 27, 28]) {
        const s = moveInstant(y, m, d, zone);
        for (const t of [s - 3600, s + MOVE_GRACE_SECONDS + 3600]) if (localParts(t, zone).day !== d) near.push(`${zone} ${y}-${m}-${d}`);
        if (new Date(s * 1000).getUTCDate() !== d || new Date((s + MOVE_GRACE_SECONDS) * 1000).getUTCDate() !== d) near.push(`utc ${zone} ${y}-${m}-${d}`);
      }
    }
  }
}
is("11 hard zones, every month of 2026 and 2027: an hour clear of the local day's edges, the UTC day the same", near.slice(0, 5), []);

const bad: string[] = [];
for (const zone of ["UTC", "America/New_York", "America/Santiago", "Asia/Kathmandu", "Pacific/Auckland", "Pacific/Chatham", "Pacific/Apia", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
  for (const endIso of ["2026-11-20T15:00:00Z", "2027-03-01T00:30:00Z", "2027-01-31T23:59:00Z", "2028-02-29T10:00:00Z"]) {
    const end = at(endIso);
    for (const interval of ["month", "year"]) {
      const s = sub({ end, interval });
      const now = end - (interval === "month" ? 29 : 40) * DAY;
      for (const o of daysOffered(s, zone, now, ctx)) {
        if (localParts(o.on, zone).day !== o.day || o.on >= end || o.on < now + DAY || end - o.on > 32 * DAY) bad.push(`${zone} ${endIso} ${interval} ${o.day}`);
        if (moveOn(s, o.day, zone, now) !== o.on) bad.push(`mismatch ${zone} ${endIso} ${interval} ${o.day}`);
      }
    }
  }
}
is("9 zones, four period ends, monthly and yearly: each day offered is that day locally, before the payment due, a day ahead", bad.slice(0, 5), []);

steady = true;
const ldn = localNoon(2027, 1, 28, "Europe/London");
for (const s of paymentsAfter(ldn, 1, 24)) if (localParts(s, "Europe/London").day !== 28) steady = false;
is("London, the 28th: every payment on the 28th, February and summer time included", steady, true);

// Stripe anchors where the change really ran, anywhere in its window from
// `on` to `on + MOVE_GRACE_SECONDS`: wherever that is, the run and every
// payment after it stay on day d where the member lives and in UTC.
const ranLate: string[] = [];
for (const zone of ["Pacific/Auckland", "Pacific/Kiritimati", "Pacific/Pago_Pago", "America/New_York", "Pacific/Chatham", "UTC"]) {
  for (let d = FIRST_DAY; d <= LAST_DAY; d += 1) {
    // New York's clocks change in March and November.
    for (const [y, m] of [[2026, 11], [2027, 3], [2027, 10], [2027, 11], [2028, 2]]) {
      const start = moveInstant(y, m, d, zone);
      for (const ran of [start, start + 60, start + MOVE_GRACE_SECONDS / 2, start + MOVE_GRACE_SECONDS]) {
        for (const t of [ran, ...paymentsAfter(ran, 1, 24), ...paymentsAfter(ran, 12, 4)]) {
          if (localParts(t, zone).day !== d || new Date(t * 1000).getUTCDate() !== d) ranLate.push(`${zone} ${y}-${m}-${d} ran ${ran - start}s ${new Date(t * 1000).toISOString()}`);
        }
      }
    }
  }
}
is("6 zones (Auckland, Kiritimati, Pago Pago, New York across its clock changes, Chatham, UTC), run anywhere in its window: every payment on day d, locally and in UTC", ranLate.slice(0, 5), []);
is(
  "New York, the 8th of March 2027 (clocks changed the day before), run at the window's end: the payments stay on the 8th",
  paymentsAfter(moveInstant(2027, 3, 8, "America/New_York") + MOVE_GRACE_SECONDS, 1, 12).map((t) => localParts(t, "America/New_York").day),
  Array(12).fill(8),
);

part("The request is signed: the creator can edit the metadata, so nothing unsigned is read");
const on = at("2026-11-10T12:00:00Z");
const base = sub();
const meta = req(base, on, 1834, 2540);
const pending = sub({ metadata: meta });
is(
  "the request keeps when asked, when it runs, the amount shown, the ceiling and the period it was priced on",
  { ...meta, [META_SIG]: "" },
  { [META_AT]: String(NOW), [META_ON]: String(on), [META_SHOWN]: "1834", [META_CEILING]: "2540", [META_END]: String(at("2026-11-20T15:00:00Z")), [META_MONTHS]: "1", [META_PRICE]: "price_1", [META_SIG]: "" },
);
is(
  "the text signed names the subscription, the customer and every field",
  requestSigText(base, meta),
  `billing-day:v1|sub_1|cus_1|${NOW}|${on}|1834|2540|${at("2026-11-20T15:00:00Z")}|1|price_1`,
);
is("the signature is the server's HMAC of that text", meta[META_SIG], sign(requestSigText(base, meta)!));
is("the customer id is read when the customer was not expanded too", requestSigText({ ...base, customer: "cus_1" }, meta), requestSigText(base, meta));
is("no subscription id: nothing to sign", requestSigText({ ...base, id: undefined }, meta), null);
is("no customer id: nothing to sign", requestSigText({ ...base, customer: { balance: 0 } }, meta), null);
is("a field that is not a whole number: nothing to sign", requestSigText(base, { ...meta, [META_SHOWN]: "18|34" }), null);
is("a signer that cannot sign keeps no request", requestMeta(base, on, 1834, 2540, NOW, () => null), null);
is("a signer giving anything but 64 hex keeps no request", requestMeta(base, on, 1834, 2540, NOW, () => "abc"), null);
is("a signed request is read", [pendingMove(pending, NOW, verify), shownOf(pending, verify), ceilingOf(pending, verify)], [on, 1834, 2540]);
const edited = sub({ metadata: { ...meta, [META_SHOWN]: "999999", [META_CEILING]: "999999" } });
is("an edited amount shown or ceiling is not read", [shownOf(edited, verify), ceilingOf(edited, verify)], [null, null]);
is("an edited request is no request: it does not wait, and cannot run", [pendingMove(edited, on, verify), cannotRun(edited, on + 60, ctx)], [null, "none"]);
is("an edited request does not stop the member asking again", cannotMove(edited, NOW, ctx), null);
const moved = sub({ metadata: { ...meta, [META_ON]: String(on - DAY) } });
is("an edited moment is not read", pendingMove(moved, NOW, verify), null);
const copied = sub({ id: "sub_2", metadata: meta });
is("a request copied from another subscription is not read", [pendingMove(copied, NOW, verify), shownOf(copied, verify), cannotRun(copied, on + 60, ctx)], [null, null, "none"]);
const otherCustomer = sub({ customer: { id: "cus_2", balance: 0, discount: null, invoice_settings: { default_payment_method: null } }, metadata: meta });
is("a request copied to another customer's subscription is not read", pendingMove(otherCustomer, NOW, verify), null);
is("an unsigned request is not read", pendingMove(sub({ metadata: { ...meta, [META_SIG]: "" } }), NOW, verify), null);
is("a request without its signature key is not read", pendingMove(sub({ metadata: { [META_AT]: meta[META_AT], [META_ON]: meta[META_ON] } }), NOW, verify), null);
is("a verifier that says no reads nothing", pendingMove(pending, NOW, () => false), null);

part("Running a waiting change");
is("a negative amount is never kept (amount_due is never below zero)", requestMeta(base, on, -250, 2540, NOW, sign), null);
is("a fraction is never kept", requestMeta(base, on, 12.5, 2540, NOW, sign), null);
is("a negative ceiling is never kept", requestMeta(base, on, 0, -1, NOW, sign), null);
is("an amount shown above its ceiling is never kept", requestMeta(base, on, 2541, 2540, NOW, sign), null);
is("a membership whose price id is not read keeps no request", requestMeta(withItem(base, { price: { ...PRICE, id: undefined } }), on, 1834, 2540, NOW, sign), null);
is("a membership with no period end keeps no request", requestMeta({ ...base, items: { data: [{ quantity: 1, price: PRICE }] } }, on, 1834, 2540, NOW, sign), null);
is("no amount kept reads as null", [shownOf(sub(), verify), ceilingOf(sub(), verify)], [null, null]);
is("before its moment: waiting, not due", [pendingMove(pending, on - 60, verify), moveDue(pending, on - 60, verify)], [on, false]);
is("before its moment: too early", cannotRun(pending, on - 60, ctx), "early");
is("at its moment, before Stripe's clock may have reached it: not yet due", [moveDue(pending, on, verify), cannotRun(pending, on + RUN_SKEW_SECONDS - 1, ctx)], [false, "early"]);
is("a minute after its moment: due and may run", [moveDue(pending, on + RUN_SKEW_SECONDS, verify), cannotRun(pending, on + RUN_SKEW_SECONDS, ctx)], [true, null]);
is(
  "within an hour of the period's end: too late",
  cannotRun(sub({ end: on + RUN_SKEW_SECONDS + RUN_END_CLEAR_SECONDS, metadata: req(sub({ end: on + RUN_SKEW_SECONDS + RUN_END_CLEAR_SECONDS }), on) }), on + RUN_SKEW_SECONDS, ctx),
  "late",
);
is("an hour late: may run", cannotRun(pending, on + 3600, ctx), null);
is("past its grace: too late", [moveDue(pending, on + MOVE_GRACE_SECONDS, verify), cannotRun(pending, on + MOVE_GRACE_SECONDS, ctx)], [false, "late"]);
is("behind on a payment by then: may not run", cannotRun({ ...pending, status: "past_due" }, on + 60, ctx), "behind");
is("set to end by then: may not run", cannotRun({ ...pending, cancel_at_period_end: true }, on + 60, ctx), "ending");
is("a discount added by then: may not run", cannotRun({ ...pending, discounts: ["di_1"] }, on + 60, ctx), "discount");
is("a balance added by then: may not run", cannotRun({ ...pending, customer: { id: "cus_1", balance: 300 } }, on + 60, ctx), "balance");
is("the card swapped for a bank debit by then: may not run", cannotRun({ ...pending, default_payment_method: { id: "pm_9", type: "us_bank_account" } }, on + 60, ctx), "card");
is("the billing mode no longer read by then: may not run", cannotRun({ ...pending, billing_mode: null }, on + 60, ctx), "state");
is(
  "the period moved on since the request (a new period end): may not run",
  cannotRun(sub({ end: at("2026-12-20T15:00:00Z"), metadata: meta }), on + 60, ctx),
  "changed",
);
is(
  "switched to yearly since the request, same moment: may not run",
  cannotRun(sub({ interval: "year", end: at("2027-11-05T09:00:00Z"), metadata: req(base, on) }), on + 60, ctx),
  "changed",
);
is(
  "the price changed since the request (signed with the old price): may not run",
  cannotRun(withItem(pending, { price: { ...PRICE, id: "price_2" } }), on + 60, ctx),
  "changed",
);
is("months kept do not match (yearly kept and signed, monthly now): may not run", cannotRun(sub({ metadata: resigned(base, { ...meta, [META_MONTHS]: "12" }) }), on + 60, ctx), "changed");
is("a request without its period is not read: nothing runs", cannotRun(sub({ metadata: { [META_AT]: String(NOW), [META_ON]: String(on), [META_SHOWN]: "1834" } }), on + 60, ctx), "none");
is(
  "its moment before the current period started: may not run",
  cannotRun(withItem(pending, { current_period_start: on + 1 }), on + 60, ctx),
  "changed",
);
is("no current period start known: may not run", cannotRun({ ...withItem(pending, { current_period_start: undefined }), billing_mode: { type: "classic" } }, on + 60, ctx), "changed");
is("its moment at or after the period end: may not run", cannotRun(sub({ end: on, metadata: req(sub({ end: on }), on) }), on + 60, ctx), "late");
is("no change waiting: nothing to run", cannotRun(sub(), on, ctx), "none");
is("Stripe's amount equal to the ceiling may be charged", withinCeiling(2540, 2540), true);
is("one cent more may not", withinCeiling(2540, 2541), false);
is("less may", withinCeiling(2540, 1200), true);
is("nothing to pay may", withinCeiling(0, 0), true);
is("a negative figure is never trusted", withinCeiling(0, -300), false);
is("a fraction is never trusted", withinCeiling(2540, 2539.5), false);

part("The amount shown is the preview's whole amount_due, the ceiling its full new period with tax");
type Line = NonNullable<NonNullable<MovePreview["lines"]>["data"]>[number];
const subLine = (amount: number, proration: boolean, more: Partial<Line> = {}): Line => ({
  amount,
  parent: { type: "subscription_item_details", subscription_item_details: { proration, subscription: "sub_1" } },
  ...more,
});
const clean: MovePreview = { amount_due: 667, starting_balance: 0, lines: { data: [subLine(-333, true), subLine(1000, false)] } };
is("a clean preview: shown is amount_due", [previewRefusal(clean, base), previewAmount(clean, base)], [null, 667]);
is("its ceiling is the new period's line", previewCeiling(clean, base), 1000);
// A monthly $10.00 membership with 27% tax added on top: a credit for the
// days left (-$3.33, its tax -$0.90) and the new month ($10.00, tax $2.70).
const taxed: MovePreview = {
  amount_due: 1000 + 270 - 333 - 90,
  starting_balance: 0,
  lines: {
    data: [
      subLine(-333, true, { taxes: [{ amount: -90, tax_behavior: "exclusive" }] }),
      subLine(1000, false, { taxes: [{ amount: 270, tax_behavior: "exclusive" }] }),
    ],
  },
};
is("with 27% tax on top: shown is amount_due, tax included", [previewRefusal(taxed, base), previewAmount(taxed, base)], [null, 847]);
is("with 27% tax on top: the ceiling is the new month with its tax", previewCeiling(taxed, base), 1270);
const inclusive: MovePreview = { ...taxed, lines: { data: [subLine(-333, true), subLine(1000, false, { taxes: [{ amount: 213, tax_behavior: "inclusive" }] })] }, amount_due: 667 };
is("a tax included in the price is already in the line", previewCeiling(inclusive, base), 1000);
is("a tax whose behavior is not read: no ceiling", previewCeiling({ ...clean, lines: { data: [subLine(1000, false, { taxes: [{ amount: 270 }] })] } }, base), null);
is("the older tax_amounts form: no ceiling", previewCeiling({ ...clean, lines: { data: [subLine(1000, false, { tax_amounts: [{ amount: 270, inclusive: false }] })] } }, base), null);
is("a line whose proration is not read: no ceiling", previewCeiling({ ...clean, lines: { data: [{ amount: 1000, parent: { type: "subscription_item_details", subscription_item_details: {} } }] } }, base), null);
is("only prorations, no new period: no ceiling", previewCeiling({ ...clean, lines: { data: [subLine(-333, true)] } }, base), null);
is("a discount on the new period: no ceiling", previewCeiling({ ...clean, lines: { data: [subLine(1000, false, { discount_amounts: [{ amount: 200 }] })] } }, base), null);
is("a zero discount line is no discount", previewCeiling({ ...clean, lines: { data: [subLine(1000, false, { discount_amounts: [{ amount: 0 }] })] } }, base), 1000);
const twoPeriods: MovePreview = { amount_due: 1667, starting_balance: 0, lines: { data: [subLine(-333, true), subLine(1000, false), subLine(1000, false)] } };
is("two new-period lines (a credit and two of $10.00): no ceiling", previewCeiling(twoPeriods, base), null);
is("and the preview is refused", previewRefusal(twoPeriods, base), "amount");
is("a new-period line that is not the membership's price: no ceiling", previewCeiling({ ...clean, lines: { data: [subLine(-333, true), subLine(2000, false)] } }, base), null);
is("a price not read: no ceiling", previewCeiling(clean, withItem(base, { price: { ...PRICE, unit_amount: undefined } })), null);
is("a preview with no ceiling is refused", previewRefusal({ ...clean, lines: { data: [subLine(-333, true)] }, amount_due: 0 }, base), "amount");
is("a preview due above its own ceiling is refused", previewRefusal({ ...clean, amount_due: 1001 }, base), "amount");
is("amount_due includes tax added on top", previewAmount({ ...clean, amount_due: 726 }, base), 726);
const withItemLine: MovePreview = {
  starting_balance: 0,
  amount_due: 1000 - 333 + 500,
  lines: { data: [subLine(-333, true), subLine(1000, false), { amount: 500, parent: { type: "invoice_item_details", invoice_item_details: { proration: false, invoice_item: "ii_1" } } }] },
};
is("a pending invoice item on the invoice is refused", [previewRefusal(withItemLine, base), previewAmount(withItemLine, base)], ["extra", null]);
is("a line from nowhere known is refused", previewRefusal({ ...clean, lines: { data: [...clean.lines!.data!, { amount: 100 }] } }, base), "extra");
is("an old-style invoice item line is refused", previewRefusal({ ...clean, lines: { data: [...clean.lines!.data!, { amount: 100, type: "invoiceitem", proration: false }] } }, base), "extra");
const owes: MovePreview = { starting_balance: 200, amount_due: 867, lines: { data: [subLine(-333, true), subLine(1000, false)] } };
is("a balance owed on the invoice is refused", [previewRefusal(owes, base), previewAmount(owes, base)], ["balance", null]);
is("a credit on the invoice is refused", previewRefusal({ ...clean, starting_balance: -100, amount_due: 567 }, base), "balance");
is("no starting balance read is refused", previewRefusal({ amount_due: 667, lines: clean.lines }, base), "balance");
is("more lines than one page is refused", previewRefusal({ ...clean, lines: { ...clean.lines, has_more: true } }, base), "extra");
is("no amount_due read is refused", previewRefusal({ starting_balance: 0, lines: clean.lines }, base), "amount");
is("a negative amount_due is refused", previewRefusal({ ...clean, amount_due: -1 }, base), "amount");
is("no lines is refused", previewRefusal({ starting_balance: 0, amount_due: 0, lines: { data: [] } }, base), "extra");

part("The fresh preview at the moment of the change: bounded by the ceiling, never more than a full period");
// Asked with the taxed preview: shown $8.47, ceiling $12.70.
const asked = sub({ metadata: req(base, on, 847, 1270) });
is("fresh preview the same: may run", runPreviewRefusal(asked, taxed, verify), null);
const fresher = (due: number): MovePreview => ({ ...taxed, amount_due: due });
is("fresh preview above the amount shown but under the ceiling: may run (flexible mode credits what was paid)", runPreviewRefusal(asked, fresher(1100), verify), null);
is("fresh preview exactly the ceiling: may run", runPreviewRefusal(asked, fresher(1270), verify), null);
// Asked when the tax was lower: ceiling $12.00 kept; by the day, the full month with its tax is $12.70.
const askedLow = sub({ metadata: req(base, on, 800, 1200) });
is("fresh preview above the ceiling kept: may not run", runPreviewRefusal(askedLow, fresher(1201), verify), "above");
is("fresh preview at the ceiling kept: may run", runPreviewRefusal(askedLow, fresher(1200), verify), null);
is("fresh preview with a pending invoice item: may not run", runPreviewRefusal(asked, withItemLine, verify), "extra");
is("fresh preview with a balance: may not run", runPreviewRefusal(asked, owes, verify), "balance");
is("no ceiling kept with the request: may not run", runPreviewRefusal(sub(), clean, verify), "above");
is("an edited ceiling is not read: may not run", runPreviewRefusal(sub({ metadata: { ...req(base, on, 847, 1270), [META_CEILING]: "99999" } }), fresher(1100), verify), "above");

part("mayRun: the only door to the change");
is("due, running normally, fresh preview under the ceiling: may run", mayRun(asked, fresher(1100), on + 60, ctx), null);
is("before its moment: early", mayRun(asked, taxed, on - 60, ctx), "early");
is("past its grace: late", mayRun(asked, taxed, on + MOVE_GRACE_SECONDS, ctx), "late");
is("the membership no longer running normally comes first", mayRun({ ...asked, status: "past_due" }, taxed, on + 60, ctx), "behind");
is("the period changed: changed", mayRun(sub({ end: at("2026-12-20T15:00:00Z"), metadata: asked.metadata }), taxed, on + 60, ctx), "changed");
is("fresh preview above the ceiling kept: above", mayRun(askedLow, fresher(1270), on + 60, ctx), "above");
is("an open invoice of the subscription found by then: invoice", mayRun(asked, taxed, on + 60, { verify, openInvoices: [{ id: "in_9", status: "open" }] }), "invoice");
is("the open invoices not read: invoice", mayRun(asked, taxed, on + 60, { verify, openInvoices: null }), "invoice");
is("fresh preview with a balance: balance", mayRun(asked, owes, on + 60, ctx), "balance");
is("an edited request: nothing to run", mayRun(sub({ metadata: { ...asked.metadata!, [META_SHOWN]: "1" } }), taxed, on + 60, ctx), "none");
is("a request copied from another subscription: nothing to run", mayRun({ ...asked, id: "sub_2" }, taxed, on + 60, ctx), "none");

part("Billing mode: read, or refused; flexible refused until a test clock proves the anchor moves");
const flexible = sub({ billing_mode: { type: "flexible" } });
is("the rule toggle is off: no test-clock proof recorded yet", FLEXIBLE_MOVE_PROVEN, false);
is("flexible: refused while unproven, with its own reason (never \"state\", read as not active)", cannotMove(flexible, NOW, ctx), "mode");
is("flexible: nothing offered while unproven", daysOffered(flexible, "UTC", NOW, ctx), []);
is("flexible: a request may not run while unproven", cannotRun(sub({ billing_mode: { type: "flexible" }, metadata: meta }), on + 60, ctx), "mode");
is("flexible, once proven, with its period on the item: known", periodKnown(flexible, true), true);
is("classic, with a full record: may move", cannotMove(sub(), NOW, ctx), null);
is("no billing mode read: refused as a state not read, not as the unproven mode", cannotMove(sub({ billing_mode: undefined }), NOW, ctx), "state");
is("a billing mode of null: refused", cannotMove(sub({ billing_mode: null }), NOW, ctx), "state");
is("an unknown billing mode: refused", cannotMove(sub({ billing_mode: { type: "hybrid" } }), NOW, ctx), "state");
is(
  "flexible, once proven, with the period end only on the subscription: not known",
  periodKnown({ ...flexible, current_period_start: NOW - 10 * DAY, current_period_end: NOW + 10 * DAY, items: { data: [{ quantity: 1, price: PRICE }] } }, true),
  false,
);
is("flexible, once proven, with no period start on the item: not known", periodKnown(withItem(flexible, { current_period_start: undefined }), true), false);
is(
  "classic with the period end only on the subscription: may move",
  cannotMove({ ...sub(), current_period_end: NOW + 10 * DAY, items: { data: [{ quantity: 1, price: PRICE }] } }, NOW, ctx),
  null,
);
is("classic, its last invoice expanded and paid, a request runs", cannotRun(sub({ latest_invoice: { ...LAST, id: "in_7" }, metadata: meta }), on + 60, ctx), null);

part("The price: licensed, read, one of it");
is("a metered price is refused", cannotMove(withItem(sub(), { price: { ...PRICE, recurring: { ...PRICE.recurring, usage_type: "metered" } } }), NOW, ctx), "interval");
is("a price whose usage type is not read is refused", cannotMove(withItem(sub(), { price: { ...PRICE, recurring: { interval: "month", interval_count: 1 } } }), NOW, ctx), "interval");
is("a price whose amount is not read is refused", cannotMove(withItem(sub(), { price: { ...PRICE, unit_amount: null } }), NOW, ctx), "items");
is("a price whose id is not read is refused", cannotMove(withItem(sub(), { price: { ...PRICE, id: undefined } }), NOW, ctx), "items");

part("After a declined change (402): a marker first, every invoice it may have left cleared or refunded, swept again later");
const SENT = on + 120;
const NONE = { stopAdvance: [], finalize: [], void: [], refund: [], deleteItems: [], tell: [], tellPaid: [] };
const RECORD = sendRecordFor(null, "sub_1", on, SENT);
const IDS = { invoice: null, before: "in_1", pi: null };
const mark = sweepMarkBody(pending, RECORD, sign, verify, IDS)!;
const MARKER = { on, sentAt: SENT, from: SENT - SWEEP_SKEW_SECONDS, until: SENT + SWEEP_WINDOW_SECONDS, invoice: null, before: "in_1", pi: null };
const withMarker = (s0: BillingDaySub, body: URLSearchParams) => ({
  ...s0,
  metadata: { ...s0.metadata!, [META_SWEEP]: body.get(`metadata[${META_SWEEP}]`)!, [META_SWEEP_SIG]: body.get(`metadata[${META_SWEEP_SIG}]`)! },
});
const marked = withMarker(pending, mark);
is("the marker is bound to the request's moment, with the send, the window and the last invoice before it", sweepMarker(marked, verify), MARKER);
is("the marker writes nothing else (the request stays until cleared)", [...mark.keys()], [`metadata[${META_SWEEP}]`, `metadata[${META_SWEEP_SIG}]`]);
is(
  "its text names the subscription, the customer and every part",
  sweepSigText(base, MARKER),
  `billing-day-sweep:v2|sub_1|cus_1|${on}|${SENT}|${SENT - 600}|${SENT + SWEEP_WINDOW_SECONDS}|-|in_1|-`,
);
is("the window is short: ten minutes before the send (Stripe's clock) to five after", [SWEEP_SKEW_SECONDS, SWEEP_WINDOW_SECONDS], [600, 300]);
is("no signed request: no marker", sweepMarkBody(sub(), RECORD, sign, verify, IDS), null);
is("a send before the moment: no marker", sweepMarkBody(pending, { ...RECORD, sentAt: on - 1 }, sign, verify, IDS), null);
is("a send record for another moment: no marker", sweepMarkBody(pending, { ...RECORD, on: on + 1 }, sign, verify, IDS), null);
is("an id not as Stripe writes it: no marker", sweepMarkBody(pending, RECORD, sign, verify, { ...IDS, invoice: "in.2" }), null);
is("a signer that cannot sign writes no marker", sweepMarkBody(pending, RECORD, () => null, verify, IDS), null);
{
  const nearEnd = sub({ end: SENT + 200, metadata: req(sub({ end: SENT + 200 }), on) });
  is("the window stops short of the period's end, where a renewal invoice would be", sweepMarker(withMarker(nearEnd, sweepMarkBody(nearEnd, RECORD, sign, verify, IDS)!), verify)?.until, SENT + 199);
}
const withOwn = withMarker(marked, sweepMarkInvoiceBody(marked, { invoice: "in_402" }, sign, verify)!);
const OWN = { ...MARKER, invoice: "in_402" };
is("the 402's own invoice, once found, is signed into the marker", sweepMarker(withOwn, verify), OWN);
is("without a signed marker there is nothing to add it to", sweepMarkInvoiceBody(pending, { invoice: "in_402" }, sign, verify), null);
{
  const lists = sweepQueries("sub_1", "cus_1", MARKER);
  const queries = lists.invoices;
  is("the sweep lists four statuses by the subscription and by the customer", queries.map((q) => `${q.get("subscription") ?? "cus:" + q.get("customer")} ${q.get("status")}`), [
    "sub_1 open", "sub_1 draft", "sub_1 uncollectible", "sub_1 paid", "cus:cus_1 open", "cus:cus_1 draft", "cus:cus_1 uncollectible", "cus:cus_1 paid",
  ]);
  is("over the marker's window, 100 a page", [queries[0].get("created[gte]"), queries[0].get("created[lte]"), queries[0].get("limit")], [String(SENT - 600), String(SENT + SWEEP_WINDOW_SECONDS), "100"]);
  is(
    "and the customer's pending invoice items over the same window",
    [...lists.items.entries()],
    [["customer", "cus_1"], ["pending", "true"], ["created[gte]", String(SENT - 600)], ["created[lte]", String(SENT + SWEEP_WINDOW_SECONDS)], ["limit", "100"]],
  );
}

const sentFrom = (o: Record<string, unknown>) => ({
  created: SENT + 2,
  billing_reason: "subscription_update",
  parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } },
  ...o,
});
is(
  "an invoice Stripe stamped 10 minutes behind the server's clock is still cleared",
  invoicesToVoid([sentFrom({ id: "in_2", status: "open", created: SENT - 600 })], "sub_1", MARKER),
  { ...NONE, void: ["in_2"] },
);
is(
  "an open one is voided; a draft is stopped from advancing, then deleted; each once, from the list and the 402's payment",
  invoicesToVoid([sentFrom({ id: "in_2", status: "open" }), sentFrom({ id: "in_3", status: "draft" }), sentFrom({ id: "in_2", status: "open" })], "sub_1", MARKER),
  { ...NONE, stopAdvance: ["in_3"], finalize: ["in_3"], void: ["in_2", "in_3"] },
);
is("an uncollectible one is voided too (its link could still be paid)", invoicesToVoid([sentFrom({ id: "in_4", status: "uncollectible" })], "sub_1", MARKER), { ...NONE, void: ["in_4"] });
is("a 402 invoice the member paid since (by Stripe's link or a retry) is refunded in full", invoicesToVoid([sentFrom({ id: "in_p", status: "paid", amount_paid: 847, payments: ["pi_p"] })], "sub_1", MARKER), { ...NONE, refund: ["in_p"] });
is("one already refunded in full needs nothing", invoicesToVoid([sentFrom({ id: "in_p", status: "paid", amount_paid: 847, refunded: 847 })], "sub_1", MARKER), NONE);
is("one refunded in part is refunded again (the key keeps it to one)", invoicesToVoid([sentFrom({ id: "in_p", status: "paid", amount_paid: 847, refunded: 100, payments: ["pi_p"] })], "sub_1", MARKER), { ...NONE, refund: ["in_p"] });
is("the last invoice before the send, paid for the period, is never refunded", invoicesToVoid([sentFrom({ id: "in_1", status: "paid", amount_paid: 1270 })], "sub_1", MARKER), NONE);
is("stopping a draft sets auto_advance false", stopAdvanceBody().toString(), "auto_advance=false");
is("a refund names the payment, in full or of an amount", [refundBody("pi_1").toString(), refundBody("pi_1", 500).get("amount")], ["payment_intent=pi_1&metadata%5Bbilling_day%5D=refund", "500"]);
is("a refund's idempotency key names the invoice", refundIdempotencyKey("in_p"), "billing-day-refund:in_p");
is("one stamped more than ten minutes before the send is not this change's", invoicesToVoid([sentFrom({ id: "in_2", status: "open", created: SENT - 601 })], "sub_1", MARKER), NONE);
is(
  "a quote the same customer paid 3 days after asking, linked to no subscription, is never refunded",
  invoicesToVoid([{ id: "in_q", status: "paid", amount_paid: 50000, created: NOW + 3 * DAY, billing_reason: "quote_accept", parent: { type: "quote_details", quote_details: { quote: "qt_1" } } }], "sub_1", MARKER),
  NONE,
);
is("an open invoice from before the member asked is not this change's", invoicesToVoid([sentFrom({ id: "in_0", status: "open", created: NOW - 60 })], "sub_1", MARKER), NONE);
is(
  "a creator's own subscription update 40 minutes after the 402 is not this change's",
  invoicesToVoid([sentFrom({ id: "in_c", status: "open", created: SENT + 40 * 60 })], "sub_1", MARKER),
  NONE,
);
is("another subscription's invoice is not touched", invoicesToVoid([sentFrom({ id: "in_5", status: "open", parent: { subscription_details: { subscription: "sub_2" } } })], "sub_1", MARKER), NONE);
is("an invoice the creator made by hand is not touched", invoicesToVoid([sentFrom({ id: "in_8", status: "open", billing_reason: "manual" })], "sub_1", MARKER), NONE);
is(
  "any other reason is cleared (which one Stripe gives the declined update is still to be seen)",
  invoicesToVoid([sentFrom({ id: "in_9", status: "open", billing_reason: "subscription_cycle" }), sentFrom({ id: "in_10", status: "open", billing_reason: "subscription_update" })], "sub_1", MARKER),
  { ...NONE, void: ["in_9", "in_10"] },
);
is("the older shape (subscription on the invoice) is read", invoicesToVoid([{ id: "in_6", status: "open", created: SENT, subscription: "sub_1" }], "sub_1", MARKER), { ...NONE, void: ["in_6"] });
is(
  "an invoice in the window linked to no subscription is never voided: the creator is told",
  invoicesToVoid([{ id: "in_u", status: "open", created: SENT, subscription: null, billing_reason: "automatic_pending_invoice_item_invoice" }], "sub_1", MARKER),
  { ...NONE, tell: ["in_u"] },
);
is("nor refunded when paid: the creator is told", invoicesToVoid([{ id: "in_u", status: "paid", amount_paid: 500, created: SENT, parent: null }], "sub_1", MARKER), { ...NONE, tellPaid: ["in_u"] });
is("one whose subscription is not read: told, not voided", invoicesToVoid([{ id: "in_7", status: "open" }], "sub_1", MARKER), { ...NONE, tell: ["in_7"] });
is(
  "once the 402's own invoice is known, an unlinked one is not this change's",
  invoicesToVoid([{ id: "in_u", status: "open", created: SENT, subscription: null }], "sub_1", { ...MARKER, invoice: "in_402" }),
  NONE,
);
const ITEM = (o: Record<string, unknown>) => ({ id: "ii_1", date: SENT + 1, parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } }, ...o });
is("a pending item of the subscription in the window is deleted", invoicesToVoid([], "sub_1", MARKER, [ITEM({})]), { ...NONE, deleteItems: ["ii_1"] });
is("the older item shape (subscription on the item) is read", invoicesToVoid([], "sub_1", MARKER, [ITEM({ parent: undefined, subscription: "sub_1" })]), { ...NONE, deleteItems: ["ii_1"] });
is("a pending item of another subscription is left alone", invoicesToVoid([], "sub_1", MARKER, [ITEM({ parent: { subscription_details: { subscription: "sub_2" } } })]), NONE);
is("a pending item outside the window is left alone", invoicesToVoid([], "sub_1", MARKER, [ITEM({ date: SENT - 601 })]), NONE);
is("a pending item whose subscription is not read: the creator is told", invoicesToVoid([], "sub_1", MARKER, [ITEM({ parent: null })]), { ...NONE, tell: ["ii_1"] });
is(
  "the 402's own invoice is cleared whatever its time or reason",
  invoicesToVoid([{ id: "in_402", status: "open", created: SENT + 7200, billing_reason: "manual", subscription: null }], "sub_1", OWN),
  { ...NONE, void: ["in_402"] },
);
is("void ones need nothing", invoicesToVoid([sentFrom({ id: "in_vx", status: "void" })], "sub_1", MARKER), NONE);
is("an id not as Stripe writes it is skipped", invoicesToVoid([sentFrom({ id: "in_2/../x", status: "open" })], "sub_1", MARKER), NONE);

part("The sweep marker holds until a later sweep finds nothing");
is("while it is kept, the member is refused with its own reason", cannotMove(marked, SENT + 60, ctx), "sweep");
is("while it is kept, nothing runs", cannotRun(marked, on + 3600, ctx), "sweep");
// The cleanup of a refused or lapsed request, applied as Stripe merges metadata.
const applied = (s0: BillingDaySub, body: URLSearchParams) => {
  const metadata = { ...s0.metadata! };
  for (const [key, value] of body) {
    const name = /^metadata\[(.+)\]$/.exec(key)![1];
    if (value === "") delete metadata[name];
    else metadata[name] = value;
  }
  return { ...s0, metadata };
};
const cleanedUp = applied(withOwn, clearRequestBody());
is("clearing the request after a refusal or lapse never touches the marker", [...clearRequestBody().keys()].some((key) => key.includes(META_SWEEP)), false);
is("after that cleanup the request is gone but the marker stays", [pendingMove(cleanedUp, SENT + 60, verify), sweepMarker(cleanedUp, verify)], [null, OWN]);
is("and the member is still refused, 30 days on", cannotMove(cleanedUp, SENT + 30 * DAY, ctx), "sweep");
is("the change itself never touches the marker either", [...moveBody(base, on, sign)!.keys()].some((key) => key.includes(META_SWEEP)), false);
is("no sweep is due on the run that got the 402", sweepDue(cleanedUp, SENT + 5, verify), false);
is("a sweep is due 15 minutes later, whatever moveDue says", [sweepDue(cleanedUp, SENT + SWEEP_AGAIN_SECONDS, verify), moveDue(cleanedUp, SENT + SWEEP_AGAIN_SECONDS, verify)], [true, false]);
is("and still due 30 days later, never stuck", sweepDue(cleanedUp, SENT + 30 * DAY, verify), true);
is("after a sweep, the next is 15 minutes on", nextSweepAt(cleanedUp, verify, SENT + DAY), SENT + DAY + SWEEP_AGAIN_SECONDS);
is("after the limit, once a day", nextSweepAt(cleanedUp, verify, SENT + SWEEP_MAX_SECONDS), SENT + SWEEP_MAX_SECONDS + SWEEP_SLOW_SECONDS);
is("not due between slow sweeps", sweepDue(cleanedUp, SENT + SWEEP_MAX_SECONDS + 3600, verify, SENT + SWEEP_MAX_SECONDS), false);
is("no marker: never due", [nextSweepAt(sub(), verify, null), sweepDue(sub(), SENT + DAY, verify)], [null, false]);
const own = { id: "in_402", status: "void", created: SENT };
const act = (s0: BillingDaySub, t: number, found: Record<string, unknown>[], toEnd = true, items: Record<string, unknown>[] = []) => sweepAction(s0, t, verify, found, items, toEnd);
is("before then: wait, and still clear what was found", act(cleanedUp, SENT + 5, [sentFrom({ id: "in_2", status: "open" })]), { action: "wait", clear: { ...NONE, void: ["in_2"] }, rewrite: false });
is("a later sweep that finds an invoice: again", act(cleanedUp, SENT + SWEEP_AGAIN_SECONDS, [own, sentFrom({ id: "in_2", status: "open" })]).action, "again");
is("a later sweep that finds a draft: again", act(cleanedUp, SENT + SWEEP_AGAIN_SECONDS, [own, sentFrom({ id: "in_3", status: "draft" })]).action, "again");
is("a later sweep that finds a paid one to refund: again", act(cleanedUp, SENT + SWEEP_AGAIN_SECONDS, [{ ...own, status: "paid", amount_paid: 847, payments: ["pi_p"] }]).action, "again");
is("a later sweep not read to the end: again, never clear", act(cleanedUp, SENT + SWEEP_AGAIN_SECONDS, [own], false).action, "again");
is("a later sweep without the 402's own invoice re-read: again, never clear", act(cleanedUp, SENT + SWEEP_AGAIN_SECONDS, []).action, "again");
is("a later sweep, read to the end, its own invoice void, nothing else: clear", act(cleanedUp, SENT + SWEEP_AGAIN_SECONDS, [own]), { action: "clear", clear: NONE, rewrite: false });
is("still something after the limit: tell the creator, keep the refusal", act(cleanedUp, SENT + SWEEP_MAX_SECONDS, [own, sentFrom({ id: "in_2", status: "open" })]).action, "tell");
is("nothing after the limit: clear", act(cleanedUp, SENT + SWEEP_MAX_SECONDS, [own]).action, "clear");
is("a pending item of the subscription left by the 402: again, never clear", act(cleanedUp, SENT + SWEEP_AGAIN_SECONDS, [own], true, [ITEM({})]), { action: "again", clear: { ...NONE, deleteItems: ["ii_1"] }, rewrite: false });
is("a pending item whose subscription is not read, the 402's own invoice not known: tell", act(applied(marked, clearRequestBody()), SENT + SWEEP_AGAIN_SECONDS, [], true, [ITEM({ parent: null })]).action, "tell");
is("the same item once the 402's own invoice is known: not this change's, clear", act(cleanedUp, SENT + SWEEP_AGAIN_SECONDS, [own], true, [ITEM({ parent: null })]).action, "clear");
{
  const unknownOwn = applied(marked, clearRequestBody());
  is("an unlinked invoice while the 402's own is unknown: tell", act(unknownOwn, SENT + SWEEP_AGAIN_SECONDS, [{ id: "in_u", status: "open", created: SENT, subscription: null }]).action, "tell");
}
is("the 402's own invoice deleted (re-read answered 404, passed as deleted): closed, clear", act(cleanedUp, SENT + SWEEP_AGAIN_SECONDS, [{ id: "in_402", status: "deleted" }]).action, "clear");
is("no marker: nothing to do", act(sub(), SENT + SWEEP_AGAIN_SECONDS, []), { action: "wait", clear: NONE, rewrite: false });
const clearBody = clearSweepBody(cleanedUp, verify, OWN)!;
const swept = applied(cleanedUp, clearBody);
is("clearing the marker touches only the marker", [...clearBody.keys()], [`metadata[${META_SWEEP}]`, `metadata[${META_SWEEP_SIG}]`]);
is("a sweep that read an older marker never clears a newer one", clearSweepBody(cleanedUp, verify, MARKER), null);
is("nor one the server holds differently", clearSweepBody(cleanedUp, verify, OWN, { ...OWN, sentAt: SENT + 1 }), null);
is("once cleared, the member may ask again", cannotMove(swept, SENT + SWEEP_AGAIN_SECONDS, ctx), null);
{
  const edited = { ...cleanedUp, metadata: { ...cleanedUp.metadata, [META_SWEEP]: [on, SENT, NOW, SENT + 7200, "-", "-"].join(".") } };
  is("an edited marker is not read as a marker", sweepMarker(edited, verify), null);
  is("but it still refuses the member (never unblocks)", cannotMove(edited, SENT + DAY, ctx), "sweep");
  is("it is due for a sweep at once, so someone is told", [nextSweepAt(edited, verify, null), sweepDue(edited, SENT + DAY, verify)], [0, true]);
  is("then once a day, not on every run", [nextSweepAt(edited, verify, SENT + DAY), sweepDue(edited, SENT + DAY + 3600, verify, SENT + DAY)], [SENT + DAY + SWEEP_SLOW_SECONDS, false]);
  is("and the route tells the creator", act(edited, SENT + DAY, []).action, "tell");
  const halfDeleted = { ...cleanedUp, metadata: { [META_SWEEP_SIG]: cleanedUp.metadata[META_SWEEP_SIG] } };
  is("a signature left without its marker still refuses, and is due", [cannotMove(halfDeleted, SENT + DAY, ctx), sweepDue(halfDeleted, SENT + DAY, verify)], ["sweep", true]);
  is("a marker copied from another subscription is not read", sweepMarker({ ...cleanedUp, id: "sub_2" }, verify), null);
}
is(
  "while such an invoice stays open, even with latest_invoice still paid, the member is refused",
  cannotMove(sub(), on + MOVE_GRACE_SECONDS + 60, { verify, openInvoices: [{ id: "in_2", status: "open" }] }),
  "invoice",
);
is("an uncollectible invoice of the subscription refuses too", cannotMove(sub(), NOW, { verify, openInvoices: [{ id: "in_4", status: "uncollectible" }] }), "invoice");
is("while the subscription's open invoices were not read, the member is refused", cannotMove(sub(), NOW, { verify, openInvoices: null }), "invoice");

part("A send with no confirmed result: the record, the resend, the marker before any clear");
is("the first send's record: the moment, its second and the key", RECORD, { on, sentAt: SENT, lastSentAt: SENT, key: moveIdempotencyKey("sub_1", on) });
const RESENT = sendRecordFor(RECORD, "sub_1", on, SENT + 3 * 3600);
is("a resend keeps the first second and the key, and moves the last send on", RESENT, { ...RECORD, lastSentAt: SENT + 3 * 3600 });
is("a record for another moment starts again", sendRecordFor(RECORD, "sub_1", on + DAY, SENT + DAY).sentAt, SENT + DAY);
is(
  "a 200 is applied, a 402 declined; a 5xx, another 4xx or a timeout are unknown, never a 402",
  [sendResult({ status: 200 }), sendResult({ status: 402 }), sendResult({ status: 500 }), sendResult({ status: 400 }), sendResult(null), sendResult({})],
  ["applied", "declined", "unknown", "unknown", "unknown", "unknown"],
);
is("the same update may be sent again after its window (no mayRun), within Stripe's idempotency", [mayResend(RECORD, SENT + 3 * 3600), mayResend(RECORD, SENT + RESEND_MAX_SECONDS)], [true, false]);
is(
  "the marker's window starts at the first send and ends after the last",
  [sweepMarker(withMarker(pending, sweepMarkBody(pending, RESENT, sign, verify, IDS)!), verify)?.from, sweepMarker(withMarker(pending, sweepMarkBody(pending, RESENT, sign, verify, IDS)!), verify)?.until],
  [SENT - SWEEP_SKEW_SECONDS, SENT + 3 * 3600 + SWEEP_WINDOW_SECONDS],
);
{
  // The first send timed out (Stripe made a 402 and an open invoice); the window passed.
  const lapsedAt = on + MOVE_GRACE_SECONDS + 60;
  is("the run is now late", cannotRun(pending, lapsedAt, ctx), "late");
  is("but the request may not be cleared while that send has no marker", mayClearRequest(pending, verify, RECORD), false);
  is("once the marker is written, it may", mayClearRequest(marked, verify, RECORD), true);
  is("or when the server holds the marker", mayClearRequest(pending, verify, RECORD, OWN), true);
  is("a marker for another moment does not count", mayClearRequest(pending, verify, RECORD, { ...OWN, on: on + 1 }), false);
  is("no send recorded: it may be cleared", mayClearRequest(pending, verify, null), true);
  is("a record of another moment's send: it may be cleared", mayClearRequest(pending, verify, { ...RECORD, on: on - DAY }), true);
  const applied200 = sub({ metadata: { ...meta, ...doneAt(base, on) } });
  is("the change was made after all: it may be cleared", mayClearRequest(applied200, verify, RECORD), true);
}
is("moveApplied: the last change signed at that very moment", moveApplied(sub({ metadata: doneAt(base, on) }), on, verify), true);
is("another moment is not this change", moveApplied(sub({ metadata: doneAt(base, on - DAY) }), on, verify), false);
is("an unsigned record is not read", moveApplied(sub({ metadata: { [META_DONE]: String(on) } }), on, verify), false);

part("The server's copy of the marker holds when the metadata's is gone");
const bare = sub();
is("no marker in the metadata, the server's holds: refused", cannotMove(bare, SENT + DAY, { ...ctx, serverMarker: OWN }), "sweep");
is("and nothing runs", cannotRun(pending, on + 3600, { ...ctx, serverMarker: OWN }), "sweep");
is("its sweep is scheduled from it", [nextSweepAt(bare, verify, null, OWN), sweepDue(bare, SENT + SWEEP_AGAIN_SECONDS, verify, null, OWN)], [SENT + SWEEP_AGAIN_SECONDS, true]);
is(
  "a sweep with an open invoice: again, and the marker is written back",
  sweepAction(bare, SENT + SWEEP_AGAIN_SECONDS, verify, [own, sentFrom({ id: "in_2", status: "open" })], [], true, { serverMarker: OWN }),
  { action: "again", clear: { ...NONE, void: ["in_2"] }, rewrite: true },
);
is("the metadata matching the server's: nothing to write back", sweepAction(cleanedUp, SENT + SWEEP_AGAIN_SECONDS, verify, [own], [], true, { serverMarker: OWN }).rewrite, false);
is("a replayed older marker in the metadata: written back", sweepAction(marked, SENT + SWEEP_AGAIN_SECONDS, verify, [own], [], true, { serverMarker: OWN }).rewrite, true);
is("written back, it reads as the server's", sweepMarker(applied(bare, sweepMarkerBody(bare, OWN, sign)!), verify), OWN);
is("sweepMarkInvoiceBody builds on the server's copy too", sweepMarker(applied(bare, sweepMarkInvoiceBody(bare, { pi: "pi_402" }, sign, verify, OWN)!), verify), { ...OWN, pi: "pi_402" });

part("Tying an unlinked invoice to the 402's payment");
const PI = { ...MARKER, pi: "pi_402" };
const unlinked = (o: Record<string, unknown>) => ({ id: "in_u", created: SENT, parent: null, ...o });
is("an unlinked open invoice paid by the 402's intent is this change's: voided", invoicesToVoid([unlinked({ status: "open", payments: ["pi_402"] })], "sub_1", PI), { ...NONE, void: ["in_u"] });
is("one paid by it: refunded", invoicesToVoid([unlinked({ status: "paid", amount_paid: 847, payments: ["pi_402"] })], "sub_1", PI), { ...NONE, refund: ["in_u"] });
is("one whose payments do not include it: left alone", invoicesToVoid([unlinked({ status: "paid", amount_paid: 50000, payments: ["pi_quote"] })], "sub_1", PI), NONE);
is("one whose payments were not read: told", invoicesToVoid([unlinked({ status: "open" })], "sub_1", PI), { ...NONE, tell: ["in_u"] });
is("a 402 that carried no payment charged nothing: unlinked ones are left alone", invoicesToVoid([unlinked({ status: "paid", amount_paid: 500 })], "sub_1", { ...MARKER, pi: "none" }), NONE);
is("an unlinked paid invoice refunded in full already: nothing, never told forever", invoicesToVoid([unlinked({ status: "paid", amount_paid: 500, refunded: 500 })], "sub_1", MARKER), NONE);
is("a paid one paid out of band: told, never refunded", invoicesToVoid([sentFrom({ id: "in_o", status: "paid", amount_paid: 847, payments: [], paid_out_of_band: true })], "sub_1", MARKER), { ...NONE, tell: ["in_o"] });
is("a paid one with two payments: told, never refunded in a loop", invoicesToVoid([sentFrom({ id: "in_m", status: "paid", amount_paid: 847, payments: ["pi_a", "pi_b"] })], "sub_1", MARKER), { ...NONE, tell: ["in_m"] });
is("a paid one whose payments were not read: told", invoicesToVoid([sentFrom({ id: "in_r", status: "paid", amount_paid: 847 })], "sub_1", MARKER), { ...NONE, tell: ["in_r"] });
is("finalizing a subscription's draft does not advance it", finalizeBody().toString(), "auto_advance=false");
{
  const noOwn = applied(marked, clearRequestBody());
  const paidUnlinked = [unlinked({ status: "paid", amount_paid: 500 })];
  is("an unlinked paid invoice while the payment is not known: told", sweepAction(noOwn, SENT + SWEEP_AGAIN_SECONDS, verify, paidUnlinked, [], true).action, "tell");
  is("still after the limit until the creator was told", sweepAction(noOwn, SENT + SWEEP_MAX_SECONDS, verify, paidUnlinked, [], true).action, "tell");
  is("after the limit, once the creator was told, a paid one no longer holds the marker", sweepAction(noOwn, SENT + SWEEP_MAX_SECONDS, verify, paidUnlinked, [], true, { creatorTold: true }).action, "clear");
  is("an open one still does", sweepAction(noOwn, SENT + SWEEP_MAX_SECONDS, verify, [unlinked({ status: "open" })], [], true, { creatorTold: true }).action, "tell");
  is("an unlinked pending item once the 402's own invoice is known: left alone", invoicesToVoid([], "sub_1", OWN, [ITEM({ parent: null })]), NONE);
}

part("After the change: anything above the ceiling is refunded");
is("paid the ceiling: nothing to refund", overCeiling({ amount_paid: 1270 }, 1270), 0);
is("paid less: nothing to refund", overCeiling({ amount_paid: 847 }, 1270), 0);
is("a pending item slipped in, paid $5.00 more: $5.00 to refund", overCeiling({ amount_paid: 1770 }, 1270), 500);
is("amount paid not read: read the invoice again", [overCeiling({}, 1270), overCeiling(null, 1270), overCeiling({ amount_paid: 12.5 }, 1270)], [null, null, null]);

part("The Stripe requests");
const preview = previewMoveBody("cus_1", "sub_1", "si_1", on);
is("the preview names the subscription and its item", [preview.get("customer"), preview.get("subscription"), preview.get("subscription_details[items][0][id]")], ["cus_1", "sub_1", "si_1"]);
is("the unchanged item's price is left out, as Stripe asks", [preview.has("subscription_details[items][0][price]"), preview.has("subscription_details[items][0][price_data]")], [false, false]);
is("the preview resets the anchor now, invoicing prorations, at the second it will run", [preview.get("subscription_details[billing_cycle_anchor][type]"), preview.get("subscription_details[proration_behavior]"), preview.get("subscription_details[proration_date]")], ["now", "always_invoice", String(on)]);
const change = moveBody(base, on, sign)!;
const REQUEST = [META_AT, META_ON, META_SHOWN, META_CEILING, META_END, META_MONTHS, META_PRICE, META_SIG];
is("the change resets the anchor now at the previewed second", [change.get("billing_cycle_anchor[type]"), change.get("proration_behavior"), change.get("proration_date")], ["now", "always_invoice", String(on)]);
is("the change is refused if its payment fails", change.get("payment_behavior"), "error_if_incomplete");
is("the change is charged with nobody present, as lib/billing.ts does", change.get("off_session"), "true");
is("the change clears the request, its ceiling and its signature", REQUEST.map((key) => change.get(`metadata[${key}]`)), ["", "", "", "", "", "", "", ""]);
is("the change marks itself done at its moment, applied only if the update succeeds", change.get(`metadata[${META_DONE}]`), String(on));
is("with the server's signature of that moment", change.get(`metadata[${META_DONE_SIG}]`), sign(doneSigText(base, String(on))!));
is("what the change writes is read back as the last change", lastDone(sub({ metadata: { [META_DONE]: change.get(`metadata[${META_DONE}]`)!, [META_DONE_SIG]: change.get(`metadata[${META_DONE_SIG}]`)! } }), on + DAY, verify), on);
is("a signer that cannot sign makes no change", moveBody(base, on, () => null), null);
is("the change never starts a trial or turns prorations off", [change.has("trial_end"), change.get("proration_behavior") !== "none"], [false, true]);
const cleared = clearRequestBody();
is("a declined or lapsed run clears the request, its ceiling and its signature", REQUEST.map((key) => cleared.get(`metadata[${key}]`)), ["", "", "", "", "", "", "", ""]);
is("clearing never marks the change done and changes nothing else", [cleared.has(`metadata[${META_DONE}]`) || cleared.has(`metadata[${META_DONE_SIG}]`), [...cleared.keys()].every((key) => key.startsWith("metadata["))], [false, true]);
is("a cleared request leaves the member free to ask again", cannotMove(sub({ metadata: { store: "shop" } }), on + MOVE_GRACE_SECONDS + 60, ctx), null);
is("the idempotency key names the subscription and the moment", moveIdempotencyKey("sub_1", on), `billing-day:sub_1:${on}`);
is("the change completed now counts as this period's change", cannotMove(sub({ end: addMonths(on, 1), metadata: { store: "shop", ...doneAt(sub(), on) } }), on + DAY, ctx), "recent");

part("The words shown before confirming");
is("ordinals", [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "28th"]);
is("a US date", dateWords(at("2026-11-10T12:00:00Z"), "UTC"), "Tuesday, November 10, 2026");
is("a date in Auckland is its own", dateWords(at("2026-11-30T23:00:00Z"), "Pacific/Auckland"), "Tuesday, December 1, 2026");
const words = moveWords({ from: at("2026-11-20T15:00:00Z"), on, months: 1, amount: "$8.47", ceiling: "$12.70", timeZone: "UTC" });
is("monthly words", words, [
  "Your next payment moves from Friday, November 20, 2026, to Tuesday, November 10, 2026.",
  "On Tuesday, November 10, 2026, you pay one full month, less the paid days you will no longer use.",
  "Today, Stripe works that out as $8.47.",
  "It is never more than one full month, $12.70. If it would be, nothing changes. Anything charged above it is refunded at once.",
  "After that, you pay on the 10th of each month.",
  "If that payment fails, your payment day stays the same.",
  "You can change the day once a month.",
]);
const yearWords = moveWords({ from: at("2027-06-15T10:00:00Z"), on: at("2027-06-03T12:00:00Z"), months: 12, amount: "$12.00", ceiling: "$480.00", timeZone: "America/New_York" });
is("yearly words name the month and day, as a US date", yearWords[4], "After that, you pay every year on June 3.");
is("yearly words bound the payment by a full year", yearWords[3], "It is never more than one full year, $480.00. If it would be, nothing changes. Anything charged above it is refunded at once.");
is("no sentence promises the member never pays more (later payments are the full price)", [...words, ...yearWords].some((line) => /never pay more/.test(line)), false);
is("no sentence promises the amount shown is the most charged (it may differ on the day)", [...words, ...yearWords].some((line) => /not be more than this amount|exactly/.test(line)), false);
is("yearly words say once a year", yearWords[6], "You can change the day once a year.");
const aklWords = moveWords({ from: at("2026-12-14T23:00:00Z"), on: akl, months: 1, amount: "NZ$20.00", ceiling: "NZ$23.00", timeZone: "Pacific/Auckland" });
is("Auckland words use the local day", aklWords[4], "After that, you pay on the 1st of each month.");
const sentences = [...words, ...yearWords, ...aklWords].flatMap((line) => line.split(/(?<=\.)\s+/));
is("every sentence is under 20 words", sentences.filter((s) => s.split(/\s+/).length >= 20), []);
is("no British spelling", [...words, ...yearWords].filter((s) => /cancell|colour|centre|favour|licence/i.test(s)), []);
is("the amount and the ceiling appear as given, once each", [words.filter((s) => s.includes("$8.47")).length, words.filter((s) => s.includes("$12.70")).length], [1, 1]);
is("an unknown zone falls back to UTC", moveWords({ from: NOW + 10 * DAY, on: NOW + 5 * DAY, months: 1, amount: "$1.00", ceiling: "$2.00", timeZone: "Nowhere/Here" })[1], "On Monday, November 9, 2026, you pay one full month, less the paid days you will no longer use.");

part("What the member is told after a run that did not move the day");
const OUTCOMES: RunOutcome[] = [
  "declined", "above", "early", "late", "none", "invoice", "sweep", "stuck", "changed", "balance", "extra", "amount", "mode", "pending", "recent",
  "interval", "items", "fixed", "plan", "managed", "discount", "affiliate", "trial", "behind", "state", "paused", "ending", "card",
];
const told = OUTCOMES.map((o) => refusalWords(o));
is("every outcome starts by saying the day stays", told.every((lines) => lines[0] === "Your payment day did not change."), true);
is("every outcome gives a reason", told.every((lines) => lines.length >= 2 && lines[1].length > 0), true);
is("a declined payment does not invite a new choice before the payment is closed", refusalWords("declined"), [
  "Your payment day did not change.",
  "The payment did not go through, so the change was not made.",
  "You can choose a new day once we have closed that payment.",
]);
is("a cause that stays (changed, balance, extra, sweep, stuck) does not invite a new choice", ["changed", "balance", "extra", "sweep", "stuck"].map((o) => refusalWords(o as RunOutcome).length), [2, 2, 2, 2, 2]);
is("timing outcomes say what happened", [refusalWords("early")[1], refusalWords("late")[1], refusalWords("none")[1]], ["The change was not due yet.", "The change could not run at its time.", "There was no change waiting."]);
is("a balance either way, or not read, is said truly", refusalWords("balance")[1], "Your account has a balance, or we could not read it.");
is("state covers a deleted customer or an unknown period too", refusalWords("state")[1], "We could not confirm that your membership is active and up to date.");
is("after the creator is told, the member hears it", refusalWords("stuck").slice(1), ["We are checking a payment on your account. The creator has been told."]);
is("too late near the period's end, with no day offered until the renewal: no invitation", refusalWords("late", { daysOffered: 0 }), ["Your payment day did not change.", "The change could not run at its time."]);
is("too late with days offered: the invitation stays", refusalWords("late", { daysOffered: 3 })[2], "You can choose a new day again.");
is("changed is said neutrally (it may come before any request)", refusalWords("changed")[1], "Your membership's price or billing has changed.");
is("above the ceiling says it would have cost more than a full period", refusalWords("above")[1], "On the day, it would have cost more than one full billing period.");
is("an unproven mode never says the membership is not active", refusalWords("mode")[1], "Changing the payment day is not available for this membership yet.");
is("every sentence is under 21 words", told.flat().flatMap((line) => line.split(/(?<=\.)\s+/)).filter((line) => line.split(/\s+/).length >= 21), []);
is("no British spelling", told.flat().filter((line) => /cancell|colour|centre|favour|licence/i.test(line)), []);

done();
