/**
 * Floating point in two percentages a buyer sees.
 *
 *   - lib/fair-price.ts countryOff: Math.floor(((1 - level) * 100) / 5) * 5.
 *     For Czechia (PRICE_LEVELS CZ = 0.55), 1 - 0.55 = 0.44999999999999996,
 *     so the suggestion is 40% off instead of the rule's 45% (multiples of
 *     five, rounded down), at the default cap of 50 and at 60. Shown on the
 *     page and charged through the mm_fair_40 coupon.
 *   - lib/option-units.ts unitLines: Math.floor((1 - price / count / single) * 100).
 *     "1 week" at 10.00 and "3 weeks" at 27.00 is exactly 10% less per week,
 *     but 1 - 0.9 = 0.09999999999999998, so it says "save 9%".
 *
 * Pure, no provider.
 */
import { countryOff } from "@/lib/fair-price";
import { unitLines } from "@/lib/option-units";
import { done, is, part } from "./check";

part("Fair price by country, Czechia (price level 0.55: 45% under the US level)");
is("suggested off at the default cap of 50 and at 60: 45, a multiple of five rounded down", [countryOff("CZ", 50), countryOff("CZ", 60)], [45, 45]);

part("Saving per unit between price options");
const o = (id: string, label: string, priceCents: number) => ({ id, label, priceCents });
is("3 weeks at 27.00 against 1 week at 10.00: 9.00 a week, 10% less", unitLines([o("a", "1 week", 1000), o("b", "3 weeks", 2700)]).get("b"), { perUnitCents: 900, unit: "week", savePercent: 10 });
is("5 weeks at 45.00 against 1 week at 10.00: also 10% less", unitLines([o("a", "1 week", 1000), o("b", "5 weeks", 4500)]).get("b")?.savePercent, 10);

done();
