/**
 * The windows of a creator's own plan notices (queue 414 [KX1], added
 * 30 October 2026, docs/kx1-renewal-legal-matrix-2026-10-30.md). What is
 * checked, with synthetic subscriptions only:
 *
 *   - a yearly renewal is first due on the 30th UTC calendar day before the
 *     charge's date, whatever the hour of either, and is on time only then
 *     (the one day every official window read allows: Utah, Illinois,
 *     Virginia, DC, Colorado, Massachusetts, New York, California);
 *   - a notice found later (yearly: any later day; trial: fewer
 *     than 7) is still due, but marked late, never as on time;
 *   - inside the window it is not marked late;
 *   - a monthly plan gets no renewal notice, as before;
 *   - a full period ends where Stripe ends it: a day the next month lacks
 *     is that month's last day (31 Jan + a month is 28 Feb, 29 Feb 2028 + a
 *     year is 28 Feb 2029), never a day of the month after.
 */
import { dueReminder, fullPeriodAfter, missedReminder } from "@/lib/billing-reminders";
import { done, is, part } from "./check";

const NOW = 1_791_700_000;
const DAY = 86_400;

function sub(cycle: "year" | "month", left: number, status = "active"): Record<string, unknown> {
  const end = NOW + left;
  return {
    id: `sub_window${cycle}${status}`,
    status,
    created: NOW - 400 * DAY,
    ...(status === "trialing" ? { trial_end: end } : {}),
    customer: { email: "creator@example.com" },
    items: {
      data: [
        {
          current_period_start: end - (cycle === "year" ? 365 : 30) * DAY,
          current_period_end: end,
          price: {
            lookup_key: `nimbus_labs_creator_${cycle}`,
            unit_amount: cycle === "year" ? 29000 : 2900,
            recurring: { interval: cycle },
          },
        },
      ],
    },
  };
}

part("yearly renewal: calendar days, not elapsed seconds");
// NOW is 06:26 UTC. TODAY is its UTC day; a charge "on day N" is at an hour of
// the UTC day N calendar days later.
const TODAY = Math.floor(NOW / DAY) * DAY;
const charge = (days: number, hour: number) => TODAY + days * DAY + hour * 3600 - NOW;
is("the 31st day before, late in the day: nothing yet", dueReminder(sub("year", charge(31, 23)), NOW), null);
is("the 31st day before, early in the day: nothing yet", dueReminder(sub("year", charge(31, 1)), NOW), null);
const early = dueReminder(sub("year", charge(30, 1)), NOW);
is("the 30th day, charge at 01:00 (under 30 x 24 h left): due, on time", [early?.kind, early?.late], ["renewal", false]);
const lateHour = dueReminder(sub("year", charge(30, 23)), NOW);
is("the 30th day, charge at 23:00 (over 30 x 24 h left): due, on time", [lateHour?.kind, lateHour?.late], ["renewal", false]);
const day29 = dueReminder(sub("year", charge(29, 23)), NOW);
is("the 29th day, charge at 23:00 (over 29 x 24 h left): due, marked late", [day29?.kind, day29?.late], ["renewal", true]);
const at15 = dueReminder(sub("year", 15 * DAY), NOW);
is("15 days left: outside Utah's and Illinois' windows, marked late", [at15?.kind, at15?.late], ["renewal", true]);
const at10 = dueReminder(sub("year", 10 * DAY), NOW);
is("10 days left: still due, marked late", [at10?.kind, at10?.late], ["renewal", true]);

part("trial");
const t8 = dueReminder(sub("month", 8 * DAY - 60, "trialing"), NOW);
is("8 days left: due, on time", [t8?.kind, t8?.late], ["trial", false]);
const t3 = dueReminder(sub("month", 3 * DAY, "trialing"), NOW);
is("3 days left: still due, marked late", [t3?.kind, t3?.late], ["trial", true]);

part("missed and scheduled cancellation");
is("a yearly notice found 12 hours before the charge is not sent", dueReminder(sub("year", 12 * 3600), NOW), null);
const miss = missedReminder(sub("year", 12 * 3600), NOW);
is("but it is reported as missed", [miss?.kind, miss?.late], ["renewal", true]);
is("a charge 10 days away is not missed", missedReminder(sub("year", 10 * DAY), NOW), null);
const renewsAt = NOW + charge(30, 5);
const fullYearCancel = { ...sub("year", charge(30, 5)), cancel_at: renewsAt + 366 * DAY };
is("cancellation a full year after the renewal: the full renewal is noticed", dueReminder(fullYearCancel, NOW)?.kind, "renewal");
const partCancel = { ...sub("year", charge(30, 5)), cancel_at: renewsAt + 200 * DAY };
is("cancellation inside the renewed year (prorated by Stripe): no full-price notice", dueReminder(partCancel, NOW), null);
const atCharge = { ...sub("year", charge(30, 5)), cancel_at: renewsAt };
is("cancellation at the charge itself: no notice", dueReminder(atCharge, NOW), null);
const sooner = { ...sub("year", charge(30, 5)), cancel_at: NOW + 10 * DAY };
is("cancellation set before the renewal: no notice", dueReminder(sooner, NOW), null);

part("a full period ends on the last day of a shorter month, as Stripe ends it");
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const utc = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m, d, h) / 1000;
is("31 Jan 2027 + a month is 28 Feb 2027", iso(fullPeriodAfter(utc(2027, 0, 31, 9), "month")), iso(utc(2027, 1, 28, 9)));
is("31 Jan 2028 + a month is 29 Feb 2028 (leap year)", iso(fullPeriodAfter(utc(2028, 0, 31), "month")), iso(utc(2028, 1, 29)));
is("31 Mar 2027 + a month is 30 Apr 2027", iso(fullPeriodAfter(utc(2027, 2, 31), "month")), iso(utc(2027, 3, 30)));
is("31 Dec 2027 + a month is 31 Jan 2028", iso(fullPeriodAfter(utc(2027, 11, 31), "month")), iso(utc(2028, 0, 31)));
is("15 Jan 2027 + a month is 15 Feb 2027 (control)", iso(fullPeriodAfter(utc(2027, 0, 15, 5), "month")), iso(utc(2027, 1, 15, 5)));
is("29 Feb 2028 + a year is 28 Feb 2029", iso(fullPeriodAfter(utc(2028, 1, 29, 7), "year")), iso(utc(2029, 1, 28, 7)));
is("28 Feb 2027 + a year is 28 Feb 2028 (control)", iso(fullPeriodAfter(utc(2027, 1, 28), "year")), iso(utc(2028, 1, 28)));
{
  // A trial ending 31 Jan 2027, cancel_at at Stripe's own end of the first full month: a full-price charge.
  const trialEnd = utc(2027, 0, 31);
  const trial = { ...sub("month", 0, "trialing"), trial_end: trialEnd, cancel_at: utc(2027, 1, 28) };
  is("trial ending 31 Jan, canceling at 28 Feb: the full first month is noticed", dueReminder(trial, trialEnd - 7.5 * DAY)?.kind, "trial");
  is("and counted as missed if first found on its last day", missedReminder(trial, trialEnd - 12 * 3600)?.kind, "trial");
  const short = { ...trial, cancel_at: utc(2027, 1, 27) };
  is("canceling a day before Stripe's end (prorated): no notice (control)", dueReminder(short, trialEnd - 7.5 * DAY), null);
}
{
  // A yearly plan renewing 29 Feb 2028, cancel_at at Stripe's own end of that year: 28 Feb 2029.
  const renews = utc(2028, 1, 29);
  const yearly = { ...sub("year", 0), items: { data: [{ current_period_start: utc(2027, 1, 28), current_period_end: renews, price: { lookup_key: "nimbus_labs_creator_year", unit_amount: 29000, recurring: { interval: "year" } } }] }, cancel_at: utc(2029, 1, 28) };
  is("yearly renewing 29 Feb 2028, canceling 28 Feb 2029: noticed on the 30th day", dueReminder(yearly, renews - 30 * DAY + 3600)?.kind, "renewal");
}

part("monthly");
is("a monthly plan gets no renewal notice", dueReminder(sub("month", 10 * DAY), NOW), null);

done();
