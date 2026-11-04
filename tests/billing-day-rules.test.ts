/**
 * A member moving the day their own membership is charged: the rules only
 * (lib/billing-day-rules.ts; 630 [HN6], item 13, unit 1). Synthetic
 * subscriptions only; nothing here reaches Stripe. Checked:
 *
 *   - every refusal: the schedule, a trial, a payment behind, other states,
 *     a pause, an end, a payment plan, items, a discount (on the
 *     subscription, an item or the customer), an affiliate's share for set
 *     months, a schedule or pending update, a last invoice not paid, a
 *     customer balance, a payment method that is not a card, a change
 *     waiting, and once a billing period, counted only by completed changes;
 *   - the days offered: 1 to 28, never the day paid on now, only before the
 *     payment already due and at least a day ahead;
 *   - the date math: noon where the member lives, across month ends (31st to
 *     28th), leap years and daylight-saving changes, and the payments after;
 *   - when a waiting change may run: never when the period changed since the
 *     request, never when the fresh preview at run time is above the amount
 *     shown, and never with pending invoice items or a balance on the invoice;
 *   - the amount shown is the preview's whole amount_due;
 *   - the Stripe request bodies, the metadata cleared after a declined or
 *     lapsed run, the idempotency key, and the words shown before confirming.
 */
import {
  FIRST_DAY,
  LAST_DAY,
  META_AT,
  META_DONE,
  META_END,
  META_MONTHS,
  META_ON,
  META_SHOWN,
  MOVE_GRACE_SECONDS,
  MOVE_LEAD_SECONDS,
  type BillingDaySub,
  cannotMove,
  cannotRun,
  clearMoveBody,
  currentDay,
  dateWords,
  daysOffered,
  localNoon,
  localParts,
  moveBody,
  moveIdempotencyKey,
  moveDue,
  moveInstant,
  moveOn,
  moveWords,
  ordinal,
  paymentsAfter,
  pendingMove,
  periodMonths,
  previewAmount,
  previewMoveBody,
  previewRefusal,
  requestMeta,
  runPreviewRefusal,
  shownOf,
  withinShown,
  zoneOf,
} from "@/lib/billing-day-rules";
import { RECURRING_ALWAYS } from "@/lib/affiliate-setting";
import { addMonths } from "@/lib/membership-pause-rules";
import { done, is, part } from "./check";

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const DAY = 86_400;

function sub(over: Partial<BillingDaySub> & { interval?: string; count?: number; end?: number } = {}): BillingDaySub {
  const { interval = "month", count = 1, end = at("2026-11-20T15:00:00Z"), ...rest } = over;
  const start = addMonths(end, interval === "year" ? -12 : -1);
  return {
    status: "active",
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

part("Who may move the day");
is("a monthly membership running normally may", cannotMove(sub(), NOW), null);
is("a yearly one may", cannotMove(sub({ interval: "year", end: at("2027-06-15T10:00:00Z") }), NOW), null);
is("periodMonths: monthly", periodMonths(sub()), 1);
is("periodMonths: yearly", periodMonths(sub({ interval: "year" })), 12);
is("weekly is refused", cannotMove(sub({ interval: "week" }), NOW), "interval");
is("every three months is refused", cannotMove(sub({ count: 3 }), NOW), "interval");
is("no price schedule is refused", cannotMove({ ...sub(), items: { data: [{ quantity: 1, current_period_end: NOW + DAY, price: { recurring: null } }] } }, NOW), "interval");
is("in a trial is refused", cannotMove(sub({ status: "trialing" }), NOW), "trial");
is("past due is refused", cannotMove(sub({ status: "past_due" }), NOW), "behind");
is("unpaid is refused", cannotMove(sub({ status: "unpaid" }), NOW), "behind");
is("incomplete is refused", cannotMove(sub({ status: "incomplete" }), NOW), "state");
is("canceled is refused", cannotMove(sub({ status: "canceled" }), NOW), "state");
is("paused is refused", cannotMove(sub({ status: "paused" }), NOW), "state");
is("payments paused is refused", cannotMove(sub({ pause_collection: { behavior: "void", resumes_at: NOW + 30 * DAY } }), NOW), "paused");
is("a pause set to start is refused", cannotMove(sub({ metadata: { pause_from: String(NOW + 10 * DAY) } }), NOW), "paused");
is("set to end at the period's end is refused", cannotMove(sub({ cancel_at_period_end: true }), NOW), "ending");
is("set to end on a date is refused", cannotMove(sub({ cancel_at: NOW + 40 * DAY }), NOW), "ending");
is("sold to end after a set number of payments is refused", cannotMove(sub({ metadata: { ends_after: "6" } }), NOW), "fixed");
is("a payment plan is refused", cannotMove(sub({ metadata: { kind: "plan" } }), NOW), "plan");
is("two items are refused", cannotMove({ ...sub(), items: { data: [sub().items!.data![0], sub().items!.data![0]] } }, NOW), "items");
is("no items: no price schedule to read, refused", cannotMove({ ...sub(), items: { data: [] } }, NOW), "interval");
is("two of one item are refused", cannotMove({ ...sub(), items: { data: [{ ...sub().items!.data![0], quantity: 2 }] } }, NOW), "items");
is("a discount is refused", cannotMove(sub({ discount: { id: "di_1" } }), NOW), "discount");
is("discounts are refused", cannotMove(sub({ discounts: ["di_1"] }), NOW), "discount");
is("a discount on the item is refused", cannotMove(withItem(sub(), { discounts: ["di_item_3_months"] }), NOW), "discount");
is("a discount on the customer is refused", cannotMove(sub({ customer: { id: "cus_1", balance: 0, discount: { id: "di_c" } } }), NOW), "discount");
is("a last invoice still open is refused", cannotMove(sub({ latest_invoice: { id: "in_1", status: "open", amount_remaining: 1000 } }), NOW), "invoice");
is("a last invoice not read (not expanded) is refused", cannotMove(sub({ latest_invoice: "in_1" }), NOW), "invoice");
is("no last invoice is refused", cannotMove(sub({ latest_invoice: null }), NOW), "invoice");
is("a customer who owes a balance is refused", cannotMove(sub({ customer: { id: "cus_1", balance: 500 } }), NOW), "balance");
is("a customer holding a credit is refused", cannotMove(sub({ customer: { id: "cus_1", balance: -500 } }), NOW), "balance");
is("a customer not read (not expanded) is refused", cannotMove(sub({ customer: "cus_1" }), NOW), "balance");
is("a deleted customer is refused", cannotMove(sub({ customer: { id: "cus_1", deleted: true } }), NOW), "state");
is("a bank debit that settles later is refused", cannotMove(sub({ default_payment_method: { id: "pm_1", type: "us_bank_account" } }), NOW), "card");
is("a SEPA debit is refused", cannotMove(sub({ default_payment_method: { id: "pm_1", type: "sepa_debit" } }), NOW), "card");
is("a payment method not read (not expanded) is refused", cannotMove(sub({ default_payment_method: "pm_1" }), NOW), "card");
is(
  "the customer's default card is read when the subscription has none",
  cannotMove(sub({ default_payment_method: null, customer: { id: "cus_1", balance: 0, invoice_settings: { default_payment_method: { id: "pm_2", type: "card" } } } }), NOW),
  null,
);
is(
  "the customer's default bank debit is refused",
  cannotMove(sub({ default_payment_method: null, customer: { id: "cus_1", balance: 0, invoice_settings: { default_payment_method: { id: "pm_2", type: "us_bank_account" } } } }), NOW),
  "card",
);
is("an old source is refused", cannotMove(sub({ default_payment_method: null, default_source: "src_1" }), NOW), "card");
is("no payment method at all is refused", cannotMove(sub({ default_payment_method: null }), NOW), "card");
is(
  "an affiliate share for a set number of months, still running, is refused",
  cannotMove(sub({ metadata: { via: "ann", via_months: "3", via_at: String(NOW - 30 * DAY) } }), NOW),
  "affiliate",
);
is(
  "an affiliate share whose months are over is not",
  cannotMove(sub({ metadata: { via: "ann", via_months: "3", via_at: String(NOW - 200 * DAY) } }), NOW),
  null,
);
is(
  "an affiliate share for as long as the member pays is not",
  cannotMove(sub({ metadata: { via: "ann", via_months: String(RECURRING_ALWAYS), via_at: String(NOW - 30 * DAY) } }), NOW),
  null,
);
is("a subscription schedule is refused", cannotMove(sub({ schedule: "sub_sched_1" }), NOW), "managed");
is("a pending update is refused", cannotMove(sub({ pending_update: { expires_at: NOW + DAY } }), NOW), "managed");
is("paying by invoice is refused", cannotMove(sub({ collection_method: "send_invoice" }), NOW), "managed");
is("no period end known is refused", cannotMove({ ...sub(), items: { data: [{ quantity: 1, price: { recurring: { interval: "month" } } }] } }, NOW), "state");
is("the period end on the subscription is read when the item has none", cannotMove({ ...sub(), current_period_end: NOW + 10 * DAY, items: { data: [{ quantity: 1, price: { recurring: { interval: "month" } } }] } }, NOW), null);

part("Once a billing period, counted by completed changes, and one change waiting at a time");
const waiting = sub({ metadata: { [META_AT]: String(NOW - 40 * DAY), [META_ON]: String(NOW + 3 * DAY) } });
is("a change waiting refuses another", cannotMove(waiting, NOW), "pending");
is("pendingMove reads it", pendingMove(waiting, NOW), NOW + 3 * DAY);
is("changed 10 days ago on a monthly membership: refused", cannotMove(sub({ metadata: { [META_DONE]: String(NOW - 10 * DAY) } }), NOW), "recent");
is("changed a calendar month ago less one second: refused", cannotMove(sub({ metadata: { [META_DONE]: String(at("2026-10-04T12:00:01Z")) } }), NOW), "recent");
is("changed exactly a calendar month ago: allowed", cannotMove(sub({ metadata: { [META_DONE]: String(at("2026-10-04T12:00:00Z")) } }), NOW), null);
is("yearly, changed 200 days ago: refused", cannotMove(sub({ interval: "year", end: at("2027-06-15T10:00:00Z"), metadata: { [META_DONE]: String(NOW - 200 * DAY) } }), NOW), "recent");
is("yearly, changed 370 days ago: allowed", cannotMove(sub({ interval: "year", end: at("2027-06-15T10:00:00Z"), metadata: { [META_DONE]: String(NOW - 370 * DAY) } }), NOW), null);
is("asked 10 days ago, never completed: allowed", cannotMove(sub({ metadata: { [META_AT]: String(NOW - 10 * DAY) } }), NOW), null);
{
  // Asked on November 4; the run on November 10 was declined (402: Stripe
  // changed nothing, so the request stays in the metadata) or it lapsed.
  const lapsedOn = at("2026-11-10T12:00:00Z");
  const lapsed = sub({ metadata: requestMeta(sub(), lapsedOn, 667, NOW)! });
  const later = lapsedOn + MOVE_GRACE_SECONDS + 60;
  is("after a declined or lapsed run, the member may ask again", cannotMove(lapsed, later), null);
  is("and days are offered again", daysOffered(lapsed, "UTC", later).length > 0, true);
  is("while its grace runs, it still waits", cannotMove(lapsed, lapsedOn + 60), "pending");
}
is("a stale change, past its grace, no longer waits", pendingMove(sub({ metadata: { [META_ON]: String(NOW - MOVE_GRACE_SECONDS - 1) } }), NOW), null);
is("garbage in the metadata is read as nothing", cannotMove(sub({ metadata: { [META_DONE]: "soon", [META_ON]: "x" } }), NOW), null);
is("nothing is offered while refused", daysOffered(sub({ status: "trialing" }), "UTC", NOW), []);

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
const offered = daysOffered(monthly, "UTC", NOW);
is("days 5 to 19 are offered", offered.map((o) => o.day), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
is("each is before the payment due and a day ahead", offered.every((o) => o.on < at("2026-11-20T15:00:00Z") && o.on >= NOW + MOVE_LEAD_SECONDS), true);
is("every offered day lies within 1 to 28", offered.every((o) => o.day >= FIRST_DAY && o.day <= LAST_DAY), true);
const nextPeriod = daysOffered(sub({ end: at("2026-12-20T15:00:00Z") }), "UTC", at("2026-11-21T00:00:00Z"));
is("after the payment, the later days come back, still in November", nextPeriod.filter((o) => o.day > 20).map((o) => new Date(o.on * 1000).toISOString().slice(0, 10)), ["2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28"]);
is("and the earlier ones fall in December, before the payment due", nextPeriod.filter((o) => o.day < 20).map((o) => o.day).length, 19);

part("Month ends: a member billed on the 31st");
const jan31 = sub({ end: at("2027-01-31T08:00:00Z") });
is("current day is the 31st, so all of 1 to 28 can be chosen", currentDay(jan31, "UTC"), 31);
is("the 28th: January 28", moveOn(jan31, 28, "UTC", at("2027-01-05T12:00:00Z")), at("2027-01-28T12:00:00Z"));
is("days 6 to 28 offered on January 5", daysOffered(jan31, "UTC", at("2027-01-05T12:00:00Z")).map((o) => o.day).join(","), "6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28");
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
is("every offered day is less than a month before the payment due", daysOffered(yearly, "UTC", NOW).every((o) => at("2027-06-15T10:00:00Z") - o.on < 31 * DAY), true);
is("27 days offered (all but the 15th)", daysOffered(yearly, "UTC", NOW).length, 27);

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
      for (const o of daysOffered(s, zone, now)) {
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

part("Running a waiting change");
const on = at("2026-11-10T12:00:00Z");
const base = sub();
const meta = requestMeta(base, on, 1834, NOW)!;
const pending = sub({ metadata: meta });
is(
  "the request keeps when asked, when it runs, the amount shown and the period it was priced on",
  meta,
  { [META_AT]: String(NOW), [META_ON]: String(on), [META_SHOWN]: "1834", [META_END]: String(at("2026-11-20T15:00:00Z")), [META_MONTHS]: "1" },
);
is("a negative amount is never kept (amount_due is never below zero)", requestMeta(base, on, -250, NOW), null);
is("a fraction is never kept", requestMeta(base, on, 12.5, NOW), null);
is("a membership with no period end keeps no request", requestMeta({ ...base, items: { data: [{ quantity: 1, price: { recurring: { interval: "month" } } }] } }, on, 1834, NOW), null);
is("the amount shown is read back", shownOf(pending), 1834);
is("a negative amount reads as null", shownOf(sub({ metadata: { [META_SHOWN]: "-250" } })), null);
is("no amount kept reads as null", shownOf(sub()), null);
is("a garbled amount reads as null", shownOf(sub({ metadata: { [META_SHOWN]: "12.5" } })), null);
is("before its moment: waiting, not due", [pendingMove(pending, on - 60), moveDue(pending, on - 60)], [on, false]);
is("before its moment: may not run", cannotRun(pending, on - 60), "due");
is("at its moment: due", moveDue(pending, on), true);
is("an hour late: may run", cannotRun(pending, on + 3600), null);
is("past its grace: lapsed", [moveDue(pending, on + MOVE_GRACE_SECONDS), cannotRun(pending, on + MOVE_GRACE_SECONDS)], [false, "due"]);
is("behind on a payment by then: may not run", cannotRun({ ...pending, status: "past_due" }, on + 60), "behind");
is("set to end by then: may not run", cannotRun({ ...pending, cancel_at_period_end: true }, on + 60), "ending");
is("a discount added by then: may not run", cannotRun({ ...pending, discounts: ["di_1"] }, on + 60), "discount");
is("a balance added by then: may not run", cannotRun({ ...pending, customer: { id: "cus_1", balance: 300 } }, on + 60), "balance");
is("the card swapped for a bank debit by then: may not run", cannotRun({ ...pending, default_payment_method: { id: "pm_9", type: "us_bank_account" } }, on + 60), "card");
is(
  "the period moved on since the request (a new period end): may not run",
  cannotRun(sub({ end: at("2026-12-20T15:00:00Z"), metadata: meta }), on + 60),
  "changed",
);
is(
  "switched to yearly since the request, same moment: may not run",
  cannotRun(sub({ interval: "year", end: at("2027-11-05T09:00:00Z"), metadata: requestMeta(base, on, 667, NOW)! }), on + 30),
  "changed",
);
is("months kept do not match (yearly kept, monthly now): may not run", cannotRun(sub({ metadata: { ...meta, [META_MONTHS]: "12" } }), on + 60), "changed");
is("no period kept with the request: may not run", cannotRun(sub({ metadata: { [META_AT]: String(NOW), [META_ON]: String(on), [META_SHOWN]: "1834" } }), on + 60), "changed");
is(
  "its moment before the current period started: may not run",
  cannotRun(withItem(pending, { current_period_start: on + 1 }), on + 60),
  "changed",
);
is("no current period start known: may not run", cannotRun(withItem(pending, { current_period_start: undefined }), on + 60), "changed");
is("its moment at or after the period end: may not run", cannotRun(sub({ end: on, metadata: requestMeta(sub({ end: on }), on, 1834, NOW)! }), on + 60), "due");
is("no change waiting: nothing to run", cannotRun(sub(), on), "due");
is("Stripe's amount equal to the shown one may be charged", withinShown(1834, 1834), true);
is("one cent more may not", withinShown(1834, 1835), false);
is("less may", withinShown(1834, 1200), true);
is("nothing to pay may", withinShown(0, 0), true);
is("a negative figure is never trusted", withinShown(0, -300), false);
is("a fraction is never trusted", withinShown(1834, 1833.5), false);

part("The amount shown is the preview's whole amount_due");
const subLine = (amount: number, proration: boolean) => ({ amount, parent: { type: "subscription_item_details", subscription_item_details: { proration, subscription: "sub_1" } } });
const clean = { amount_due: 667, starting_balance: 0, lines: { data: [subLine(-333, true), subLine(1000, false)] } };
is("a clean preview: shown is amount_due", [previewRefusal(clean), previewAmount(clean)], [null, 667]);
is("amount_due includes tax added on top", previewAmount({ ...clean, amount_due: 726 }), 726);
const withItemLine = {
  starting_balance: 0,
  amount_due: 1000 - 333 + 500,
  lines: { data: [subLine(-333, true), subLine(1000, false), { amount: 500, parent: { type: "invoice_item_details", invoice_item_details: { proration: false, invoice_item: "ii_1" } } }] },
};
is("a pending invoice item on the invoice is refused", [previewRefusal(withItemLine), previewAmount(withItemLine)], ["extra", null]);
is("a line from nowhere known is refused", previewRefusal({ ...clean, lines: { data: [...clean.lines.data, { amount: 100 }] } }), "extra");
is("an old-style invoice item line is refused", previewRefusal({ ...clean, lines: { data: [...clean.lines.data, { amount: 100, type: "invoiceitem", proration: false }] } }), "extra");
const owes = { starting_balance: 200, amount_due: 867, lines: { data: [subLine(-333, true), subLine(1000, false)] } };
is("a balance owed on the invoice is refused", [previewRefusal(owes), previewAmount(owes)], ["balance", null]);
is("a credit on the invoice is refused", previewRefusal({ ...clean, starting_balance: -100, amount_due: 567 }), "balance");
is("no starting balance read is refused", previewRefusal({ amount_due: 667, lines: clean.lines }), "balance");
is("more lines than one page is refused", previewRefusal({ ...clean, lines: { ...clean.lines, has_more: true } }), "extra");
is("no amount_due read is refused", previewRefusal({ starting_balance: 0, lines: clean.lines }), "amount");
is("a negative amount_due is refused", previewRefusal({ ...clean, amount_due: -1 }), "amount");
is("no lines is refused", previewRefusal({ starting_balance: 0, amount_due: 0, lines: { data: [] } }), "extra");

part("The fresh preview at the moment of the change");
is("fresh preview below the shown amount: may run", runPreviewRefusal(pending, clean), null);
is("fresh preview above the shown amount: may not run", runPreviewRefusal(sub({ metadata: requestMeta(base, on, 666, NOW)! }), clean), "above");
is("fresh preview exactly the shown amount: may run", runPreviewRefusal(sub({ metadata: requestMeta(base, on, 667, NOW)! }), clean), null);
is("fresh preview with a pending invoice item: may not run", runPreviewRefusal(pending, withItemLine), "extra");
is("fresh preview with a balance: may not run", runPreviewRefusal(pending, owes), "balance");
is("no amount kept with the request: may not run", runPreviewRefusal(sub(), clean), "above");

part("The Stripe requests");
const preview = previewMoveBody("cus_1", "sub_1", "si_1", on);
is("the preview names the subscription and its item", [preview.get("customer"), preview.get("subscription"), preview.get("subscription_details[items][0][id]")], ["cus_1", "sub_1", "si_1"]);
is("the unchanged item's price is left out, as Stripe asks", [preview.has("subscription_details[items][0][price]"), preview.has("subscription_details[items][0][price_data]")], [false, false]);
is("the preview resets the anchor now, invoicing prorations, at the second it will run", [preview.get("subscription_details[billing_cycle_anchor][type]"), preview.get("subscription_details[proration_behavior]"), preview.get("subscription_details[proration_date]")], ["now", "always_invoice", String(on)]);
const change = moveBody(on);
is("the change resets the anchor now at the previewed second", [change.get("billing_cycle_anchor[type]"), change.get("proration_behavior"), change.get("proration_date")], ["now", "always_invoice", String(on)]);
is("the change is refused if its payment fails", change.get("payment_behavior"), "error_if_incomplete");
is("the change is charged with nobody present, as lib/billing.ts does", change.get("off_session"), "true");
is(
  "the change clears the request",
  [META_AT, META_ON, META_SHOWN, META_END, META_MONTHS].map((key) => change.get(`metadata[${key}]`)),
  ["", "", "", "", ""],
);
is("the change marks itself done at its moment, applied only if the update succeeds", change.get(`metadata[${META_DONE}]`), String(on));
is("the change never starts a trial or turns prorations off", [change.has("trial_end"), change.get("proration_behavior") !== "none"], [false, true]);
const cleared = clearMoveBody();
is(
  "a declined or lapsed run clears the request",
  [META_AT, META_ON, META_SHOWN, META_END, META_MONTHS].map((key) => cleared.get(`metadata[${key}]`)),
  ["", "", "", "", ""],
);
is("clearing never marks the change done and changes nothing else", [cleared.has(`metadata[${META_DONE}]`), [...cleared.keys()].every((key) => key.startsWith("metadata["))], [false, true]);
is("a cleared request leaves the member free to ask again", cannotMove(sub({ metadata: { store: "shop" } }), on + MOVE_GRACE_SECONDS + 60), null);
is("the idempotency key names the subscription and the moment", moveIdempotencyKey("sub_1", on), `billing-day:sub_1:${on}`);
is("the change completed now counts as this period's change", cannotMove(sub({ end: addMonths(on, 1), metadata: { store: "shop", [META_DONE]: String(on) } }), on + DAY), "recent");

part("The words shown before confirming");
is("ordinals", [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "28th"]);
is("a US date", dateWords(at("2026-11-10T12:00:00Z"), "UTC"), "Tuesday, November 10, 2026");
is("a date in Auckland is its own", dateWords(at("2026-11-30T23:00:00Z"), "Pacific/Auckland"), "Tuesday, December 1, 2026");
const words = moveWords({ from: at("2026-11-20T15:00:00Z"), on, months: 1, amount: "$18.34", timeZone: "UTC" });
is("monthly words", words, [
  "Your next payment moves from Friday, November 20, 2026, to Tuesday, November 10, 2026.",
  "On Tuesday, November 10, 2026, you pay $18.34.",
  "That is one full month, less the days you already paid for.",
  "Stripe worked out this amount. This payment will not be more than this amount.",
  "After that, you pay on the 10th of each month.",
  "If that payment fails, your payment day stays the same.",
  "You can change the day once a month.",
]);
const yearWords = moveWords({ from: at("2027-06-15T10:00:00Z"), on: at("2027-06-03T12:00:00Z"), months: 12, amount: "$480.00", timeZone: "America/New_York" });
is("yearly words name the month and day, as a US date", yearWords[4], "After that, you pay every year on June 3.");
is("no sentence promises the member never pays more (later payments are the full price)", [...words, ...yearWords].some((line) => /never pay more/.test(line)), false);
is("yearly words say once a year", yearWords[6], "You can change the day once a year.");
const aklWords = moveWords({ from: at("2026-12-14T23:00:00Z"), on: akl, months: 1, amount: "NZ$20.00", timeZone: "Pacific/Auckland" });
is("Auckland words use the local day", aklWords[4], "After that, you pay on the 1st of each month.");
const sentences = [...words, ...yearWords, ...aklWords].flatMap((line) => line.split(/(?<=\.)\s+/));
is("every sentence is under 20 words", sentences.filter((s) => s.split(/\s+/).length >= 20), []);
is("no British spelling", [...words, ...yearWords].filter((s) => /cancell|colour|centre|favour|licence/i.test(s)), []);
is("the amount appears as given", words.filter((s) => s.includes("$18.34")).length, 1);
is("an unknown zone falls back to UTC", moveWords({ from: NOW + 10 * DAY, on: NOW + 5 * DAY, months: 1, amount: "$1.00", timeZone: "Nowhere/Here" })[1], "On Monday, November 9, 2026, you pay $1.00.");

done();
