/**
 * A member moving the day their own membership is charged: the rules only
 * (lib/billing-day-rules.ts; 630 [HN6], item 13, unit 1). Synthetic
 * subscriptions only; nothing here reaches Stripe. Checked:
 *
 *   - every refusal: the schedule, a trial, a payment behind, other states,
 *     a pause, an end, a payment plan, items, a discount, an affiliate's
 *     share for set months, a schedule or pending update, a change waiting,
 *     and once a billing period;
 *   - the days offered: 1 to 28, never the day paid on now, only before the
 *     payment already due and at least a day ahead;
 *   - the date math: noon where the member lives, across month ends (31st to
 *     28th), leap years and daylight-saving changes, and the payments after;
 *   - when a waiting change may run, and never above the amount shown;
 *   - the Stripe request bodies, and the words shown before confirming.
 */
import {
  FIRST_DAY,
  LAST_DAY,
  META_AT,
  META_ON,
  META_SHOWN,
  MOVE_GRACE_SECONDS,
  MOVE_LEAD_SECONDS,
  type BillingDaySub,
  cannotMove,
  cannotRun,
  currentDay,
  dateWords,
  daysOffered,
  localNoon,
  localParts,
  moveBody,
  moveDue,
  moveInstant,
  moveOn,
  moveWords,
  ordinal,
  paymentsAfter,
  pendingMove,
  periodMonths,
  previewMoveBody,
  requestMeta,
  shownOf,
  withinShown,
  zoneOf,
} from "@/lib/billing-day-rules";
import { RECURRING_ALWAYS } from "@/lib/affiliate-setting";
import { done, is, part } from "./check";

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const DAY = 86_400;

function sub(over: Partial<BillingDaySub> & { interval?: string; count?: number; end?: number } = {}): BillingDaySub {
  const { interval = "month", count = 1, end = at("2026-11-20T15:00:00Z"), ...rest } = over;
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
    metadata: { store: "shop" },
    items: { data: [{ quantity: 1, current_period_end: end, price: { recurring: { interval, interval_count: count } } }] },
    ...rest,
  };
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

part("Once a billing period, and one change waiting at a time");
const waiting = sub({ metadata: { [META_AT]: String(NOW - 40 * DAY), [META_ON]: String(NOW + 3 * DAY) } });
is("a change waiting refuses another", cannotMove(waiting, NOW), "pending");
is("pendingMove reads it", pendingMove(waiting, NOW), NOW + 3 * DAY);
is("asked 10 days ago on a monthly membership: refused", cannotMove(sub({ metadata: { [META_AT]: String(NOW - 10 * DAY) } }), NOW), "recent");
is("asked a calendar month ago less one second: refused", cannotMove(sub({ metadata: { [META_AT]: String(at("2026-10-04T12:00:01Z")) } }), NOW), "recent");
is("asked exactly a calendar month ago: allowed", cannotMove(sub({ metadata: { [META_AT]: String(at("2026-10-04T12:00:00Z")) } }), NOW), null);
is("yearly, asked 200 days ago: refused", cannotMove(sub({ interval: "year", end: at("2027-06-15T10:00:00Z"), metadata: { [META_AT]: String(NOW - 200 * DAY) } }), NOW), "recent");
is("yearly, asked 370 days ago: allowed", cannotMove(sub({ interval: "year", end: at("2027-06-15T10:00:00Z"), metadata: { [META_AT]: String(NOW - 370 * DAY) } }), NOW), null);
is("a stale change, past its grace, no longer waits", pendingMove(sub({ metadata: { [META_ON]: String(NOW - MOVE_GRACE_SECONDS - 1) } }), NOW), null);
is("garbage in the metadata is read as nothing", cannotMove(sub({ metadata: { [META_AT]: "soon", [META_ON]: "x" } }), NOW), null);
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

steady = true;
const ldn = localNoon(2027, 1, 28, "Europe/London");
for (const s of paymentsAfter(ldn, 1, 24)) if (localParts(s, "Europe/London").day !== 28) steady = false;
is("London, the 28th: every payment on the 28th, February and summer time included", steady, true);

part("Running a waiting change");
const on = at("2026-11-10T12:00:00Z");
const pending = sub({ metadata: requestMeta(on, 1834, NOW) });
is("the request keeps when asked, when it runs and the amount shown", requestMeta(on, 1834, NOW), { [META_AT]: String(NOW), [META_ON]: String(on), [META_SHOWN]: "1834" });
is("the amount shown is read back", shownOf(pending), 1834);
is("a credit shown is read back", shownOf(sub({ metadata: { [META_SHOWN]: "-250" } })), -250);
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
is("the payment due already taken (period moved past it): still before the new end, so it may run", cannotRun(sub({ end: at("2026-12-20T15:00:00Z"), metadata: requestMeta(on, 1834, NOW) }), on + 60), null);
is("its moment at or after the period end: may not run", cannotRun(sub({ end: on, metadata: requestMeta(on, 1834, NOW) }), on + 60), "due");
is("no change waiting: nothing to run", cannotRun(sub(), on), "due");
is("Stripe's amount equal to the shown one may be charged", withinShown(1834, 1834), true);
is("one cent more may not", withinShown(1834, 1835), false);
is("less may", withinShown(1834, 1200), true);
is("a credit may", withinShown(0, -300), true);
is("a fraction is never trusted", withinShown(1834, 1833.5), false);

part("The Stripe requests");
const preview = previewMoveBody("cus_1", "sub_1", "si_1", "price_1", on);
is("the preview names the subscription, its item and its price unchanged", [preview.get("subscription"), preview.get("subscription_details[items][0][id]"), preview.get("subscription_details[items][0][price]")], ["sub_1", "si_1", "price_1"]);
is("the preview resets the anchor now, invoicing prorations, at the second it will run", [preview.get("subscription_details[billing_cycle_anchor][type]"), preview.get("subscription_details[proration_behavior]"), preview.get("subscription_details[proration_date]")], ["now", "always_invoice", String(on)]);
const change = moveBody(on);
is("the change resets the anchor now at the previewed second", [change.get("billing_cycle_anchor[type]"), change.get("proration_behavior"), change.get("proration_date")], ["now", "always_invoice", String(on)]);
is("the change is refused if its payment fails", change.get("payment_behavior"), "error_if_incomplete");
is("the change clears what waited, keeps when it was asked", [change.get(`metadata[${META_ON}]`), change.get(`metadata[${META_SHOWN}]`), change.has(`metadata[${META_AT}]`)], ["", "", false]);
is("the change never starts a trial or turns prorations off", [change.has("trial_end"), change.get("proration_behavior") !== "none"], [false, true]);

part("The words shown before confirming");
is("ordinals", [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "28th"]);
is("a US date", dateWords(at("2026-11-10T12:00:00Z"), "UTC"), "Tuesday, November 10, 2026");
is("a date in Auckland is its own", dateWords(at("2026-11-30T23:00:00Z"), "Pacific/Auckland"), "Tuesday, December 1, 2026");
const words = moveWords({ from: at("2026-11-20T15:00:00Z"), on, months: 1, amount: "$18.34", timeZone: "UTC" });
is("monthly words", words, [
  "Your next payment moves from Friday, November 20, 2026 to Tuesday, November 10, 2026.",
  "On Tuesday, November 10, 2026, you pay $18.34.",
  "That is one full month, less the days you already paid for.",
  "Stripe worked out this amount. You will never pay more than it.",
  "After that, you pay on the 10th of each month.",
  "If that payment fails, nothing changes.",
  "You can change the day once a month.",
]);
const yearWords = moveWords({ from: at("2027-06-15T10:00:00Z"), on: at("2027-06-03T12:00:00Z"), months: 12, amount: "$480.00", timeZone: "America/New_York" });
is("yearly words name the month and day", yearWords[4], "After that, you pay every year on June 3rd.");
is("yearly words say once a year", yearWords[6], "You can change the day once a year.");
const aklWords = moveWords({ from: at("2026-12-14T23:00:00Z"), on: akl, months: 1, amount: "NZ$20.00", timeZone: "Pacific/Auckland" });
is("Auckland words use the local day", aklWords[4], "After that, you pay on the 1st of each month.");
const sentences = [...words, ...yearWords, ...aklWords].flatMap((line) => line.split(/(?<=\.)\s+/));
is("every sentence is under 20 words", sentences.filter((s) => s.split(/\s+/).length >= 20), []);
is("no British spelling", [...words, ...yearWords].filter((s) => /cancell|colour|centre|favour|licence/i.test(s)), []);
is("the amount appears as given", words.filter((s) => s.includes("$18.34")).length, 1);
is("an unknown zone falls back to UTC", moveWords({ from: NOW + 10 * DAY, on: NOW + 5 * DAY, months: 1, amount: "$1.00", timeZone: "Nowhere/Here" })[1], "On Monday, November 9, 2026, you pay $1.00.");

done();
