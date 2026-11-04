/**
 * The price on a product's card in an email (546 [EB1], unit 1; added
 * 4 November 2026): written from the facts the server reads, never from free
 * text, on synthetic stores and products only.
 */
import { MAIL_SALE_MARGIN_SECONDS, type PriceFacts, mailPriceLabel } from "@/lib/mail-product-price";
import { mailPriceFacts } from "@/lib/mail-product-sellable";
import { parseProduct } from "@/lib/catalog";
import { DEFAULT_FAIR, fairOff } from "@/lib/fair-price";
import { NO_SALE, type StoreSale } from "@/lib/store-sale";
import { NO_TAX } from "@/lib/tax";
import { speech, wordsIn } from "@/lib/buyer-words";
import { en } from "@/lib/buyer-words/en";
import { LANGUAGE_CODES } from "@/lib/store-language";
import type { Listing, Store } from "@/lib/store";
import { done, is, part } from "./check";

const NOW = 1_800_000_000;
const DAY = 86_400;
const shop = (extra: Partial<Store> = {}): Store => ({ currency: "usd", language: "en", sale: { ...NO_SALE }, tax: { ...NO_TAX }, ...extra }) as unknown as Store;
const listing = (raw: Record<string, unknown>): Listing => {
  const product = parseProduct({ id: "3f9a1c2b4d", title: "Guide", summary: "", priceCents: 2900, link: "https://example.com/guide", ...raw });
  if (!product) throw new Error("synthetic product refused");
  return product;
};
const sale = (ends: number, extra: Partial<StoreSale> = {}): StoreSale => ({ name: "Fall", percent: 20, starts: NOW - DAY, ends, all: true, products: [], coupon: "fall_sale_20", ...extra });
const label = (store: Store, product: Listing, now = NOW) => mailPriceLabel(store, mailPriceFacts(store, product, now), now);
const onTop = { tax: { ...NO_TAX, enabled: true, included: false } };

part("One price");
is("free: the store's word for it", label(shop(), listing({ priceCents: 0 })), "Free");
is("one price: the price", label(shop(), listing({})), "$29");
const until = speech(shop()).dateTime((NOW + 3 * DAY) * 1000);
is("a store sale with days to go: the sale price and the day it ends", label(shop({ sale: sale(NOW + 3 * DAY) }), listing({})), `Sale price: $23.20, until ${until}`);
is("the day it ends, in UTC with the zone's name", until.endsWith("UTC"), true);
is("a sale ending within a day: the regular price", [label(shop({ sale: sale(NOW + DAY - 60) }), listing({})), label(shop({ sale: sale(NOW + MAIL_SALE_MARGIN_SECONDS) }), listing({}))], ["$29", "$29"]);
is("a sale not covering this product: the regular price", label(shop({ sale: sale(NOW + 3 * DAY, { all: false, products: ["other12345"] }) }), listing({})), "$29");
is("a sale not started yet: the regular price", label(shop({ sale: sale(NOW + 3 * DAY, { starts: NOW + 60 }) }), listing({})), "$29");

part("Memberships, options and choosing the price");
const monthly = { recurring: { interval: "month", trialDays: 0, payments: 0 } };
is("a membership: the price and its interval", [label(shop(), listing({ ...monthly, priceCents: 900 })), label(shop(), listing({ recurring: { interval: "year", trialDays: 0, payments: 0 }, priceCents: 9000 }))], ["$9 a month", "$90 a year"]);
is("never the introductory or the yearly price", label(shop(), listing({ ...monthly, priceCents: 900, intro: { cents: 100, count: 3 }, yearly: { cents: 7900 } })), "$9 a month");
is("a store sale never touches a membership", label(shop({ sale: sale(NOW + 3 * DAY) }), listing({ ...monthly, priceCents: 900 })), "$9 a month");
const options = [
  { id: "opt_a", label: "Full", priceCents: 3000, link: "https://example.com/a" },
  { id: "opt_b", label: "Empty", priceCents: 1000 },
  { id: "opt_c", label: "Lite", priceCents: 2000, link: "https://example.com/c" },
];
is("options: from the lowest one a buyer can pick", label(shop(), listing({ priceCents: 1000, options })), "from $20");
is("options on a membership: from the lowest, a month", label(shop(), listing({ ...monthly, priceCents: 1000, options })), "from $20 a month");
is("a single option: its price", label(shop(), listing({ priceCents: 1000, options: [options[2]] })), "$20");
is("pay what you want: the floor, or more", label(shop(), listing({ priceCents: 500, pwyw: { suggestedCents: 1500 } })), "$5 or more");

part("Tax");
is("tax on top: said after the price", [label(shop(onTop), listing({})), label(shop(onTop), listing({ priceCents: 500, pwyw: { suggestedCents: 1500 } })), label(shop(onTop), listing({ ...monthly, priceCents: 900 }))], ["$29 + tax where it applies", "$5 or more + tax where it applies", "$9 a month + tax where it applies"]);
is("on a sale, the tax words follow the amount, before the end date", label(shop({ ...onTop, sale: sale(NOW + 3 * DAY) }), listing({})), `Sale price: $23.20 + tax where it applies, until ${until}`);
is("in every language, the tax words come before the end date", LANGUAGE_CODES.map((code) => {
  const store = shop({ ...onTop, language: code, sale: sale(NOW + 3 * DAY) } as Partial<Store>);
  const said = label(store, listing({}));
  const { w, dateTime } = speech(store);
  const tax = said.indexOf(w.plusTax);
  return tax > 0 && tax < said.indexOf(dateTime((NOW + 3 * DAY) * 1000));
}), LANGUAGE_CODES.map(() => true));
is("German says it in full, with no abbreviation", wordsIn("de").plusTax, "plus anfallende Steuern");
is("tax included or off: nothing added", [label(shop({ tax: { ...NO_TAX, enabled: true, included: true } }), listing({})), label(shop(), listing({}))], ["$29", "$29"]);
is("free with tax on: still just free", label(shop(onTop), listing({ priceCents: 0 })), "Free");

part("Never the price for a visitor's country");
const fair = { ...DEFAULT_FAIR, on: true, levels: { IN: 50 } };
const fairStore = shop({ fair, visitorCountry: "IN" } as Partial<Store>);
is("the fair price would take 50% off on the store page", fairOff(fair, listing({}), "IN"), 50);
is("the email's card keeps the price", label(fairStore, listing({})), "$29");

part("In the store's language");
const facts: PriceFacts = { free: false, priceCents: 2900, fromCents: 2900, optionCount: 0, interval: null, pwyw: true, sale: null, taxOnTop: true };
is("German, in euros", mailPriceLabel({ language: "de", currency: "eur" }, facts, NOW), `${speech({ language: "de", currency: "eur" }).money(2900)} oder mehr plus anfallende Steuern`);
is("Portuguese, free", mailPriceLabel({ language: "pt", currency: "eur" }, { ...facts, free: true }, NOW), "Grátis");
const keys = ["orMore", "plusTax", "salePriceUntil"];
is("each of the 7 languages has the 3 email card words, together at the end", LANGUAGE_CODES.map((code) => Object.keys(wordsIn(code)).slice(-3)), LANGUAGE_CODES.map(() => keys));
is("each says the price and the day it is given", LANGUAGE_CODES.map((code) => {
  const w = wordsIn(code);
  const said = w.salePriceUntil("PRICE", "WHEN");
  return w.orMore("PRICE").includes("PRICE") && said.includes("PRICE") && said.includes("WHEN") && w.plusTax.length > 0;
}), LANGUAGE_CODES.map(() => true));
is("only English is English", LANGUAGE_CODES.filter((code) => code !== "en" && wordsIn(code).plusTax === en.plusTax), []);

done();
