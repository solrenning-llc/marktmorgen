/**
 * Mutation testing of lib/receiving-costs.ts (Claude 7, 13/11/2026), read only:
 * each case kills a mutant that survived the 9 tests importing the module.
 * On a small charge Paddle's fixed fee makes it the dearer provider, and that
 * dearer fee is the one taken; the revenue of a price is exact even at the
 * largest safe amount; a price that is not whole cents, or a reading with tax
 * inside the price, still takes that tax out, rounded down; and the IOF sum is
 * kept up to the largest safe amount, refused only above it.
 */
import { MOST_CORRECT_READING, PROVIDER_FEES, mostCorrectTaxesOf, providerFeeCents, revenueOf } from "@/lib/receiving-costs";
import { done, is, part } from "./check";

part("The dearer provider on a small charge");
const stripeOn = (cents: number) => {
  const s = PROVIDER_FEES.stripe;
  return [s.cardBps, s.internationalBps, s.conversionBps, s.billingBps, s.taxBps].reduce((sum, bps) => sum + Math.ceil((cents * bps) / 10_000), 0) + s.fixedCents;
};
const paddleOn = (cents: number) => Math.ceil((cents * PROVIDER_FEES.paddle.bps) / 10_000) + PROVIDER_FEES.paddle.fixedCents;
is("on $10, Paddle's fee is the dearer", paddleOn(1_000) > stripeOn(1_000), true);
is("and it is the one taken", providerFeeCents(1_000), paddleOn(1_000));
is("on $100, Stripe's is", providerFeeCents(10_000), stripeOn(10_000));

part("Revenue out of a price");
is("exact at the largest safe amount", revenueOf(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
is("a price that is not whole cents, rounded down", revenueOf(100.5), 100);
const inside = { ...MOST_CORRECT_READING, salesTaxInsideBps: 1_000 };
is("tax inside the price taken out, rounded down", revenueOf(12_100, inside), 11_000);
is("the same for a price that is not whole cents", revenueOf(100.5, inside), 91);

part("The IOF sum's limit");
const largest = mostCorrectTaxesOf({ currency: "BRL", annualProfitCents: 0, incomingExchangeCents: [Number.MAX_SAFE_INTEGER] });
is("the largest safe entry is still read", largest?.incomingExchangeCents, Number.MAX_SAFE_INTEGER);
is("one cent more is refused", mostCorrectTaxesOf({ currency: "BRL", annualProfitCents: 0, incomingExchangeCents: [Number.MAX_SAFE_INTEGER, 1] }), null);

done();
