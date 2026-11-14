/**
 * Pins how a typed price becomes the amount a product is charged at (lib/money.ts readMoney), and how an amount in the
 * smallest unit is written back (plainAmount, toMajor, decimalsOf). readMoney was checked only by the text of the code
 * that calls it, so a float slip ("0.29" read as 28 cents), a third decimal accepted, or a yen price read as cents
 * would not have failed a test. Pure values only.
 */
import { CURRENCIES, decimalsOf, plainAmount, priceInRange, readMoney, toMajor } from "@/lib/money";
import { done, is, part } from "./check";

part("readMoney: only one unambiguous plain amount, in the smallest unit");
is("whole dollars", readMoney("27", "usd"), 2_700);
is("one decimal is tens of cents", readMoney("27.5", "usd"), 2_750);
is("two decimals", readMoney("27.50", "usd"), 2_750);
is("spaces around are ignored", readMoney("  9.99 ", "eur"), 999);
is("amounts that float arithmetic gets wrong are read exactly", [readMoney("0.29", "usd"), readMoney("1.15", "usd"), readMoney("4.35", "gbp"), readMoney("19.99", "cad")], [29, 115, 435, 1_999]);
{
  // Every typed amount from 0.00 to 99.99: never a cent off.
  let wrong = 0;
  for (let cents = 0; cents < 10_000; cents += 1) {
    const typed = `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
    if (readMoney(typed, "usd") !== cents) wrong += 1;
  }
  is("each of the 10,000 amounts from 0.00 to 99.99 reads to its own cents", wrong, 0);
}
is("the yen has no decimals: 2700 is ¥2,700, never ¥27", readMoney("2700", "jpy"), 2_700);
is("a decimal on the yen is refused", readMoney("27.5", "jpy"), null);
is("a third decimal, a sign, a separator, a comma or a letter is refused", [readMoney("27.555", "usd"), readMoney("$27", "usd"), readMoney("1,000", "usd"), readMoney("27,50", "eur"), readMoney("27a", "usd"), readMoney("-5", "usd")], [null, null, null, null, null, null]);
is("nothing, a lone point or a trailing point is refused", [readMoney("", "usd"), readMoney(".5", "usd"), readMoney("27.", "usd")], [null, null, null]);
is("more than seven whole digits is refused (nine for the yen)", [readMoney("10000000", "usd"), readMoney("9999999.99", "usd"), readMoney("999999999", "jpy"), readMoney("1000000000", "jpy")], [null, 999_999_999, 999_999_999, null]);

part("Writing an amount back");
is("decimals of the listed currencies as their own rules say", CURRENCIES.map((c) => [c.code, decimalsOf(c.code)]), CURRENCIES.map((c) => [c.code, c.decimals]));
is("a code in capitals reads the same", [decimalsOf("JPY"), decimalsOf("USD")], [0, 2]);
is("Stripe's three-decimal and zero-decimal currencies outside the list", [decimalsOf("kwd"), decimalsOf("bhd"), decimalsOf("krw"), decimalsOf("vnd")], [3, 3, 0, 0]);
is("toMajor: 2750 cents is 27.5 dollars, 2750 yen is 2750, 1234 fils is 1.234 dinars", [toMajor(2_750, "usd"), toMajor(2_750, "jpy"), toMajor(1_234, "kwd")], [27.5, 2_750, 1.234]);
is("plainAmount writes every decimal the currency has", [plainAmount(2_750, "usd"), plainAmount(5, "eur"), plainAmount(2_750, "jpy"), plainAmount(1_234, "kwd"), plainAmount(0, "usd")], ["27.50", "0.05", "2750", "1.234", "0.00"]);
is("what plainAmount writes, readMoney reads back to the same amount", [999, 2_750, 100, 123_456].every((n) => readMoney(plainAmount(n, "usd"), "usd") === n) && readMoney(plainAmount(4_500, "jpy"), "jpy") === 4_500, true);

part("priceInRange: each currency's own bounds, whole units only");
for (const rule of CURRENCIES) {
  is(`${rule.code}: its minimum and maximum are in range, one below and one above are not, and a fraction never`, [
    priceInRange(rule.minPrice, rule.code),
    priceInRange(rule.maxPrice, rule.code),
    priceInRange(rule.minPrice - 1, rule.code),
    priceInRange(rule.maxPrice + 1, rule.code),
    priceInRange(rule.minPrice + 0.5, rule.code),
  ], [true, true, false, false, false]);
}

done();
