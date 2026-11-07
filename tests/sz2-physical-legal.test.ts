/**
 * 618 [SZ2]: the information fields a creator fills on a physical product
 * (docs/sz2-physical-legal-fields.md). Pure: no storage, no page, no email.
 * These check the arithmetic and the shape, not legal compliance.
 */
import {
  GPSR_AREA,
  MAX_PRICE_STEPS,
  MAX_PROP65,
  PRICE_KEEP_SECONDS,
  PRIOR_PRICE_SECONDS,
  checkProp65,
  gpsrClosedCountries,
  priorLowestPrice,
  prop65Matters,
  readNetQuantity,
  readSafetyInfo,
  recordPrice,
  safetyGaps,
  unitPrice,
  unitWords,
  type PriceStep,
} from "@/lib/physical-legal";
import { MAX_SALE_DAYS } from "@/lib/store-sale";
import { done, is, part } from "./check";

const DAY = 86_400;

const complete = {
  manufacturer: { name: "Paper & Pine GmbH", postal: "Hauptstrasse 1, 10115 Berlin", electronic: "help@paperpine.example", country: "de" },
  responsible: null,
  productType: "A5 paper planner, 2027 edition",
  identifier: "Batch 27-03",
  warnings: "",
  noWarnings: true,
};

part("GPSR: the area and a complete record");
is("the area is the 27 EU states plus Iceland, Liechtenstein and Norway, and the 7 parts of the Union Stripe names apart (review of #3029)", GPSR_AREA.length, 37);
is("Svalbard is outside the EEA, so it is not in the area", GPSR_AREA.includes("SJ"), false);
is("Germany, France and Norway are in it", ["DE", "FR", "NO"].every((c) => GPSR_AREA.includes(c)), true);
is("the US, the UK and Switzerland are not", ["US", "GB", "CH"].some((c) => GPSR_AREA.includes(c)), false);
const info = readSafetyInfo(complete);
is("a stored record reads back, country upper-cased", info?.manufacturer.country, "DE");
is("an EU manufacturer with type, picture and a stated 'no warnings' has no gaps", safetyGaps(info, true), []);
is("so no country is closed", gpsrClosedCountries(["US", "DE", "FR"], info, true), []);

part("GPSR: what is missing");
is("no record at all lists every gap", safetyGaps(null, false), [
  "manufacturer-name",
  "manufacturer-postal",
  "manufacturer-electronic",
  "manufacturer-country",
  "picture",
  "type",
  "warnings",
]);
is("no picture is a gap (art. 19(c))", safetyGaps(info, false), ["picture"]);
const us = readSafetyInfo({ ...complete, manufacturer: { ...complete.manufacturer, country: "US" } });
is("a manufacturer outside the area needs an EU responsible person", safetyGaps(us, true), ["responsible"]);
is("its EU/EEA countries close, the rest keep selling", gpsrClosedCountries(["US", "DE", "GB", "FR", "NO", "CA"], us, true), ["DE", "FR", "NO"]);
const outside = readSafetyInfo({ ...complete, manufacturer: { ...complete.manufacturer, country: "US" }, responsible: { name: "Rep Ltd", postal: "1 Main St, Boston", electronic: "rep@rep.example", country: "US" } });
is("a responsible person outside the area does not count", safetyGaps(outside, true), ["responsible-outside"]);
const withRep = readSafetyInfo({ ...complete, manufacturer: { ...complete.manufacturer, country: "US" }, responsible: { name: "EU Rep BV", postal: "Damrak 1, Amsterdam", electronic: "https://eurep.example/contact", country: "NL" } });
is("an EU responsible person with a web contact page closes the gap", safetyGaps(withRep, true), []);
const repIncomplete = readSafetyInfo({ ...complete, manufacturer: { ...complete.manufacturer, country: "US" }, responsible: { name: "EU Rep BV", postal: "", electronic: "nope", country: "NL" } });
is("a responsible person without postal and electronic address is a gap", safetyGaps(repIncomplete, true), ["responsible-postal", "responsible-electronic"]);
is("empty warnings without the 'none' statement is a gap: never inferred", safetyGaps(readSafetyInfo({ ...complete, noWarnings: false }), true), ["warnings"]);
is("warnings text closes it", safetyGaps(readSafetyInfo({ ...complete, noWarnings: false, warnings: "Not for children under 3. Small parts." }), true), []);
is("an electronic address that is neither email nor https is a gap", safetyGaps(readSafetyInfo({ ...complete, manufacturer: { ...complete.manufacturer, electronic: "call us" } }), true), ["manufacturer-electronic"]);
is("http (not https) is not a contact page", safetyGaps(readSafetyInfo({ ...complete, manufacturer: { ...complete.manufacturer, electronic: "http://paperpine.example" } }), true), ["manufacturer-electronic"]);
is("a field with a control character is dropped, so it becomes a gap", safetyGaps(readSafetyInfo({ ...complete, productType: "Planner\u0007" }), true), ["type"]);
is("whitespace is folded", readSafetyInfo({ ...complete, productType: "  A5   planner " })?.productType, "A5 planner");
is("an unknown country is a gap", safetyGaps(readSafetyInfo({ ...complete, manufacturer: { ...complete.manufacturer, country: "ZZ" } }), true), ["manufacturer-country"]);
is("garbage from storage reads as no record", readSafetyInfo("x"), null);

part("California Proposition 65 text (the creator's, checked, never written by the code)");
is("only when the product ships to the US", [prop65Matters(["US", "CA"]), prop65Matters(["DE", "FR"])], [true, false]);
is("empty is fine: nothing is shown", checkProp65(""), null);
is("WARNING: with the site", checkProp65("WARNING: This product can expose you to chemicals including lead, which is known to the State of California to cause cancer. For more information go to www.P65Warnings.ca.gov."), null);
is("CA WARNING: is accepted", checkProp65("CA WARNING: Cancer risk from exposure to lead. See www.P65Warnings.ca.gov."), null);
is("CALIFORNIA WARNING: is accepted", checkProp65("CALIFORNIA WARNING: Risk of cancer from exposure to lead. See www.P65Warnings.ca.gov"), null);
is("no signal word first", checkProp65("This product contains lead. www.P65Warnings.ca.gov"), "signal");
is("the signal word in lower case is not the signal word", checkProp65("warning: lead. www.P65Warnings.ca.gov"), "signal");
is("no P65Warnings site", checkProp65("WARNING: Contains lead."), "site");
is("too long", checkProp65(`WARNING: ${"x".repeat(MAX_PROP65)} www.P65Warnings.ca.gov`), "long");
is("a control character", checkProp65("WARNING: lead\u0000 www.P65Warnings.ca.gov"), "control");

part("Unit price (computed from the price charged, never typed)");
const g250 = readNetQuantity({ amount: "250", unit: "g" });
is("250 g at 2.49 is 9.96 per kilogram", unitPrice(249, g250), { cents: 996, unit: "kg", same: false });
is("0.75 L at 12.99 is 17.32 per liter", unitPrice(1299, readNetQuantity({ amount: "0.75", unit: "l" })), { cents: 1732, unit: "l", same: false });
is("a decimal comma reads the same", unitPrice(1299, readNetQuantity({ amount: "0,75", unit: "l" })), { cents: 1732, unit: "l", same: false });
is("33 cl at 1.99 is 6.03 per liter (6.0303..., rounded)", unitPrice(199, readNetQuantity({ amount: "33", unit: "cl" })), { cents: 603, unit: "l", same: false });
is("half a cent rounds up: 2 kg at 0.01", unitPrice(1, readNetQuantity({ amount: "2", unit: "kg" })), { cents: 1, unit: "kg", same: false });
is("1 kg at 5.00 is the selling price itself", unitPrice(500, readNetQuantity({ amount: "1", unit: "kg" })), { cents: 500, unit: "kg", same: true });
is("150 cm² at 3.00 is 200.00 per square meter", unitPrice(300, readNetQuantity({ amount: "150", unit: "cm2" })), { cents: 20000, unit: "m2", same: false });
is("2.5 m at 10.00 is 4.00 per meter", unitPrice(1000, readNetQuantity({ amount: "2.5", unit: "m" })), { cents: 400, unit: "m", same: false });
is("500 cm³ at 1.00 is 2,000.00 per cubic meter", unitPrice(100, readNetQuantity({ amount: "500", unit: "cm3" })), { cents: 200000, unit: "m3", same: false });
is("zero quantity is not a quantity", readNetQuantity({ amount: "0", unit: "g" }), null);
is("more than three decimals is refused", readNetQuantity({ amount: "0.1234", unit: "kg" }), null);
is("an unknown unit is refused", readNetQuantity({ amount: "1", unit: "lb" }), null);
is("a negative amount is refused", readNetQuantity({ amount: "-1", unit: "kg" }), null);
is("no quantity, no unit price", unitPrice(249, null), null);
is("an absurd result is refused rather than shown wrong", unitPrice(Number.MAX_SAFE_INTEGER, readNetQuantity({ amount: "0.001", unit: "g" })), null);
is("the unit is written out for screen readers (3.1.4)", unitWords("m2"), { short: "m²", long: "per square meter" });
is("liter", unitWords("l"), { short: "L", long: "per liter" });

part("Prior lowest price (98/6/EC art. 6a; CJEU C-330/23)");
const t0 = 1_800_000_000;
let history: PriceStep[] = [];
history = recordPrice(history, 1000, t0);
history = recordPrice(history, 1000, t0 + DAY);
is("the same price again adds no step", history.length, 1);
history = recordPrice(history, 800, t0 + 10 * DAY);
history = recordPrice(history, 1000, t0 + 12 * DAY);
const saleStart = t0 + 35 * DAY;
is("the lowest price of the 30 days before, not the price the day before", priorLowestPrice(history, saleStart), { cents: 800, complete: true });
history = recordPrice(history, 700, saleStart);
is("the sale price itself (from the start) is not part of its prior price", priorLowestPrice(history, saleStart), { cents: 800, complete: true });
is("a later sale, 45 days in: the 800 ended before its window", priorLowestPrice(recordPrice(history, 1000, saleStart + 5 * DAY), t0 + 45 * DAY), { cents: 700, complete: true });
is("a window that starts before the first price is flagged incomplete", priorLowestPrice([{ at: t0, cents: 900 }], t0 + 10 * DAY), { cents: 900, complete: false });
is("no price before the start: nothing to show", priorLowestPrice([{ at: t0, cents: 900 }], t0), null);
is("an empty history: nothing to show", priorLowestPrice([], t0), null);
is("the window is 30 days", PRIOR_PRICE_SECONDS, 30 * DAY);
is("kept for the window plus the longest sale, so a running sale still finds its prior price", PRICE_KEEP_SECONDS, (30 + MAX_SALE_DAYS) * DAY);
const runningSale = recordPrice(history, 1000, saleStart + (MAX_SALE_DAYS - 1) * DAY);
is("on the last day of a long sale its prior price is unchanged", priorLowestPrice(runningSale, saleStart), { cents: 800, complete: true });
const long = recordPrice(recordPrice([{ at: t0, cents: 500 }], 1000, t0 + DAY), 1200, t0 + 200 * DAY);
is("steps that ended before the kept period are dropped", long, [{ at: t0 + DAY, cents: 1000 }, { at: t0 + 200 * DAY, cents: 1200 }]);
is("a clock that goes back never reorders and never drops a price that was applied", recordPrice([{ at: t0, cents: 500 }], 600, t0 - 10), [{ at: t0, cents: 500 }, { at: t0 + 1, cents: 600 }]);
let busy: PriceStep[] = [];
let lowest = Infinity;
for (let i = 0; i < MAX_PRICE_STEPS + 20; i += 1) {
  const cents = 1000 + ((i * 37) % 300) - (i === 3 ? 600 : 0);
  if (i < MAX_PRICE_STEPS + 19) lowest = Math.min(lowest, cents);
  busy = recordPrice(busy, cents, t0 + i * 600);
}
is("the history never holds more than its cap", busy.length <= MAX_PRICE_STEPS, true);
is("merging keeps the lower price, so the prior price is never higher than the truth", priorLowestPrice(busy, t0 + (MAX_PRICE_STEPS + 19) * 600)?.cents, lowest);
is("the current price is never merged away", busy[busy.length - 1].cents, 1000 + (((MAX_PRICE_STEPS + 19) * 37) % 300));
is("a non-integer or negative price is not recorded", recordPrice([{ at: t0, cents: 500 }], -1, t0 + DAY), [{ at: t0, cents: 500 }]);

done();
