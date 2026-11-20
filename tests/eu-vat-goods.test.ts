/**
 * EU VAT, part 2 of the build, unit 9a, wired by 789 [IV1] unit 1: goods are not shipped to the EU or the UK until
 * their VAT on goods is collected (Directive 2006/112/EC art. 14a; the UK's online marketplace rules; AGENTS.md IV).
 * lib/eu-vat-goods.ts (vatShipCloses) closes exactly the places consumerGate refuses a buyer from (REFUSED_PLACES),
 * plus the territories the code cannot settle, whatever the creator's own account; lib/physical-legal-ship.ts
 * (shippingNow) applies it beside the product safety lock, so the page, the store's answers, the cart and both
 * checkouts read one list. Filling the safety fields never opens a country the VAT lock closes. Synthetic only.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { vatShipCloses } from "@/lib/eu-vat-goods";
import { REFUSED_PLACES, consumerGate } from "@/lib/eu-vat-gate";
import { TERRITORY_UNSETTLED, type EuSupplyFields } from "@/lib/eu-vat-supply";
import { SHIP_COUNTRIES, shipsToWords } from "@/lib/shipping";
import { gpsrCloses } from "@/lib/physical-legal";
import { type PhysicalLegal } from "@/lib/physical-legal-record";
import { everywhereBut, shippingNow, shipsNowhere } from "@/lib/physical-legal-ship";
import { parseProduct } from "@/lib/catalog";
import { deliveryWords } from "@/lib/answers";
import { SHIPPING_WORDS } from "@/lib/buyer-words/shipping";
import { cartItemOf, cartShipping } from "@/lib/cart-shipping";
import { LANGUAGE_CODES } from "@/lib/store-language";

const SAFETY = {
  manufacturer: { name: "Harbor Print Co.", postal: "1 Dock Rd, Austin, TX 78701", electronic: "safety@harbor.example", country: "US" },
  responsible: { name: "EU Rep GmbH", postal: "Hafenstr. 1, 20457 Hamburg", electronic: "https://eurep.example/contact", country: "DE" },
  productType: "Hardcover cookbook, 120 pages",
  identifier: "Batch 2026-11",
  warnings: "",
  noWarnings: true,
};
const FULL: PhysicalLegal = { safety: SAFETY, prop65: "", quantities: [] };
const IMAGE = { path: `images/${"a".repeat(24)}/${"b".repeat(32)}.jpg`, width: 1200, height: 800, alt: "The Supper Book", bytes: 1, small: null };
const RAW = { id: "book1", title: "The Supper Book", priceCents: 3500 };
const shipped = (shipping: unknown, filled: boolean) =>
  parseProduct({ ...RAW, shipping, ...(filled ? { legal: FULL, image: IMAGE } : { legal: null }) })!;
const custom = (countries: string[], filled = true) => shipped({ cents: 600, region: "custom", countries, note: "" }, filled);
const world = (filled: boolean) => shipped({ cents: 600, region: "world", note: "" }, filled);

test("the lock closes exactly where consumerGate refuses a buyer, and the unsettled territories", () => {
  for (const code of REFUSED_PLACES) assert.equal(vatShipCloses(code), true, code);
  for (const code of TERRITORY_UNSETTLED) assert.equal(vatShipCloses(code), true, code);
  for (const code of ["US", "CA", "CH", "NO", "IS", "LI", "SJ", "AU", "JP", "BR"]) assert.equal(vatShipCloses(code), false, code);
  // The same set, read from the gate: a buyer billed in any country Stripe ships to is refused exactly where goods
  // are not sent, the unsettled territories aside (closed for shipping, refused at the gate as unknown).
  const goods: EuSupplyFields = { priceCents: 3500, file: null, link: null, keys: null, course: null, recurring: null, call: null, bundle: null, pwyw: null, shipping: { countries: ["US"] } };
  for (const code of SHIP_COUNTRIES) {
    if (TERRITORY_UNSETTLED.has(code)) continue;
    const refused = !consumerGate({ product: goods, headers: new Headers(), form: new URLSearchParams({ billing_country: code }) }).ok;
    assert.equal(vatShipCloses(code), refused, code);
  }
});

test("a custom list: the EU and the UK leave, the rest keeps selling; filling the safety fields never opens them", () => {
  assert.deepEqual(shippingNow(custom(["US", "GB", "DE", "CH"]))?.countries, ["US", "CH"]);
  assert.deepEqual(shippingNow(custom(["US", "GB", "DE", "CH"], false))?.countries, ["US", "CH"]);
  assert.deepEqual(shippingNow(custom(["US", "IM", "MC", "GF", "AX", "IC", "EA"]))?.countries, ["US"]);
  assert.equal(shippingNow(custom(["US", "GB"]))?.region, "custom");
  // The safety lock and the VAT lock are independent: filled opens the EEA outside the EU, never the EU or the UK.
  assert.deepEqual(shippingNow(custom(["US", "NO", "IS", "LI", "FR"]))?.countries, ["US", "NO", "IS", "LI"]);
  assert.deepEqual(shippingNow(custom(["US", "NO", "IS", "LI", "FR"], false))?.countries, ["US"]);
  // Nothing to close: the shipping as saved.
  const plain = shippingNow(custom(["US", "CA"]))!;
  assert.deepEqual([plain.countries, plain.region, plain.except], [["US", "CA"], "custom", undefined]);
});

test("shipped only to the EU or the UK: not sold anywhere until the opening, filled or not", () => {
  for (const countries of [["GB"], ["DE", "FR"], ["GB", "IM"]]) {
    assert.deepEqual([shippingNow(custom(countries))?.countries, shipsNowhere(custom(countries))], [[], true], countries.join());
  }
  assert.equal(shipsNowhere(custom(["GB", "NO"])), false);
});

test("a world product is said in a few words, in every buyer language", () => {
  const filled = shippingNow(world(true))!;
  const open = SHIP_COUNTRIES.filter((code) => !vatShipCloses(code));
  assert.deepEqual([filled.region, filled.except, filled.countries.length], ["custom", "eu-uk", open.length]);
  assert.equal(["DE", "FR", "GB", "IM", "MC", "AX", "GF"].some((code) => filled.countries.includes(code)), false);
  assert.equal(["NO", "IS", "LI", "SJ", "US", "CH"].every((code) => filled.countries.includes(code)), true);
  const bare = shippingNow(world(false))!;
  assert.deepEqual([bare.except, bare.countries.some(gpsrCloses), bare.countries.includes("GB")], ["eea-uk", false, false]);
  assert.deepEqual([everywhereBut(filled.countries), everywhereBut(bare.countries), everywhereBut(["US"])], ["eu-uk", "eea-uk", null]);
  assert.equal(shipsToWords(filled, "en-US", SHIPPING_WORDS.en), "most countries, except for now the European Union and the United Kingdom");
  assert.equal(shipsToWords(bare, "en-US", SHIPPING_WORDS.en), "most countries, except for now the European Union, the United Kingdom, Iceland, Liechtenstein and Norway");
  for (const code of LANGUAGE_CODES) {
    const words = SHIPPING_WORDS[code];
    assert.notEqual(words.everywhereElse, words.everywhereElseEu, code);
    assert.equal(shipsToWords(filled, code, words), words.everywhereElseEu, code);
    assert.equal(shipsToWords(bare, code, words), words.everywhereElse, code);
    assert.ok(words.everywhereElseEu.length < 160 && words.everywhereElse.length < 160, code);
  }
});

test("the store's answers say the same", () => {
  assert.match(deliveryWords(world(true)), /to: everywhere Stripe can ship to, except for now the European Union and the United Kingdom\./);
  assert.match(deliveryWords(world(false)), /except for now the European Union, the United Kingdom, Iceland, Liechtenstein and Norway\./);
  assert.match(deliveryWords(custom(["US", "GB", "DE"])), /to: US\./);
  assert.match(deliveryWords(custom(["GB"])), /not shipped anywhere right now/);
});

test("the cart ships only where every product ships now", () => {
  const items = [cartItemOf({ ...custom(["US", "GB", "CA"]), id: "a" }), cartItemOf({ ...custom(["US", "GB", "CA", "DE"]), id: "b" })];
  const sending = cartShipping(items);
  assert.equal(sending.kind, "ships");
  assert.deepEqual(sending.kind === "ships" ? sending.countries : null, ["US", "CA"]);
  assert.equal(cartShipping([cartItemOf({ ...custom(["GB"]), id: "c" })]).kind === "ships", false);
});

test("both checkouts and the cart route read shippingNow, and nothing else names the shipping countries", () => {
  const checkout = readFileSync("lib/store-checkout.ts", "utf8");
  const cart = readFileSync("lib/cart-shipping.ts", "utf8");
  for (const [name, source] of [["lib/store-checkout.ts", checkout], ["lib/cart-shipping.ts", cart]] as const) {
    assert.equal(/const shipping = shippingNow\(product\);/.test(source), true, name);
    assert.equal((source.match(/allowed_countries/g) ?? []).length, 1, name);
    assert.equal(/shipping\.countries\.forEach\(\(code, i\) => body\.set\(`shipping_address_collection\[allowed_countries\]\[\$\{i\}\]`, code\)\)/.test(source), true, name);
  }
  assert.match(readFileSync("app/api/store/cart/route.ts", "utf8"), /except: everywhereBut\(sending\.countries\) \?\? undefined/);
  // PayPal sells nothing shipped, so it never asks an address (lib/paypal-sales.ts, sellsWithPayPal).
  assert.match(readFileSync("lib/paypal-sales.ts", "utf8"), /if \(product\.shipping\) return false;/);
});
