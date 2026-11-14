/**
 * A call deposit with a percent-off code (lib/deposit-code.ts depositWithCode): the discount is the code's percent of
 * the whole price, rounded to the nearest cent with a half cent up, computed here (Stripe does not apply this code),
 * so it sets what the buyer pays now and what is left to pay in person. A code made in the creator's Stripe dashboard
 * can carry a decimal percent (percent_off 33.3, 12.5); in floating point 1500 × 33.3 / 100 is 499.49999999999994,
 * and Math.round made the discount 499 cents where the half-cent rule gives 500. The discount is now worked out from
 * the percent's own decimal digits in whole numbers. Pure values only.
 */
import { depositWithCode, type DepositCode } from "@/lib/deposit-code";
import { currencyRule } from "@/lib/money";
import { done, is, part } from "./check";

const code = (percent: number): DepositCode => ({ id: "promo_pinsDeposit", code: "PINS", active: true, expiresAt: null, limited: false, firstOrder: false, minimum: null, otherRules: false, off: { kind: "percent", percent } });
const offOf = (priceCents: number, percent: number) => {
  const r = depositWithCode(code(percent), { priceCents, deposit: priceCents, currency: "usd", nowSeconds: 1_800_000_000 });
  return r.ok ? r.figures.off : r.why;
};
/** The half-cent-up discount of a decimal percent, from its digits, in whole numbers. */
const exact = (priceCents: number, digits: string) => {
  const [whole, fraction = ""] = digits.split(".");
  const n = BigInt(priceCents) * BigInt(whole + fraction);
  const d = BigInt(100) * BigInt(10) ** BigInt(fraction.length);
  return Number((BigInt(2) * n + d) / (BigInt(2) * d));
};
/** What depositWithCode answers for that discount: the figure, or "small" when what is left online is under Stripe's minimum. */
const MIN = currencyRule("usd").minCharge;
const expected = (priceCents: number, off: number) => (priceCents - off < MIN ? "small" : off);

part("A half cent is rounded up, whatever floating point says");
is("33.3% of $15.00 is 499.5 cents: 500", offOf(1_500, 33.3), 500);
is("and the buyer's figures follow from it", depositWithCode(code(33.3), { priceCents: 1_500, deposit: 500, currency: "usd", nowSeconds: 1_800_000_000 }), { ok: true, figures: { off: 500, discounted: 1_000, charged: 500, rest: 500 } });
is("12.5% of $0.20 is 2.5 cents: 3", offOf(20_000, 12.5) === 2_500 && offOf(1_020, 12.5), 128);
{
  // Every price from $1.00 to $300.00 against decimal percents a dashboard code can carry: the exact rule, every time.
  let wrong = 0;
  const percents = ["0.5", "1.5", "2.5", "7.5", "8.25", "12.5", "15.5", "17.5", "33.3", "66.7", "99.9", "0.1", "19.99"];
  for (const digits of percents) for (let price = 100; price <= 30_000; price += 1) if (offOf(price, Number(digits)) !== expected(price, exact(price, digits))) wrong += 1;
  is("13 decimal percents on 29,901 prices each: never a cent off the half-up rule", wrong, 0);
}

part("Whole percents, as before");
is("25% of $80.00 is $20.00", offOf(8_000, 25), 2_000);
is("100% leaves nothing to charge online: refused as too small", offOf(8_000, 100), "small");
{
  let wrong = 0;
  for (let p = 1; p <= 99; p += 1) for (let price = 100; price <= 5_000; price += 7) if (offOf(price, p) !== expected(price, Math.floor((price * p + 50) / 100))) wrong += 1;
  is("whole percents 1 to 99 on many prices: the same half-up figure", wrong, 0);
}

done();
