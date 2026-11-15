/**
 * A call test's booking time on a weekday: one helper for every call test,
 * so the days they book are the same rule everywhere.
 *
 * `weekdayAt(days, minute)` is `minute` minutes after midnight in `tz` on
 * the `days`-th weekday (Monday to Friday) after today's date there. Distinct
 * offsets are always distinct days, in the same order, whatever weekday the
 * tests run on, and the same offset at another minute is the same day.
 *
 * It used to be the first weekday on or after today plus `days`, so two
 * offsets a day or two apart could both be moved past a weekend onto the same
 * Monday (run on a Wednesday, 10 and 11), and a test that booked them as two
 * one-to-one times sold one time twice (tests/weekday-at.test.ts).
 *
 * The `days`-th weekday is at least `days` calendar days ahead and at most
 * `days * 7 / 5 + 2`; the call tests' setups book within a 30-day horizon
 * (`horizonDays: 30`), so any offset up to 20 (at most 28 days ahead) fits.
 */
import { zonedToUtc } from "@/lib/call-setup";

export const NY = "America/New_York";

export function weekdayAt(days: number, minute: number, now: number = Date.now(), tz: string = NY): number {
  if (!Number.isInteger(days) || days < 1) throw new Error(`weekdayAt: days must be a whole number of 1 or more, got ${days}`);
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const [year, month, day] = [get("year"), get("month"), get("day")];
  let seen = 0;
  for (let offset = 1; ; offset += 1) {
    // Calendar arithmetic on the date alone, in UTC, so no clock change moves a day.
    const date = new Date(Date.UTC(year, month - 1, day + offset));
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    seen += 1;
    if (seen === days) {
      const at = zonedToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), minute, tz);
      if (at === null) throw new Error(`weekdayAt: ${minute} minutes after midnight does not exist in ${tz} on that day`);
      return at;
    }
  }
}
