/**
 * 361 [AP1] (d), unit 1: the creator's own discount on the first year, offered
 * only through the one email that offers the yearly price (lib/yearly-ask.ts),
 * as rules only. The creator's money, on the creator's own Stripe account: a
 * coupon off the first yearly charge, once; the year renews at the creator's
 * yearly price. Wiring it into the switch's preview and charge, so the amount
 * shown is the amount charged, is the next unit.
 *
 * What fails here:
 *   - a percent outside the creator's closed list kept, or none read as one;
 *   - a discount that lasts beyond the first year, or a renewal not said;
 *   - the discount for a member who did not come through the email, already
 *     has a discount, or has no yearly price to move to;
 *   - the first year in fractions of a cent; the words missing a language,
 *     or with urgency or scarcity.
 */
import { YEARLY_ASK_PERCENTS, askCouponBody, askOffer, offerApplies, readAskPercent } from "@/lib/yearly-ask-offer-rules";
import { parseYearlyAsk } from "@/lib/yearly-switch-rules";
import { membershipWords } from "@/lib/buyer-words/membership";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

part("The creator's percent");
is("a closed list", YEARLY_ASK_PERCENTS, [5, 10, 15, 20, 25]);
is("one of them", readAskPercent(15), 15);
is("anything else is none", [readAskPercent(12), readAskPercent("10"), readAskPercent(undefined), readAskPercent(100)], [0, 0, 0, 0]);
is("kept with the email's switch", parseYearlyAsk({ on: true, address: "1 Main St", percent: 10 }), { on: true, address: "1 Main St", percent: 10 });
is("none by default", parseYearlyAsk(undefined).percent, 0);

part("The offer");
const choice = { cents: 59_000, saving: 10_000, monthly: 5_900 };
is("the first year less the percent, whole cents, then the yearly price", askOffer(choice, 10), { percent: 10, firstYearCents: 53_100, renewalCents: 59_000 });
is("rounded to the cent", askOffer({ cents: 9_999, saving: 1, monthly: 1_000 }, 15)?.firstYearCents, 8_499);
is("no percent: no offer", askOffer(choice, 0), null);

part("Who it applies to");
is("came through the email, a yearly price, no discount yet", offerApplies({ emailed: true, choice, percent: 10, discounted: false }), true);
is("not through the email", offerApplies({ emailed: false, choice, percent: 10, discounted: false }), false);
is("already discounted", offerApplies({ emailed: true, choice, percent: 10, discounted: true }), false);
is("no yearly price to move to", offerApplies({ emailed: true, choice: null, percent: 10, discounted: false }), false);
is("no percent set", offerApplies({ emailed: true, choice, percent: 0, discounted: false }), false);

part("The coupon: once, on the first yearly charge only");
const body = askCouponBody(10);
is("percent off, once", [body.get("percent_off"), body.get("duration")], ["10", "once"]);
is("named for what it is", body.get("name"), "Yearly offer: 10% off the first year");
is("never repeating or forever", body.has("duration_in_months"), false);

part("The words");
for (const code of LANGUAGE_CODES) {
  const line = membershipWords(code).askOfferLine("10%", "$531.00", "$590.00");
  is(`${code}: the percent, the first year and the renewal`, ["10%", "$531.00", "$590.00"].every((v) => line.includes(v)), true);
  is(`${code}: no urgency or scarcity`, /hurry|last chance|limited|only|ends soon|expires/i.test(line), false);
}

done();
