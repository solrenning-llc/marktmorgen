/**
 * weekdayAt (tests/weekday.ts), the booking time every call test uses, gives
 * distinct days for distinct offsets whatever weekday the tests run on.
 *
 * It used to walk forward from today plus `days`, skipping a weekend, so two
 * offsets a day or two apart could land on the same Monday: run on a
 * Wednesday, offsets 10 (a Saturday) and 11 (a Sunday) both gave the next
 * Monday at the same minute, and tests/calls-lock-shape.test.ts sold the same
 * one-to-one time twice and failed ("no checkout: taken") on Wednesdays and
 * Thursdays only. Here every weekday is "today" in turn, through the `now`
 * the helper takes, so the failure shows on any day the suite runs.
 *
 * Synthetic times only.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NY, weekdayAt } from "./weekday";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/** The date and weekday of an instant in New York, and its minute after midnight there. */
function inNewYork(at: number): { date: string; weekday: string; minute: number } {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: get("weekday"), minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** The weekdays (Mon–Fri) after the New York date of `now`, in order, as YYYY-MM-DD. */
function weekdaysAfter(now: number, count: number): string[] {
  const out: string[] = [];
  for (let at = now + DAY; out.length < count; at += DAY) {
    const day = inNewYork(at);
    if (WEEKDAYS.includes(day.weekday)) out.push(day.date);
  }
  return out;
}

// Monday 9 November 2026, 12:00 in New York (after the clocks went back), and the six days after it.
const MONDAY_NOON = Date.UTC(2026, 10, 9, 17);
const OFFSETS = Array.from({ length: 20 }, (_, i) => i + 1);

for (let shift = 0; shift < 7; shift += 1) {
  const now = MONDAY_NOON + shift * DAY;
  const today = inNewYork(now).weekday;
  part(`Today is ${today} (${inNewYork(now).date})`);
  const got = OFFSETS.map((days) => inNewYork(weekdayAt(days, 600, now)));
  is(`${today}: offsets 1 to 20 are never a Saturday or a Sunday`, got.filter((d) => !WEEKDAYS.includes(d.weekday)).map((d) => d.date), []);
  is(`${today}: offsets 1 to 20 give 20 different days`, new Set(got.map((d) => d.date)).size, OFFSETS.length);
  is(`${today}: each offset is the next weekday after the one before it, the first the first after today`, got.map((d) => d.date), weekdaysAfter(now, OFFSETS.length));
  is(`${today}: each time is 10:00 in New York`, got.filter((d) => d.minute !== 600).length, 0);
  is(`${today}: the same offset at another minute is the same day`, inNewYork(weekdayAt(3, 660, now)).date, got[2].date);
}

part("The default now is the clock's");
is("weekdayAt without a now reads Date.now()", weekdayAt(7, 600), weekdayAt(7, 600, Date.now()));

part("Every call test uses this helper, none keeps its own copy");
// Built from parts so this file does not match itself.
const OWN_COPY = new RegExp(`${"function"} ${"weekdayAt"}\\b`);
const copies = readdirSync(join(process.cwd(), "tests"))
  .filter((name) => name.endsWith(".ts") && name !== "weekday.ts")
  .filter((name) => OWN_COPY.test(readFileSync(join(process.cwd(), "tests", name), "utf8")));
is("no other file in tests/ defines its own weekdayAt", copies, []);

done();
