/**
 * 283 [HG2], unit 1: emails on the anniversary of a purchase and on dates the
 * creator sets, as pure rules (lib/purchase-anniversary-rules.ts). The date
 * is the purchase's own, already kept, in the store's time zone; no birth
 * date is ever asked. Only a contact whose news consent is exactly "yes"
 * may get one, once per contact per date. Anything that cannot be read is
 * unknown, and nothing is sent on it. Nothing is wired yet.
 */
import {
  MAX_ANNIVERSARY_YEARS,
  MAX_STORE_DATES,
  anniversaryOn,
  isAnniversaryToday,
  mayEmailOnDate,
  onceKey,
  readAnniversaryYears,
  readStoreDates,
} from "@/lib/purchase-anniversary-rules";
import { done, is, part } from "./check";

const NY = "America/New_York";

part("How many years after the purchase: off, or 1 to the most");
is("off", readAnniversaryYears(0), 0);
is("off when never set", readAnniversaryYears(undefined), 0);
is("one year", readAnniversaryYears(1), 1);
is("as text from a form", readAnniversaryYears("2"), 2);
is(`the most, ${MAX_ANNIVERSARY_YEARS}`, readAnniversaryYears(MAX_ANNIVERSARY_YEARS), MAX_ANNIVERSARY_YEARS);
for (const bad of [MAX_ANNIVERSARY_YEARS + 1, -1, 1.5, "one", null, {}]) is(`refused: ${JSON.stringify(bad)}`, readAnniversaryYears(bad), null);

part("The anniversary, by the store's own calendar");
const bought = Date.parse("2025-11-12T03:30:00Z"); // 22:30 on 11 November 2025 in New York
is("a year later, the store's date, not UTC's", anniversaryOn(bought, 1, NY), "2026-11-11");
is("two years", anniversaryOn(bought, 2, NY), "2027-11-11");
const leap = Date.parse("2024-02-29T15:00:00Z");
is("29 February, one year on: 28 February", anniversaryOn(leap, 1, NY), "2025-02-28");
is("29 February, four years on: 29 February", anniversaryOn(leap, 4, NY), "2028-02-29");
is("a time zone that is not one", anniversaryOn(bought, 1, "Nowhere/Here"), null);
is("a purchase time that is not one", anniversaryOn(Number.NaN, 1, NY), null);
is("off has no anniversary", anniversaryOn(bought, 0, NY), null);

part("Is it today?");
const onTheDay = Date.parse("2026-11-11T15:00:00Z");
is("on the day", isAnniversaryToday({ purchasedAt: bought, years: 1, tz: NY, now: onTheDay }), "yes");
is("the day before", isAnniversaryToday({ purchasedAt: bought, years: 1, tz: NY, now: onTheDay - 86_400_000 }), "no");
is("UTC's next day is still the store's day", isAnniversaryToday({ purchasedAt: bought, years: 1, tz: NY, now: Date.parse("2026-11-12T03:00:00Z") }), "yes");
is("unreadable", isAnniversaryToday({ purchasedAt: bought, years: 1, tz: "Nowhere/Here", now: onTheDay }), "unknown");
is("off is never today", isAnniversaryToday({ purchasedAt: bought, years: 0, tz: NY, now: onTheDay }), "no");

part("The creator's own dates, read whole or not at all");
const today = "2026-11-11";
is("sorted", readStoreDates(["2026-12-24", "2026-11-28"], today), ["2026-11-28", "2026-12-24"]);
is("past dates dropped", readStoreDates(["2026-01-01", "2026-12-24"], today), ["2026-12-24"]);
for (const [label, raw] of [
  ["not a list", "2026-12-24"],
  ["a date that does not exist", ["2026-02-30"]],
  ["a date twice", ["2026-12-24", "2026-12-24"]],
  [`more than ${MAX_STORE_DATES}`, Array.from({ length: MAX_STORE_DATES + 1 }, (_, i) => `2026-12-${String(i + 1).padStart(2, "0")}`)],
  ["more than a year ahead", ["2027-11-20"]],
] as const) is(`refused: ${label}`, readStoreDates(raw, today), null);

part("Only a contact who said yes to news, exactly");
is("yes", mayEmailOnDate("yes"), true);
for (const other of ["no", "Yes", "", null, undefined, true, 1]) is(`not: ${JSON.stringify(other)}`, mayEmailOnDate(other), false);

part("Once per contact per date");
const a = onceKey("st_1", "contact-hash-a", "anniversary:prod_1:1", "2026-11-11");
is("the same contact, date and reason: the same key", a, onceKey("st_1", "contact-hash-a", "anniversary:prod_1:1", "2026-11-11"));
is("another contact: another key", a === onceKey("st_1", "contact-hash-b", "anniversary:prod_1:1", "2026-11-11"), false);
is("another date: another key", a === onceKey("st_1", "contact-hash-a", "anniversary:prod_1:1", "2027-11-11"), false);
is("never the address itself", /@/.test(a), false);
is("an unreadable part gives no key", onceKey("st_1", "", "anniversary:prod_1:1", "2026-11-11"), null);
done();
