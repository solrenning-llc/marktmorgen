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
 *     not read (or flexible without the period on its item), a change
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
 *   - after a declined change, the open invoice to void (`openMoveInvoice`)
 *     and the refusal that holds while it stays open;
 *   - the Stripe request bodies, the metadata cleared after a declined or
 *     lapsed run, the idempotency key, and the words shown before confirming.
 */
import {
  FIRST_DAY,
  LAST_DAY,
  META_AT,
  META_CEILING,
  META_DONE,
  META_END,
  META_MONTHS,
  META_ON,
  META_SHOWN,
  META_SIG,
  MOVE_GRACE_SECONDS,
  MOVE_LEAD_SECONDS,
  type BillingDaySub,
  type MovePreview,
  type RequestVerifier,
  cannotMove,
  ceilingOf,
  cannotRun,
  clearMoveBody,
  currentDay,
  dateWords,
  daysOffered,
  localNoon,
  localParts,
  mayRun,
  moveBody,
  moveIdempotencyKey,
  moveDue,
  moveInstant,
  moveOn,
  moveWords,
  openMoveInvoice,
  ordinal,
  paymentsAfter,
  pendingMove,
  periodMonths,
  previewAmount,
  previewCeiling,
  previewMoveBody,
  previewRefusal,
  requestMeta,
  requestSigText,
  runPreviewRefusal,
  shownOf,
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
const verify: RequestVerifier = (s) => {
  const text = requestSigText(s, s.metadata ?? {});
  const sig = s.metadata?.[META_SIG];
  if (text === null || typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return timingSafeEqual(Buffer.from(sign(text), "hex"), Buffer.from(sig, "hex"));
};

function sub(over: Partial<BillingDaySub> & { interval?: string; count?: number; end?: number } = {}): BillingDaySub {
  const { interval = "month", count = 1, end = at("2026-11-20T15:00:00Z"), ...rest } = over;
  const start = addMonths(end, interval === "year" ? -12 : -1);
  return {
    id: "sub_1",
    status: "active",
    billing_mode: { type: "flexible" },
    cancel_at: null,
    cancel_at_period_end: false,
    pause_collection: null,
    discount: null,
    discounts: [],
    schedule: null,
    pending_update: null,
    collection_method: "charge_automatically",
    latest_invoice: { id: "in_1", status: "paid" },
    default_payment_method: { id: "pm_1", type: "card" },
    customer: { id: "cus_1", balance: 0, discount: null, invoice_settings: { default_payment_method: null } },
    metadata: { store: "shop" },
    items: { data: [{ quantity: 1, discounts: [], current_period_start: start, current_period_end: end, price: { recurring: { interval, interval_count: count } } }] },
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
is("a monthly membership running normally may", cannotMove(sub(), NOW, verify), null);
is("a yearly one may", cannotMove(sub({ interval: "year", end: at("2027-06-15T10:00:00Z") }), NOW, verify), null);
is("periodMonths: monthly", periodMonths(sub()), 1);
is("periodMonths: yearly", periodMonths(sub({ interval: "year" })), 12);
is("weekly is refused", cannotMove(sub({ interval: "week" }), NOW, verify), "interval");
is("every three months is refused", cannotMove(sub({ count: 3 }), NOW, verify), "interval");
is("no price schedule is refused", cannotMove({ ...sub(), items: { data: [{ quantity: 1, current_period_end: NOW + DAY, price: { recurring: null } }] } }, NOW, verify), "interval");
is("in a trial is refused", cannotMove(sub({ status: "trialing" }), NOW, verify), "trial");
is("past due is refused", cannotMove(sub({ status: "past_due" }), NOW, verify), "behind");
is("unpaid is refused", cannotMove(sub({ status: "unpaid" }), NOW, verify), "behind");
is("incomplete is refused", cannotMove(sub({ status: "incomplete" }), NOW, verify), "state");
is("canceled is refused", cannotMove(sub({ status: "canceled" }), NOW, verify), "state");
is("paused is refused", cannotMove(sub({ status: "paused" }), NOW, verify), "state");
is("payments paused is refused", cannotMove(sub({ pause_collection: { behavior: "void", resumes_at: NOW + 30 * DAY } }), NOW, verify), "paused");
is("a pause set to start is refused", cannotMove(sub({ metadata: { pause_from: String(NOW + 10 * DAY) } }), NOW, verify), "paused");
is("set to end at the period's end is refused", cannotMove(sub({ cancel_at_period_end: true }), NOW, verify), "ending");
is("set to end on a date is refused", cannotMove(sub({ cancel_at: NOW + 40 * DAY }), NOW, verify), "ending");
is("sold to end after a set number of payments is refused", cannotMove(sub({ metadata: { ends_after: "6" } }), NOW, verify), "fixed");
is("a payment plan is refused", cannotMove(sub({ metadata: { kind: "plan" } }), NOW, verify), "plan");
is("two items are refused", cannotMove({ ...sub(), items: { data: [sub().items!.data![0], sub().items!.data![0]] } }, NOW, verify), "items");
is("no items: no price schedule to read, refused", cannotMove({ ...sub(), items: { data: [] } }, NOW, verify), "interval");
is("two of one item are refused", cannotMove({ ...sub(), items: { data: [{ ...sub().items!.data![0], quantity: 2 }] } }, NOW, verify), "items");
is("a discount is refused", cannotMove(sub({ discount: { id: "di_1" } }), NOW, verify), "discount");
is("discounts are refused", cannotMove(sub({ discounts: ["di_1"] }), NOW, verify), "discount");
is("a discount on the item is refused", cannotMove(withItem(sub(), { discounts: ["di_item_3_months"] }), NOW, verify), "discount");
is("a discount on the customer is refused", cannotMove(sub({ customer: { id: "cus_1", balance: 0, discount: { id: "di_c" } } }), NOW, verify), "discount");
is("a last invoice still open is refused", cannotMove(sub({ latest_invoice: { id: "in_1", status: "open", amount_remaining: 1000 } }), NOW, verify), "invoice");
is("a last invoice not read (not expanded) is refused", cannotMove(sub({ latest_invoice: "in_1" }), NOW, verify), "invoice");
is("no last invoice is refused", cannotMove(sub({ latest_invoice: null }), NOW, verify), "invoice");
is("a customer who owes a balance is refused", cannotMove(sub({ customer: { id: "cus_1", balance: 500 } }), NOW, verify), "balance");
is("a customer holding a credit is refused", cannotMove(sub({ customer: { id: "cus_1", balance: -500 } }), NOW, verify), "balance");
is("a customer not read (not expanded) is refused", cannotMove(sub({ customer: "cus_1" }), NOW, verify), "balance");
is("a deleted customer is refused", cannotMove(sub({ customer: { id: "cus_1", deleted: true } }), NOW, verify), "state");
is("a bank debit that settles later is refused", cannotMove(sub({ default_payment_method: { id: "pm_1", type: "us_bank_account" } }), NOW, verify), "card");
is("a SEPA debit is refused", cannotMove(sub({ default_payment_method: { id: "pm_1", type: "sepa_debit" } }), NOW, verify), "card");
is("a payment method not read (not expanded) is refused", cannotMove(sub({ default_payment_method: "pm_1" }), NOW, verify), "card");
is(
  "the customer's default card is read when the subscription has none",
  cannotMove(sub({ default_payment_method: null, customer: { id: "cus_1", balance: 0, invoice_settings: { default_payment_method: { id: "pm_2", type: "card" } } } }), NOW, verify),
  null,
);
is(
  "the customer's default bank debit is refused",
  cannotMove(sub({ default_payment_method: null, customer: { id: "cus_1", balance: 0, invoice_settings: { default_payment_method: { id: "pm_2", type: "us_bank_account" } } } }), NOW, verify),
  "card",
);
is("an old source is refused", cannotMove(sub({ default_payment_method: null, default_source: "src_1" }), NOW, verify), "card");
is("no payment method at all is refused", cannotMove(sub({ default_payment_method: null }), NOW, verify), "card");
is(
  "an affiliate share for a set number of months, still running, is refused",
  cannotMove(sub({ metadata: { via: "ann", via_months: "3", via_at: String(NOW - 30 * DAY) } }), NOW, verify),
  "affiliate",
);
is(
  "an affiliate share whose months are over is not",
  cannotMove(sub({ metadata: { via: "ann", via_months: "3", via_at: String(NOW - 200 * DAY) } }), NOW, verify),
  null,
);
is(
  "an affiliate share for as long as the member pays is not",
  cannotMove(sub({ metadata: { via: "ann", via_months: String(RECURRING_ALWAYS), via_at: String(NOW - 30 * DAY) } }), NOW, verify),
  null,
);
is("a subscription schedule is refused", cannotMove(sub({ schedule: "sub_sched_1" }), NOW, verify), "managed");
is("a pending update is refused", cannotMove(sub({ pending_update: { expires_at: NOW + DAY } }), NOW, verify), "managed");
is("paying by invoice is refused", cannotMove(sub({ collection_method: "send_invoice" }), NOW, verify), "managed");
is("no period end known is refused", cannotMove({ ...sub(), items: { data: [{ quantity: 1, price: { recurring: { interval: "month" } } }] } }, NOW, verify), "state");
is("classic: the period end on the subscription is read when the item has none", cannotMove({ ...sub(), billing_mode: { type: "classic" }, current_period_end: NOW + 10 * DAY, items: { data: [{ quantity: 1, price: { recurring: { interval: "month" } } }] } }, NOW, verify), null);

part("Once a billing period, counted by completed changes, and one change waiting at a time");
const waiting = sub({ metadata: req(sub(), NOW + 3 * DAY) });
is("a change waiting refuses another", cannotMove(waiting, NOW, verify), "pending");
is("pendingMove reads it", pendingMove(waiting, NOW, verify), NOW + 3 * DAY);
is("changed 10 days ago on a monthly membership: refused", cannotMove(sub({ metadata: { [META_DONE]: String(NOW - 10 * DAY) } }), NOW, verify), "recent");
is("changed a calendar month ago less one second: refused", cannotMove(sub({ metadata: { [META_DONE]: String(at("2026-10-04T12:00:01Z")) } }), NOW, verify), "recent");
is("changed exactly a calendar month ago: allowed", cannotMove(sub({ metadata: { [META_DONE]: String(at("2026-10-04T12:00:00Z")) } }), NOW, verify), null);
is("yearly, changed 200 days ago: refused", cannotMove(sub({ interval: "year", end: at("2027-06-15T10:00:00Z"), metadata: { [META_DONE]: String(NOW - 200 * DAY) } }), NOW, verify), "recent");
is("yearly, changed 370 days ago: allowed", cannotMove(sub({ interval: "year", end: at("2027-06-15T10:00:00Z"), metadata: { [META_DONE]: String(NOW - 370 * DAY) } }), NOW, verify), null);
is("asked 10 days ago, never completed: allowed", cannotMove(sub({ metadata: { [META_AT]: String(NOW - 10 * DAY) } }), NOW, verify), null);
{
  // Asked on November 4; the run on November 10 was declined (402: Stripe
  // changed nothing, so the request stays in the metadata) or it lapsed.
  const lapsedOn = at("2026-11-10T12:00:00Z");
  const lapsed = sub({ metadata: req(sub(), lapsedOn) });
  const later = lapsedOn + MOVE_GRACE_SECONDS + 60;
  is("after a declined or lapsed run, the member may ask again", cannotMove(lapsed, later, verify), null);
  is("and days are offered again", daysOffered(lapsed, "UTC", later, verify).length > 0, true);
  is("while its grace runs, it still waits", cannotMove(lapsed, lapsedOn + 60, verify), "pending");
}
is("a stale change, past its grace, no longer waits", pendingMove(sub({ metadata: req(sub(), NOW - MOVE_GRACE_SECONDS - 1) }), NOW, verify), null);
is("garbage in the metadata is read as nothing", cannotMove(sub({ metadata: { [META_DONE]: "soon", [META_ON]: "x" } }), NOW, verify), null);
is("nothing is offered while refused", daysOffered(sub({ status: "trialing" }), "UTC", NOW, verify), []);

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
const offered = daysOffered(monthly, "UTC", NOW, verify);
is("days 5 to 19 are offered", offered.map((o) => o.day), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
is("each is before the payment due and a day ahead", offered.every((o) => o.on < at("2026-11-20T15:00:00Z") && o.on >= NOW + MOVE_LEAD_SECONDS), true);
is("every offered day lies within 1 to 28", offered.every((o) => o.day >= FIRST_DAY && o.day <= LAST_DAY), true);
const nextPeriod = daysOffered(sub({ end: at("2026-12-20T15:00:00Z") }), "UTC", at("2026-11-21T00:00:00Z"), verify);
is("after the payment, the later days come back, still in November", nextPeriod.filter((o) => o.day > 20).map((o) => new Date(o.on * 1000).toISOString().slice(0, 10)), ["2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28"]);
is("and the earlier ones fall in December, before the payment due", nextPeriod.filter((o) => o.day < 20).map((o) => o.day).length, 19);

part("Month ends: a member billed on the 31st");
const jan31 = sub({ end: at("2027-01-31T08:00:00Z") });
is("current day is the 31st, so all of 1 to 28 can be chosen", currentDay(jan31, "UTC"), 31);
is("the 28th: January 28", moveOn(jan31, 28, "UTC", at("2027-01-05T12:00:00Z")), at("2027-01-28T12:00:00Z"));
is("days 6 to 28 offered on January 5", daysOffered(jan31, "UTC", at("2027-01-05T12:00:00Z"), verify).map((o) => o.day).join(","), "6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28");
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
is("every offered day is less than a month before the payment due", daysOffered(yearly, "UTC", NOW, verify).every((o) => at("2027-06-15T10:00:00Z") - o.on < 31 * DAY), true);
is("27 days offered (all but the 15th)", daysOffered(yearly, "UTC", NOW, verify).length, 27);

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
      for (const o of daysOffered(s, zone, now, verify)) {
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
  { [META_AT]: String(NOW), [META_ON]: String(on), [META_SHOWN]: "1834", [META_CEILING]: "2540", [META_END]: String(at("2026-11-20T15:00:00Z")), [META_MONTHS]: "1", [META_SIG]: "" },
);
is(
  "the text signed names the subscription, the customer and every field",
  requestSigText(base, meta),
  `billing-day:v1|sub_1|cus_1|${NOW}|${on}|1834|2540|${at("2026-11-20T15:00:00Z")}|1`,
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
is("an edited request is no request: it does not wait, and cannot run", [pendingMove(edited, on, verify), cannotRun(edited, on + 60, verify)], [null, "due"]);
is("an edited request does not stop the member asking again", cannotMove(edited, NOW, verify), null);
const moved = sub({ metadata: { ...meta, [META_ON]: String(on - DAY) } });
is("an edited moment is not read", pendingMove(moved, NOW, verify), null);
const copied = sub({ id: "sub_2", metadata: meta });
is("a request copied from another subscription is not read", [pendingMove(copied, NOW, verify), shownOf(copied, verify), cannotRun(copied, on + 60, verify)], [null, null, "due"]);
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
is("a membership with no period end keeps no request", requestMeta({ ...base, items: { data: [{ quantity: 1, price: { recurring: { interval: "month" } } }] } }, on, 1834, 2540, NOW, sign), null);
is("no amount kept reads as null", [shownOf(sub(), verify), ceilingOf(sub(), verify)], [null, null]);
is("before its moment: waiting, not due", [pendingMove(pending, on - 60, verify), moveDue(pending, on - 60, verify)], [on, false]);
is("before its moment: may not run", cannotRun(pending, on - 60, verify), "due");
is("at its moment: due", moveDue(pending, on, verify), true);
is("an hour late: may run", cannotRun(pending, on + 3600, verify), null);
is("past its grace: lapsed", [moveDue(pending, on + MOVE_GRACE_SECONDS, verify), cannotRun(pending, on + MOVE_GRACE_SECONDS, verify)], [false, "due"]);
is("behind on a payment by then: may not run", cannotRun({ ...pending, status: "past_due" }, on + 60, verify), "behind");
is("set to end by then: may not run", cannotRun({ ...pending, cancel_at_period_end: true }, on + 60, verify), "ending");
is("a discount added by then: may not run", cannotRun({ ...pending, discounts: ["di_1"] }, on + 60, verify), "discount");
is("a balance added by then: may not run", cannotRun({ ...pending, customer: { id: "cus_1", balance: 300 } }, on + 60, verify), "balance");
is("the card swapped for a bank debit by then: may not run", cannotRun({ ...pending, default_payment_method: { id: "pm_9", type: "us_bank_account" } }, on + 60, verify), "card");
is("the billing mode no longer read by then: may not run", cannotRun({ ...pending, billing_mode: null }, on + 60, verify), "state");
is(
  "the period moved on since the request (a new period end): may not run",
  cannotRun(sub({ end: at("2026-12-20T15:00:00Z"), metadata: meta }), on + 60, verify),
  "changed",
);
is(
  "switched to yearly since the request, same moment: may not run",
  cannotRun(sub({ interval: "year", end: at("2027-11-05T09:00:00Z"), metadata: req(base, on) }), on + 30, verify),
  "changed",
);
is("months kept do not match (yearly kept and signed, monthly now): may not run", cannotRun(sub({ metadata: resigned(base, { ...meta, [META_MONTHS]: "12" }) }), on + 60, verify), "changed");
is("a request without its period is not read: nothing runs", cannotRun(sub({ metadata: { [META_AT]: String(NOW), [META_ON]: String(on), [META_SHOWN]: "1834" } }), on + 60, verify), "due");
is(
  "its moment before the current period started: may not run",
  cannotRun(withItem(pending, { current_period_start: on + 1 }), on + 60, verify),
  "changed",
);
is("no current period start known: may not run", cannotRun({ ...withItem(pending, { current_period_start: undefined }), billing_mode: { type: "classic" } }, on + 60, verify), "changed");
is("its moment at or after the period end: may not run", cannotRun(sub({ end: on, metadata: req(sub({ end: on }), on) }), on + 60, verify), "due");
is("no change waiting: nothing to run", cannotRun(sub(), on, verify), "due");
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
is("a clean preview: shown is amount_due", [previewRefusal(clean), previewAmount(clean)], [null, 667]);
is("its ceiling is the new period's line", previewCeiling(clean), 1000);
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
is("with 27% tax on top: shown is amount_due, tax included", [previewRefusal(taxed), previewAmount(taxed)], [null, 847]);
is("with 27% tax on top: the ceiling is the new month with its tax", previewCeiling(taxed), 1270);
const inclusive: MovePreview = { ...taxed, lines: { data: [subLine(-333, true), subLine(1000, false, { taxes: [{ amount: 213, tax_behavior: "inclusive" }] })] }, amount_due: 667 };
is("a tax included in the price is already in the line", previewCeiling(inclusive), 1000);
is("a tax whose behavior is not read: no ceiling", previewCeiling({ ...clean, lines: { data: [subLine(1000, false, { taxes: [{ amount: 270 }] })] } }), null);
is("the older tax_amounts form: no ceiling", previewCeiling({ ...clean, lines: { data: [subLine(1000, false, { tax_amounts: [{ amount: 270, inclusive: false }] })] } }), null);
is("a line whose proration is not read: no ceiling", previewCeiling({ ...clean, lines: { data: [{ amount: 1000, parent: { type: "subscription_item_details", subscription_item_details: {} } }] } }), null);
is("only prorations, no new period: no ceiling", previewCeiling({ ...clean, lines: { data: [subLine(-333, true)] } }), null);
is("a discount on the new period comes off the ceiling", previewCeiling({ ...clean, lines: { data: [subLine(1000, false, { discount_amounts: [{ amount: 200 }] })] } }), 800);
is("a preview with no ceiling is refused", previewRefusal({ ...clean, lines: { data: [subLine(-333, true)] }, amount_due: 0 }), "amount");
is("a preview due above its own ceiling is refused", previewRefusal({ ...clean, amount_due: 1001 }), "amount");
is("amount_due includes tax added on top", previewAmount({ ...clean, amount_due: 726 }), 726);
const withItemLine: MovePreview = {
  starting_balance: 0,
  amount_due: 1000 - 333 + 500,
  lines: { data: [subLine(-333, true), subLine(1000, false), { amount: 500, parent: { type: "invoice_item_details", invoice_item_details: { proration: false, invoice_item: "ii_1" } } }] },
};
is("a pending invoice item on the invoice is refused", [previewRefusal(withItemLine), previewAmount(withItemLine)], ["extra", null]);
is("a line from nowhere known is refused", previewRefusal({ ...clean, lines: { data: [...clean.lines!.data!, { amount: 100 }] } }), "extra");
is("an old-style invoice item line is refused", previewRefusal({ ...clean, lines: { data: [...clean.lines!.data!, { amount: 100, type: "invoiceitem", proration: false }] } }), "extra");
const owes: MovePreview = { starting_balance: 200, amount_due: 867, lines: { data: [subLine(-333, true), subLine(1000, false)] } };
is("a balance owed on the invoice is refused", [previewRefusal(owes), previewAmount(owes)], ["balance", null]);
is("a credit on the invoice is refused", previewRefusal({ ...clean, starting_balance: -100, amount_due: 567 }), "balance");
is("no starting balance read is refused", previewRefusal({ amount_due: 667, lines: clean.lines }), "balance");
is("more lines than one page is refused", previewRefusal({ ...clean, lines: { ...clean.lines, has_more: true } }), "extra");
is("no amount_due read is refused", previewRefusal({ starting_balance: 0, lines: clean.lines }), "amount");
is("a negative amount_due is refused", previewRefusal({ ...clean, amount_due: -1 }), "amount");
is("no lines is refused", previewRefusal({ starting_balance: 0, amount_due: 0, lines: { data: [] } }), "extra");

part("The fresh preview at the moment of the change: bounded by the ceiling, never more than a full period");
// Asked with the taxed preview: shown $8.47, ceiling $12.70.
const asked = sub({ metadata: req(base, on, 847, 1270) });
is("fresh preview the same: may run", runPreviewRefusal(asked, taxed, verify), null);
const fresher = (due: number): MovePreview => ({ ...taxed, amount_due: due });
is("fresh preview above the amount shown but under the ceiling: may run (flexible mode credits what was paid)", runPreviewRefusal(asked, fresher(1100), verify), null);
is("fresh preview exactly the ceiling: may run", runPreviewRefusal(asked, fresher(1270), verify), null);
is("fresh preview above the ceiling: may not run", runPreviewRefusal(asked, { ...taxed, amount_due: 1271, lines: { data: [subLine(1001, false, { taxes: [{ amount: 270, tax_behavior: "exclusive" }] })] } }, verify), "above");
is("fresh preview with a pending invoice item: may not run", runPreviewRefusal(asked, withItemLine, verify), "extra");
is("fresh preview with a balance: may not run", runPreviewRefusal(asked, owes, verify), "balance");
is("no ceiling kept with the request: may not run", runPreviewRefusal(sub(), clean, verify), "above");
is("an edited ceiling is not read: may not run", runPreviewRefusal(sub({ metadata: { ...req(base, on, 847, 1270), [META_CEILING]: "99999" } }), fresher(1100), verify), "above");

part("mayRun: the only door to the change");
is("due, running normally, fresh preview under the ceiling: may run", mayRun(asked, fresher(1100), on + 60, verify), null);
is("before its moment: due", mayRun(asked, taxed, on - 60, verify), "due");
is("past its grace: due", mayRun(asked, taxed, on + MOVE_GRACE_SECONDS, verify), "due");
is("the membership no longer running normally comes first", mayRun({ ...asked, status: "past_due" }, taxed, on + 60, verify), "behind");
is("the period changed: changed", mayRun(sub({ end: at("2026-12-20T15:00:00Z"), metadata: asked.metadata }), taxed, on + 60, verify), "changed");
is("fresh preview above the ceiling: above", mayRun(asked, { ...taxed, amount_due: 1300, lines: { data: [subLine(1030, false, { taxes: [{ amount: 270, tax_behavior: "exclusive" }] })] } }, on + 60, verify), "above");
is("fresh preview with a balance: balance", mayRun(asked, owes, on + 60, verify), "balance");
is("an edited request: nothing to run", mayRun(sub({ metadata: { ...asked.metadata!, [META_SHOWN]: "1" } }), taxed, on + 60, verify), "due");
is("a request copied from another subscription: nothing to run", mayRun({ ...asked, id: "sub_2" }, taxed, on + 60, verify), "due");

part("Billing mode: read, or refused");
const classic = sub({ billing_mode: { type: "classic" } });
is("flexible, with its period on the item: may move", cannotMove(sub(), NOW, verify), null);
is("classic, with a full record: may move", cannotMove(classic, NOW, verify), null);
is("no billing mode read: refused", cannotMove(sub({ billing_mode: undefined }), NOW, verify), "state");
is("a billing mode of null: refused", cannotMove(sub({ billing_mode: null }), NOW, verify), "state");
is("an unknown billing mode: refused", cannotMove(sub({ billing_mode: { type: "hybrid" } }), NOW, verify), "state");
is(
  "flexible with the period end only on the subscription: refused",
  cannotMove({ ...sub(), current_period_start: NOW - 10 * DAY, current_period_end: NOW + 10 * DAY, items: { data: [{ quantity: 1, price: { recurring: { interval: "month" } } }] } }, NOW, verify),
  "state",
);
is("flexible with no period start on the item: refused", cannotMove(withItem(sub(), { current_period_start: undefined }), NOW, verify), "state");
is(
  "classic with the period end only on the subscription: may move",
  cannotMove({ ...classic, current_period_end: NOW + 10 * DAY, items: { data: [{ quantity: 1, price: { recurring: { interval: "month" } } }] } }, NOW, verify),
  null,
);
is("classic, its last invoice expanded and paid, a request runs", cannotRun(sub({ billing_mode: { type: "classic" }, latest_invoice: { id: "in_7", status: "paid" }, metadata: meta }), on + 60, verify), null);

part("After a declined change (402): the open invoice it left");
is("a new open invoice is the one to void", openMoveInvoice({ id: "in_1" }, { id: "in_2", status: "open" }), "in_2");
is("no last invoice before, a new open one after: void it", openMoveInvoice(null, { id: "in_2", status: "open" }), "in_2");
is("the same last invoice as before: nothing to void", openMoveInvoice({ id: "in_1" }, { id: "in_1", status: "open" }), null);
is("a new invoice already paid: nothing to void", openMoveInvoice({ id: "in_1" }, { id: "in_2", status: "paid" }), null);
is("a new invoice already void: nothing to void", openMoveInvoice({ id: "in_1" }, { id: "in_2", status: "void" }), null);
is("a draft: nothing to void (only an open invoice is)", openMoveInvoice({ id: "in_1" }, { id: "in_2", status: "draft" }), null);
is("nothing read after: nothing to void", openMoveInvoice({ id: "in_1" }, null), null);
is("an id not as Stripe writes it: nothing to void", openMoveInvoice({ id: "in_1" }, { id: "in_2/../x", status: "open" }), null);
is(
  "while that invoice stays open (it could not be voided), the member is refused",
  cannotMove(sub({ latest_invoice: { id: "in_2", status: "open", amount_remaining: 847 } }), on + MOVE_GRACE_SECONDS + 60, verify),
  "invoice",
);
is(
  "once it is void, the last invoice paid before it is read again and the member may ask",
  cannotMove(sub({ latest_invoice: { id: "in_1", status: "paid" } }), on + MOVE_GRACE_SECONDS + 60, verify),
  null,
);

part("The Stripe requests");
const preview = previewMoveBody("cus_1", "sub_1", "si_1", on);
is("the preview names the subscription and its item", [preview.get("customer"), preview.get("subscription"), preview.get("subscription_details[items][0][id]")], ["cus_1", "sub_1", "si_1"]);
is("the unchanged item's price is left out, as Stripe asks", [preview.has("subscription_details[items][0][price]"), preview.has("subscription_details[items][0][price_data]")], [false, false]);
is("the preview resets the anchor now, invoicing prorations, at the second it will run", [preview.get("subscription_details[billing_cycle_anchor][type]"), preview.get("subscription_details[proration_behavior]"), preview.get("subscription_details[proration_date]")], ["now", "always_invoice", String(on)]);
const change = moveBody(on);
const REQUEST = [META_AT, META_ON, META_SHOWN, META_CEILING, META_END, META_MONTHS, META_SIG];
is("the change resets the anchor now at the previewed second", [change.get("billing_cycle_anchor[type]"), change.get("proration_behavior"), change.get("proration_date")], ["now", "always_invoice", String(on)]);
is("the change is refused if its payment fails", change.get("payment_behavior"), "error_if_incomplete");
is("the change is charged with nobody present, as lib/billing.ts does", change.get("off_session"), "true");
is("the change clears the request, its ceiling and its signature", REQUEST.map((key) => change.get(`metadata[${key}]`)), ["", "", "", "", "", "", ""]);
is("the change marks itself done at its moment, applied only if the update succeeds", change.get(`metadata[${META_DONE}]`), String(on));
is("the change never starts a trial or turns prorations off", [change.has("trial_end"), change.get("proration_behavior") !== "none"], [false, true]);
const cleared = clearMoveBody();
is("a declined or lapsed run clears the request, its ceiling and its signature", REQUEST.map((key) => cleared.get(`metadata[${key}]`)), ["", "", "", "", "", "", ""]);
is("clearing never marks the change done and changes nothing else", [cleared.has(`metadata[${META_DONE}]`), [...cleared.keys()].every((key) => key.startsWith("metadata["))], [false, true]);
is("a cleared request leaves the member free to ask again", cannotMove(sub({ metadata: { store: "shop" } }), on + MOVE_GRACE_SECONDS + 60, verify), null);
is("the idempotency key names the subscription and the moment", moveIdempotencyKey("sub_1", on), `billing-day:sub_1:${on}`);
is("the change completed now counts as this period's change", cannotMove(sub({ end: addMonths(on, 1), metadata: { store: "shop", [META_DONE]: String(on) } }), on + DAY, verify), "recent");

part("The words shown before confirming");
is("ordinals", [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "28th"]);
is("a US date", dateWords(at("2026-11-10T12:00:00Z"), "UTC"), "Tuesday, November 10, 2026");
is("a date in Auckland is its own", dateWords(at("2026-11-30T23:00:00Z"), "Pacific/Auckland"), "Tuesday, December 1, 2026");
const words = moveWords({ from: at("2026-11-20T15:00:00Z"), on, months: 1, amount: "$8.47", ceiling: "$12.70", timeZone: "UTC" });
is("monthly words", words, [
  "Your next payment moves from Friday, November 20, 2026, to Tuesday, November 10, 2026.",
  "On Tuesday, November 10, 2026, you pay one full month, less the days you already paid for.",
  "Today, Stripe works that out as $8.47.",
  "It is never more than one full month, $12.70. If it would be, nothing changes.",
  "After that, you pay on the 10th of each month.",
  "If that payment fails, your payment day stays the same.",
  "You can change the day once a month.",
]);
const yearWords = moveWords({ from: at("2027-06-15T10:00:00Z"), on: at("2027-06-03T12:00:00Z"), months: 12, amount: "$12.00", ceiling: "$480.00", timeZone: "America/New_York" });
is("yearly words name the month and day, as a US date", yearWords[4], "After that, you pay every year on June 3.");
is("yearly words bound the payment by a full year", yearWords[3], "It is never more than one full year, $480.00. If it would be, nothing changes.");
is("no sentence promises the member never pays more (later payments are the full price)", [...words, ...yearWords].some((line) => /never pay more/.test(line)), false);
is("no sentence promises the amount shown is the most charged (it may differ on the day)", [...words, ...yearWords].some((line) => /not be more than this amount|exactly/.test(line)), false);
is("yearly words say once a year", yearWords[6], "You can change the day once a year.");
const aklWords = moveWords({ from: at("2026-12-14T23:00:00Z"), on: akl, months: 1, amount: "NZ$20.00", ceiling: "NZ$23.00", timeZone: "Pacific/Auckland" });
is("Auckland words use the local day", aklWords[4], "After that, you pay on the 1st of each month.");
const sentences = [...words, ...yearWords, ...aklWords].flatMap((line) => line.split(/(?<=\.)\s+/));
is("every sentence is under 20 words", sentences.filter((s) => s.split(/\s+/).length >= 20), []);
is("no British spelling", [...words, ...yearWords].filter((s) => /cancell|colour|centre|favour|licence/i.test(s)), []);
is("the amount and the ceiling appear as given, once each", [words.filter((s) => s.includes("$8.47")).length, words.filter((s) => s.includes("$12.70")).length], [1, 1]);
is("an unknown zone falls back to UTC", moveWords({ from: NOW + 10 * DAY, on: NOW + 5 * DAY, months: 1, amount: "$1.00", ceiling: "$2.00", timeZone: "Nowhere/Here" })[1], "On Monday, November 9, 2026, you pay one full month, less the days you already paid for.");

done();
