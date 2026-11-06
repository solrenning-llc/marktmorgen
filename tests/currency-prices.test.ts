/**
 * A creator's own amount in other currencies (22 [E5], unit 1,
 * lib/currency-prices.ts; added 2 November 2026). Checked: what is kept and
 * what is refused (a shape that is not a plain object, an unlisted currency,
 * the store's own, one the account does not take, an amount outside the
 * range its kind has in that currency, anything while the account's
 * currencies are unknown), for a price, an amount off and a charge, in a
 * two-decimal currency and in the yen; the amount in a currency is the
 * creator's own, zero for zero, or none, never converted; a session is
 * offered in a currency only when every one of its amounts has it, as Stripe
 * asks; what a fixed-amount Price's currency_options would carry; the list
 * of amounts against the design; the bytes on a product with every amount
 * at its most; and that nothing in the site reads it yet.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AMOUNTS_WITH_CURRENCY_PRICES, MAX_CURRENCY_PRICES, amountFits, amountIn, currencyPricesMaxBytes, fixedPriceCurrencyOptions, localizableIn, parseCurrencyPrices, sessionCurrencies } from "@/lib/currency-prices";
import { CURRENCIES, currencyRule } from "@/lib/money";
import { MAX_PRODUCT_BYTES } from "@/lib/catalog";
import { MAX_OPTIONS } from "@/lib/product-option";
import { MAX_BUMPS } from "@/lib/product-extras";
import { MAX_FUNNEL_STEPS } from "@/lib/funnel";
import { done, is, part } from "./check";

const all = CURRENCIES.map((c) => c.code);
const why = (r: ReturnType<typeof parseCurrencyPrices>) => (r.ok ? "kept" : r.why);

part("What is kept and what is refused");
is("nothing to keep is always fine, even while the account is unknown", [parseCurrencyPrices(undefined, "usd", "price", null), parseCurrencyPrices({}, "usd", "price", null)], [{ ok: true, prices: {} }, { ok: true, prices: {} }]);
is("an amount in each currency the account takes, within its range", parseCurrencyPrices({ eur: 2500, jpy: 4000 }, "usd", "price", all), { ok: true, prices: { eur: 2500, jpy: 4000 } });
is("refused: the account's currencies unknown", why(parseCurrencyPrices({ eur: 2500 }, "usd", "price", null)), "account-unknown");
is("refused: a currency not on the list, even while the account is unknown", [parseCurrencyPrices({ brl: 2500 }, "usd", "price", all), parseCurrencyPrices({ brl: 2500 }, "usd", "price", null)], [{ ok: false, why: "unknown-currency", currency: "brl" }, { ok: false, why: "unknown-currency", currency: "brl" }]);
is("refused: __proto__ and constructor, read from JSON", [why(parseCurrencyPrices(JSON.parse('{"__proto__": 2500}'), "usd", "price", all)), why(parseCurrencyPrices(JSON.parse('{"constructor": 2500}'), "usd", "price", all))], ["unknown-currency", "unknown-currency"]);
is("refused: the store's own currency, which is the amount itself", why(parseCurrencyPrices({ usd: 2500 }, "usd", "price", all)), "own-currency");
is("refused: a currency the account does not take", parseCurrencyPrices({ eur: 2500 }, "usd", "price", ["usd", "gbp"]), { ok: false, why: "not-offered", currency: "eur" });
is("refused: under a price's range, over it, not whole, not a number", [{ eur: 99 }, { eur: 500_001 }, { eur: 25.5 }, { eur: "25" }].map((x) => why(parseCurrencyPrices(x, "usd", "price", all))), ["range", "range", "range", "range"]);
is("refused: not an object, a list, a Map or a Date, more entries than currencies", ["eur", [2500], new Map([["eur", 2500]]), new Date(), Object.fromEntries([...all, "zzz", "yyy"].map((c) => [c, 2500]))].map((x) => why(parseCurrencyPrices(x, "usd", "price", all))), ["shape", "shape", "shape", "shape", "shape"]);
const eur = currencyRule("eur");
is("a charge in euros: from the smallest charge, under a price's floor", [why(parseCurrencyPrices({ eur: eur.minCharge }, "usd", "charge", all)), why(parseCurrencyPrices({ eur: eur.minCharge - 1 }, "usd", "charge", all)), why(parseCurrencyPrices({ eur: eur.minCharge }, "usd", "price", all))], ["kept", "range", eur.minCharge >= eur.minPrice ? "kept" : "range"]);
is("an amount off: held to a price's range, as the discount route holds it", [amountFits(eur.minPrice, "eur", "off"), amountFits(eur.minPrice - 1, "eur", "off")], [true, false]);
const yen = currencyRule("jpy");
is("in yen, no decimals: its own floor and ceiling, for a price and a charge", [amountFits(yen.minPrice, "jpy", "price"), amountFits(yen.minPrice - 1, "jpy", "price"), amountFits(yen.maxPrice, "jpy", "price"), amountFits(yen.maxPrice + 1, "jpy", "price"), amountFits(yen.minCharge, "jpy", "charge"), amountFits(yen.minCharge - 1, "jpy", "charge")], [true, false, true, false, true, false]);
is("at most one amount for every other currency", MAX_CURRENCY_PRICES, CURRENCIES.length - 1);

part("Never converted");
is("the store's own amount, the creator's other amount, zero for zero, or none", [amountIn(2700, "usd", { eur: 2500 }, "usd"), amountIn(2700, "usd", { eur: 2500 }, "eur"), amountIn(0, "usd", undefined, "eur"), amountIn(2700, "usd", { eur: 2500 }, "gbp"), amountIn(2700, "usd", undefined, "gbp")], [2700, 2500, 0, null, null]);

part("A session, as Stripe asks");
const product = { amount: 2700, prices: { eur: 2500, gbp: 2200 } };
const bump = { amount: 900, prices: { eur: 800 } };
const freeShipping = { amount: 0 };
is("offered in a currency only when every amount has it; free shipping never stops it", [localizableIn([product, bump], "usd", "eur"), localizableIn([product, bump], "usd", "gbp"), localizableIn([product], "usd", "gbp"), localizableIn([product, freeShipping], "usd", "gbp"), localizableIn([], "usd", "eur")], [true, false, true, true, false]);
is("the currencies a session may be offered in, besides the store's own", [sessionCurrencies([product, bump], "usd"), sessionCurrencies([product], "usd"), sessionCurrencies([{ amount: 2700 }], "usd")], [["eur"], ["eur", "gbp"], []]);
is("what a fixed-amount Price's currency_options would carry: each other currency, its amount and its tax setting", fixedPriceCurrencyOptions({ jpy: 4000, eur: 2500 }, "exclusive"), { eur: { unit_amount: 2500, tax_behavior: "exclusive" }, jpy: { unit_amount: 4000, tax_behavior: "exclusive" } });

part("The amounts, against the design");
const design = readFileSync("docs/buyer-currency-and-language.md", "utf8");
const listed = AMOUNTS_WITH_CURRENCY_PRICES.map((a) => a.where).join(" | ");
is("every amount the design names is on the list", ["option", "payment plan", "order bump", "intro price", "discount code", "shipping", "yearly", "package", "pay what you want", "offer after paying"].filter((w) => !listed.includes(w)), []);
is("and the design names them", ["options", "plans", "order bump", "intro price", "fixed-amount coupons", "shipping", "the year", "packages", "pay what you want", "upsell"].filter((w) => !design.includes(w)), []);
is("a discount code lives on the creator's Stripe account, not on the product", AMOUNTS_WITH_CURRENCY_PRICES.filter((a) => !a.onProduct).map((a) => a.where), ["fixed-amount discount code", "discount code, minimum order"]);

part("What it costs");
const each = currencyPricesMaxBytes();
// One product at its most: its price, an option each, a payment for the product and for each option, the boxes, the offers after paying, its intro price, shipping, year, package and suggestion.
const onOneProduct = 1 + MAX_OPTIONS + (1 + MAX_OPTIONS) + MAX_BUMPS + MAX_FUNNEL_STEPS + 5;
is("one amount's largest entry, and a product with every amount at its most, within a tenth of a product's ceiling", [each, onOneProduct, each * onOneProduct, each * onOneProduct < MAX_PRODUCT_BYTES / 10], [208, 115, 23_920, true]);

part("Nothing reads it yet");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|mjs|js)$/.test(name) ? [p] : []; });
const root = readdirSync(".").filter((f) => /\.(tsx?|mjs|js)$/.test(f) && statSync(f).isFile());
is("no page, route, component, library, script or root file imports it", [...["app", "components", "lib", "scripts"].flatMap(walk), ...root].filter((f) => f !== join("lib", "currency-prices.ts") && /currency-prices["']/.test(readFileSync(f, "utf8"))), []);

done();
