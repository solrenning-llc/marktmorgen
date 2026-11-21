/**
 * 624 [SZ8](48), unit 1: less per place when a team buys more of them
 * (lib/group-volume-rules.ts). What is checked:
 *
 *   - up to three tiers, each from 3 to 200 people and 1% to 75% off, going up
 *     in both; anything else refused with its reason, never rounded or
 *     reordered; a kept value that would be refused today is none;
 *   - the tier that applies is the highest reached; below the first, the
 *     product's own price;
 *   - one place rounded as a store-wide sale rounds it, never below the
 *     currency's least, the total that times the people and refused past what
 *     one payment may be;
 *   - never added to a store-wide sale: the better of the two, said as that one.
 */
import { MAX_PEOPLE, MIN_PEOPLE } from "@/lib/group-rules";
import { salePrice } from "@/lib/store-sale";
import {
  MAX_TIERS,
  MAX_TIER_PERCENT,
  MIN_TIER_PEOPLE,
  VOLUME_PROBLEM_WORDS,
  parseVolumeTiers,
  readVolumeTiers,
  teamPrice,
  tierFor,
  tiersLine,
} from "@/lib/group-volume-rules";
import { done, is, part } from "./check";

const tiers = [
  { from: 10, percent: 10 },
  { from: 25, percent: 20 },
];

part("What the studio may set");
is("tiers as typed or as numbers", readVolumeTiers([{ from: "10", percent: "10" }, { from: 25, percent: 20 }]), tiers);
is("none: empty, absent, or an empty list", [readVolumeTiers(""), readVolumeTiers(undefined), readVolumeTiers(null), readVolumeTiers([])], [[], [], [], []]);
is("at most three", [readVolumeTiers([{ from: 3, percent: 1 }, { from: 4, percent: 2 }, { from: 5, percent: 3 }]).length, readVolumeTiers([{ from: 3, percent: 1 }, { from: 4, percent: 2 }, { from: 5, percent: 3 }, { from: 6, percent: 4 }])], [MAX_TIERS, "tiers"]);
is("people from three to the most a purchase is for", [readVolumeTiers([{ from: MIN_PEOPLE, percent: 10 }]), readVolumeTiers([{ from: MAX_PEOPLE + 1, percent: 10 }]), readVolumeTiers([{ from: MIN_TIER_PEOPLE, percent: 10 }]), readVolumeTiers([{ from: MAX_PEOPLE, percent: 10 }])], ["from", "from", [{ from: 3, percent: 10 }], [{ from: 200, percent: 10 }]]);
is("whole percents from 1 to 75", [readVolumeTiers([{ from: 10, percent: 0 }]), readVolumeTiers([{ from: 10, percent: MAX_TIER_PERCENT + 1 }]), readVolumeTiers([{ from: 10, percent: 12.5 }]), readVolumeTiers([{ from: 10, percent: "10%" }]), readVolumeTiers([{ from: 10, percent: 75 }])], ["percent", "percent", "percent", "percent", [{ from: 10, percent: 75 }]]);
is("never rounded: 10.5 people is refused", readVolumeTiers([{ from: 10.5, percent: 10 }]), "from");
is("each step needs more people and more off, never reordered", [readVolumeTiers([{ from: 25, percent: 20 }, { from: 10, percent: 10 }]), readVolumeTiers([{ from: 10, percent: 20 }, { from: 25, percent: 20 }]), readVolumeTiers([{ from: 10, percent: 10 }, { from: 10, percent: 20 }])], ["order", "order", "order"]);
is("not a list, or a row that is not one", [readVolumeTiers({ from: 10, percent: 10 }), readVolumeTiers(["10:10"])], ["tiers", "from"]);
is("a kept value that would be refused today is none", [parseVolumeTiers([{ from: 25, percent: 20 }, { from: 10, percent: 10 }]), parseVolumeTiers(tiers)], [[], tiers]);
is("each refusal says what to do", Object.values(VOLUME_PROBLEM_WORDS).every((s) => s.length > 10 && /\.$/.test(s)), true);

part("Which tier applies");
is("the highest one reached", [tierFor(tiers, 9), tierFor(tiers, 10), tierFor(tiers, 24), tierFor(tiers, 25), tierFor(tiers, 200)], [null, tiers[0], tiers[0], tiers[1], tiers[1]]);

part("What a team pays");
is("below the first tier: the product's own price", teamPrice(4900, 5, tiers), { eachCents: 4900, totalCents: 24500, percent: 0, by: "none" });
is("from 10: 10% off each place", teamPrice(4900, 10, tiers), { eachCents: 4410, totalCents: 44100, percent: 10, by: "tier" });
is("from 25: 20% off", teamPrice(4900, 25, tiers), { eachCents: 3920, totalCents: 98000, percent: 20, by: "tier" });
is("rounded to the cent as a store-wide sale rounds it", [teamPrice(999, 10, tiers)?.eachCents, salePrice(999, 10)], [salePrice(999, 10), 899]);
is("more people never pay more per place", [5, 9, 10, 24, 25, 100].map((n) => teamPrice(4900, n, tiers)!.eachCents).every((each, at, all) => at === 0 || each <= all[at - 1]), true);
is("never added to a store-wide sale: the better of the two", [teamPrice(4900, 10, tiers, 15), teamPrice(4900, 25, tiers, 15), teamPrice(4900, 3, tiers, 15)], [
  { eachCents: 4165, totalCents: 41650, percent: 15, by: "sale" },
  { eachCents: 3920, totalCents: 98000, percent: 20, by: "tier" },
  { eachCents: 4165, totalCents: 12495, percent: 15, by: "sale" },
]);
is("refused: one person, past the most, a free product, below the currency's least, a total past one payment", [teamPrice(4900, 1, tiers), teamPrice(4900, MAX_PEOPLE + 1, tiers), teamPrice(0, 10, tiers), teamPrice(60, 10, [{ from: 10, percent: 75 }], 0, 50), teamPrice(50_000_000, 2, [])], [null, null, null, null, null]);

part("The studio's words");
is("plain English, the first step in full", [tiersLine(tiers), tiersLine([]), tiersLine([{ from: 5, percent: 5 }])], ["10% off each place from 10 people, 20% off from 25", "", "5% off each place from 5 people"]);

done();
