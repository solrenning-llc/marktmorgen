/**
 * 618 [SZ2] unit 3: the legal information fields of a physical product reach
 * the buyer, and the EU/EEA countries stay off its checkout while they are
 * not filled (docs/sz2-physical-legal-fields.md, "Next units", 2).
 *
 *   - the product page shows, before the buy button, the fields the creator
 *     filled (manufacturer, the EU responsible person when the manufacturer is
 *     outside the EU/EEA, type or model, warnings or the "no warnings"
 *     statement), the creator's Proposition 65 text and the unit price, under
 *     a heading, in a definition list, as text (AX274 2.4.10, 1.4.9, 3.1.4);
 *   - the checkout of one product and of a cart leaves out the EU/EEA
 *     countries while gpsrClosedCountries says so; a product that ships
 *     nowhere else is not sold; unknown (an unreadable record, a forged mark)
 *     is closed, never open;
 *   - the listing carries only a computed mark, so the store page and the
 *     cart know without reading the legal record; the product page reads it
 *     from the product's own record, in parallel, and nothing else;
 *   - the buyer's words in the seven store languages.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addOption, addProduct, claimHandle, ensureStatsId, setProductImage, setProductLegal, setProductShipping, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { catalogRecord, listingOf, parseCatalog, parseProduct, readListing, readProduct, readProductLegal } from "@/lib/catalog";
import { activeShipping, parseShipping, SHIP_COUNTRIES, shipsToWords } from "@/lib/shipping";
import { GPSR_AREA, gpsrCloses, safetyGaps, unitWords } from "@/lib/physical-legal";
import { deliveryWords } from "@/lib/answers";
import { SHIPPING_WORDS } from "@/lib/buyer-words/shipping";
import { type PhysicalLegal, safetySummary } from "@/lib/physical-legal-record";
import { shippingNow, shipsNowhere } from "@/lib/physical-legal-ship";
import { cartItemOf, cartShipping } from "@/lib/cart-shipping";
import { canSellProduct, createCheckout } from "@/lib/store-checkout";
import { PRODUCT_SAFETY_WORDS, productSafetyWords } from "@/lib/buyer-words/product-safety";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { ProductSafetyFacts } from "@/components/product-safety-facts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "sz2-u3-owner@example.com";
const checkouts: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"s".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const SAFETY = {
  manufacturer: { name: "Harbor Print Co.", postal: "1 Dock Rd, Austin, TX 78701", electronic: "safety@harbor.example", country: "US" },
  responsible: { name: "EU Rep GmbH", postal: "Hafenstr. 1, 20457 Hamburg", electronic: "https://eurep.example/contact", country: "DE" },
  productType: "Hardcover cookbook, 120 pages",
  identifier: "Batch 2026-11",
  warnings: "",
  noWarnings: true,
};
const PROP65 = "WARNING: This product can expose you to lead, which is known to the State of California to cause cancer. For more information go to www.P65Warnings.ca.gov.";
const FULL: PhysicalLegal = { safety: SAFETY, prop65: PROP65, quantities: [{ price: "", amount: "1.2", unit: "kg" }] };
const IMAGE = { path: `images/${"a".repeat(24)}/${"b".repeat(32)}.jpg`, width: 1200, height: 800, alt: "The Supper Book", bytes: 1, small: null };
const RAW = { id: "book1", title: "The Supper Book", priceCents: 3500, shipping: { cents: 600, region: "custom", countries: ["US", "FR", "DE"], note: "" } };

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_sz2_u3_only_a_stand_in";

  part("Where it ships now: the EU/EEA only once the safety fields are filled");
  const bare = parseProduct(RAW)!;
  is("nothing filled: the EU/EEA countries are left out, the rest kept", [shippingNow(bare)?.countries, shippingNow(bare)?.region, shippingNow(bare)?.cents], [["US"], "custom", 600]);
  const filled = parseProduct({ ...RAW, legal: FULL, image: IMAGE })!;
  is("everything filled, with a picture: every country", shippingNow(filled)?.countries, ["US", "FR", "DE"]);
  is("filled without a picture: still closed", shippingNow(parseProduct({ ...RAW, legal: FULL })!)?.countries, ["US"]);
  is("a product that is not shipped has no shipping", shippingNow(parseProduct({ id: "pdf1", title: "PDF", priceCents: 1200 })!), null);
  const euOnly = parseProduct({ ...RAW, shipping: { cents: 600, region: "custom", countries: ["FR", "DE"], note: "" } })!;
  is("shipped only to the EU/EEA and not filled: still physical, shipped nowhere", [shippingNow(euOnly) !== null, shippingNow(euOnly)?.countries, shipsNowhere(euOnly), shipsNowhere(bare), shipsNowhere(filled)], [true, [], true, false, false]);
  is("the EEA counts too", shippingNow(parseProduct({ ...RAW, shipping: { cents: 0, region: "custom", countries: ["NO", "IS", "LI", "CH"], note: "" } })!)?.countries, ["CH"]);
  const world = parseProduct({ ...RAW, shipping: { cents: 600, region: "world", note: "" } })!;
  const worldNow = shippingNow(world)!;
  is("a region that loses countries is said as the countries left", [worldNow.region, worldNow.countries.some((code) => GPSR_AREA.includes(code)), worldNow.countries.length > 0], ["custom", false, true]);
  is("an unreadable legal record reads as not filled", shippingNow(parseProduct({ ...RAW, legal: { safety: "full" }, image: IMAGE })!)?.countries, ["US"]);

  // Independent review of #3029 at aaba5bd4f, findings 1 and 2 (their proof, kept here).
  part("EU and EEA territory with its own two letters; a world product said in a few words");
  // Åland (TFEU art. 355(4)) and the French outermost regions (arts. 349 and 355(1); OJ C 202, 7.6.2016).
  const TERRITORIES = ["AX", "GF", "GP", "MF", "MQ", "RE", "YT"];
  is("Åland and the French outermost regions are in the Union: closed on a world product not filled", TERRITORIES.filter((code) => worldNow.countries.includes(code)), []);
  is("shipped to Réunion, Guadeloupe and the US, not filled: only the US", shippingNow(parseProduct({ ...RAW, shipping: { cents: 600, region: "custom", countries: ["RE", "GP", "US"], note: "" } })!)?.countries, ["US"]);
  is("Svalbard and Jan Mayen share one code, and Jan Mayen is in the EEA: closed while not filled", worldNow.countries.includes("SJ"), false);
  const worldFilled = shippingNow(parseProduct({ ...RAW, shipping: { cents: 600, region: "world", note: "" }, legal: FULL, image: IMAGE })!)!;
  is("filled: every one of them opens again, and the region is kept", [[...TERRITORIES, "SJ"].every((code) => worldFilled.countries.includes(code)), worldFilled.region], [true, "world"]);
  is("a manufacturer in Réunion is in the Union: no responsible person asked for", safetyGaps({ ...SAFETY, manufacturer: { ...SAFETY.manufacturer, country: "RE" }, responsible: null }, true), []);
  is("a responsible person in Martinique is in the Union", safetyGaps({ ...SAFETY, responsible: { ...SAFETY.responsible, country: "MQ" } }, true), []);
  is("a manufacturer on Svalbard, outside the EEA, still needs one", safetyGaps({ ...SAFETY, manufacturer: { ...SAFETY.manufacturer, country: "SJ" }, responsible: null }, true).includes("responsible"), true);
  const worldWords = deliveryWords(listingOf(world));
  is("the delivery fact of a world product not filled stays short", [worldWords.length < 400, worldWords.includes("AD, AE")], [true, false]);
  is("it names the region and what is left out", worldWords.includes("to: everywhere Stripe can ship to, except for now the European Union, Iceland, Liechtenstein and Norway."), true);
  is("the buy box says it in a few words", shipsToWords(worldNow, "en-US", SHIPPING_WORDS.en), "most countries, except for now the European Union, Iceland, Liechtenstein and Norway");
  for (const code of LANGUAGE_CODES) is(`${code}: said, not listed`, shipsToWords(worldNow, code, SHIPPING_WORDS[code]).length < 160, true);
  is("a custom list stays a list", shipsToWords(shippingNow(bare)!, "en-US", SHIPPING_WORDS.en), "United States");
  const cartRoute = readFileSync("app/api/store/cart/route.ts", "utf8");
  is("the cart says it the same way", /everywhereButGpsr\(sending\.countries\)/.test(cartRoute), true);

  part("The listing carries a computed mark, never the record");
  const listing = listingOf(filled);
  is("filled: the mark, and no legal record on the listing", [listing.safetyFilled, Object.hasOwn(listing, "legal")], [true, false]);
  is("not filled: no mark", Object.hasOwn(listingOf(bare), "safetyFilled"), false);
  is("the store page and the cart read the mark", shippingNow(listing)?.countries, ["US", "FR", "DE"]);
  is("a mark typed into the record is not believed: a full product is read from its own record", shippingNow(parseProduct({ ...RAW, safetyFilled: true })!)?.countries, ["US"]);
  is("a listing without the mark is closed", shippingNow(listingOf(bare))?.countries, ["US"]);

  part("Kept through the store's own records");
  await claimHandle(OWNER, "harborthree", "Harbor Books", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSz2Three01", true);
  await setSubscription(OWNER, { customerId: "cus_Sz2Three01", subscriptionId: "sub_Sz2Three01", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "The Supper Book", "Printed, 120 pages.", "35", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  await setProductShipping(OWNER, id, parseShipping({ cents: 600, region: "custom", countries: ["US", "FR", "DE"], note: "" })!);
  await addOption(OWNER, id, "Signed", "45");
  let store = (await storeForEmail(OWNER))!;
  const optionId = (await readProduct(store, id))!.options[0].id;
  const legal: PhysicalLegal = { ...FULL, quantities: [...FULL.quantities, { price: optionId, amount: "1.5", unit: "kg" }] };
  await setProductLegal(OWNER, id, legal);
  store = (await storeForEmail(OWNER))!;
  is("saved without a picture: the listing is not marked", (await readListing(store, id))?.safetyFilled ?? false, false);
  await setProductImage(OWNER, id, IMAGE);
  store = (await storeForEmail(OWNER))!;
  is("with the picture added: marked", (await readListing(store, id))?.safetyFilled, true);
  is("the legal record of one product, from its own record", await readProductLegal(store, id), legal);
  is("a product without one: null", await readProductLegal(store, "nope"), null);
  const catalog = store.catalog.id!;
  const extrasKey = `nl:catalog:${catalog}:x:${id}`;
  const listingKey = `nl:catalog:${catalog}:l:${id}`;
  const savedExtras = (await redis.pipeline([["GET", extrasKey]]))[0];
  const savedListing = (await redis.pipeline([["GET", listingKey]]))[0];
  await redis.pipeline([["SET", extrasKey, "{not json"]]);
  store = (await storeForEmail(OWNER))!;
  is("its record unreadable: no legal record, and its checkout leaves the EU/EEA out though the listing is marked", [await readProductLegal(store, id), shippingNow((await readProduct(store, id))!)?.countries], [null, ["US"]]);
  await redis.pipeline([["SET", extrasKey, String(savedExtras)]]);
  const record = catalogRecord(store.catalog);
  const forged = parseCatalog({ ...record, head: [{ ...JSON.parse(String(savedListing)), safetyFilled: "yes" }] }, null).head[0];
  const kept = parseCatalog({ ...record, head: [JSON.parse(String(savedListing))] }, null).head[0];
  is("read back from the store record, the mark is kept only when exactly true", [shippingNow(forged)?.countries, shippingNow(kept)?.countries, kept.safetyFilled], [["US"], ["US", "FR", "DE"], true]);
  await setProductImage(OWNER, id, null);
  store = (await storeForEmail(OWNER))!;
  is("the picture taken off: the mark goes with it", (await readListing(store, id))?.safetyFilled ?? false, false);
  await setProductImage(OWNER, id, IMAGE);

  part("The checkout of one product");
  store = (await storeForEmail(OWNER))!;
  let product = (await readProduct(store, id))!;
  await createCheckout(store, product, "https://marktmorgen.com", optionId, {});
  let sent = checkouts.at(-1)!;
  is("filled: Stripe asks for an address in every country", sent.getAll("shipping_address_collection[allowed_countries][0]").concat(sent.getAll("shipping_address_collection[allowed_countries][1]"), sent.getAll("shipping_address_collection[allowed_countries][2]")), ["US", "FR", "DE"]);
  await setProductLegal(OWNER, id, { ...legal, safety: { ...SAFETY, productType: "" } });
  store = (await storeForEmail(OWNER))!;
  product = (await readProduct(store, id))!;
  await createCheckout(store, product, "https://marktmorgen.com", optionId, {});
  sent = checkouts.at(-1)!;
  is("a gap: the EU/EEA countries are not offered", [sent.get("shipping_address_collection[allowed_countries][0]"), sent.has("shipping_address_collection[allowed_countries][1]")], ["US", false]);
  is("still sold where it ships", canSellProduct(store, product), true);
  await setProductShipping(OWNER, id, parseShipping({ cents: 600, region: "custom", countries: ["FR", "DE"], note: "" })!);
  store = (await storeForEmail(OWNER))!;
  product = (await readProduct(store, id))!;
  const before = checkouts.length;
  let refused = "opened";
  await createCheckout(store, product, "https://marktmorgen.com", optionId, {}).catch(() => (refused = "refused"));
  is("shipped only to the EU/EEA with a gap: not sold, refused before Stripe", [canSellProduct(store, product), canSellProduct(store, listingOf(product)), refused, checkouts.length], [false, false, "refused", before]);

  part("The cart");
  const cartBook = parseProduct({ ...RAW, id: "cartbook" })!;
  const cartMug = parseProduct({ ...RAW, id: "cartmug", title: "Mug", legal: FULL, image: IMAGE })!;
  is("one address, in the countries both reach now", cartShipping([cartBook, cartMug].map(cartItemOf)), { kind: "ships", countries: ["US"], cents: 1200, each: [{ id: "cartbook", cents: 600 }, { id: "cartmug", cents: 600 }] });
  is("both filled: every country they share", cartShipping([parseProduct({ ...RAW, id: "a", legal: FULL, image: IMAGE })!, cartMug].map(cartItemOf)).kind === "ships" ? (cartShipping([parseProduct({ ...RAW, id: "a", legal: FULL, image: IMAGE })!, cartMug].map(cartItemOf)) as { countries: string[] }).countries : [], ["US", "FR", "DE"]);
  is("a product that ships nowhere now cannot be paid for in a cart", cartShipping([euOnly].map(cartItemOf)).kind, "unreadable");

  part("The buyer's words, in every store language");
  const keys = Object.keys(PRODUCT_SAFETY_WORDS.en).sort();
  for (const code of LANGUAGE_CODES) is(`${code}: the same words as English`, Object.keys(PRODUCT_SAFETY_WORDS[code]).sort(), keys);
  is("the heading", productSafetyWords("en").heading, "Product safety and manufacturer");
  is("each unit in words, as the studio's module says it", (["kg", "l", "m", "m2", "m3"] as const).map((unit) => productSafetyWords("en").per[unit]), (["kg", "l", "m", "m2", "m3"] as const).map((unit) => unitWords(unit).long));
  is("unknown language: English", productSafetyWords("xx"), PRODUCT_SAFETY_WORDS.en);

  part("On the product page, before the buy button");
  store = (await storeForEmail(OWNER))!;
  const shown = renderToStaticMarkup(createElement(ProductSafetyFacts, { store, product: (await readListing(store, id))!, legal }));
  for (const words of ["<section", "<h2", "Product safety and manufacturer", "<dl", "<dt", "<dd", "Manufacturer", "Harbor Print Co.", "1 Dock Rd, Austin, TX 78701", "safety@harbor.example", "United States", "EU responsible person", "EU Rep GmbH", "Germany", "Product type or model", "Hardcover cookbook, 120 pages", "Batch 2026-11", "Harbor Books states that this product has no warnings.", "California Proposition 65", "<strong>WARNING:</strong>", "www.P65Warnings.ca.gov", "Signed, unit price: $30 per kilogram"]) {
    is(`shows: ${words}`, shown.includes(words), true);
  }
  is("with several prices, only theirs: the main price is not sold on its own", shown.includes("Unit price: $29.17"), false);
  const single = renderToStaticMarkup(createElement(ProductSafetyFacts, { store, product: listingOf(parseProduct({ ...RAW, legal: FULL })!), legal: FULL }));
  is("one price: its unit price, computed from the price charged", single.includes("Unit price: $29.17 per kilogram"), true);
  const onSale = { ...store, sale: { name: "Fall", percent: 50, starts: 1, ends: 4_000_000_000, all: true, products: [], coupon: "fall50" } };
  is("during a store sale, from the sale price", renderToStaticMarkup(createElement(ProductSafetyFacts, { store: onSale, product: listingOf(parseProduct({ ...RAW, legal: FULL })!), legal: FULL })).includes("Unit price: $14.58 per kilogram"), true);
  is("as text, never a picture of text", /<img|<svg|<canvas/.test(shown), false);
  is("the unit is never abbreviated", /\$\d+(\.\d+)? ?\/ ?kg|per kg\b/.test(shown), false);
  is("never says the product complies", /\b(compliant|complies|compliance|certified|approved)\b/i.test(shown), false);
  const inEu = renderToStaticMarkup(createElement(ProductSafetyFacts, { store, product: (await readListing(store, id))!, legal: { ...legal, safety: { ...SAFETY, manufacturer: { ...SAFETY.manufacturer, country: "FR" }, warnings: "Keep away from fire.", noWarnings: false } } }));
  is("a manufacturer in the EU/EEA: no responsible person row; the warnings as typed", [inEu.includes("EU Rep GmbH"), inEu.includes("Keep away from fire."), inEu.includes("no warnings")], [false, true, false]);
  is("nothing filled: nothing shown", renderToStaticMarkup(createElement(ProductSafetyFacts, { store, product: (await readListing(store, id))!, legal: null })), "");
  const onlyProp65 = renderToStaticMarkup(createElement(ProductSafetyFacts, { store, product: (await readListing(store, id))!, legal: { safety: null, prop65: PROP65, quantities: [] } }));
  is("only a Proposition 65 text: the heading and the text, no empty rows", [onlyProp65.includes("Product safety and manufacturer"), onlyProp65.includes("<strong>WARNING:</strong>"), onlyProp65.includes("Manufacturer<")], [true, true, false]);
  const german = renderToStaticMarkup(createElement(ProductSafetyFacts, { store: { ...store, language: "de" }, product: (await readListing(store, id))!, legal }));
  is("in the store's language", german.includes(productSafetyWords("de").heading) && german.includes(productSafetyWords("de").per.kg), true);

  const page = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
  is("the page reads the record of a shipped product only, in parallel", /activeShipping\(product\) \? readProductLegal\(store, product\.id\)\.catch\(\(\) => null\) : Promise\.resolve\(null\)/.test(page), true);
  const block = page.indexOf("<ProductSafetyFacts");
  is("the block comes before the buy button", block > 0 && block < page.indexOf("<BuyBox"), true);
  is("the buy box is told what was read, so its shipping line says the same as the checkout", /<BuyBox store=\{store\} product=\{shippedNow\}/.test(page), true);
  const box = readFileSync("components/store-product.tsx", "utf8");
  is("the shipping line under the button says where it ships now", /const shipping = shippingNow\(product\);/.test(box), true);
  const answers = readFileSync("lib/answers.ts", "utf8");
  is("the store's answers say the same", /const shipping = shippingNow\(product\);/.test(answers), true);

  part("The studio says why");
  const editor = readFileSync("components/physical-legal-editor.tsx", "utf8");
  const legalRecord = readFileSync("lib/physical-legal-record.ts", "utf8");
  is("the summary of what keeps it from the EU/EEA", editor.includes("safetySummary(product.shipping.countries, ") && legalRecord.includes("gapSummary(safetyGaps(info, hasPicture))"), true);

  // The checkout closes the EU/EEA (shippingNow above), so the studio must say so (VR 2): the creator is told
  // that buyers there can't buy, only when the closing holds for that product, from the same rule.
  const SOME_CANT = "Until these details are complete, buyers in the EU and EEA can't buy this product.";
  // Changed assertion, noted (Codex U's LEVE on lib/physical-legal-record.ts:158, 9 Nov 2026): the old sentence said
  // "because it only ships to the EU and EEA", which is false for Svalbard and Jan Mayen (SJ), closed with the area but
  // not inside it. The new one gives the reason that holds for every closed place.
  const NO_ONE = "Until these details are complete, no one can buy this product, because every place it ships to needs them.";
  const PARTLY_CANT = "Until these details are complete, buyers in Svalbard and Jan Mayen can't buy this product.";
  const BOTH_CANT = "Until these details are complete, buyers in the EU and EEA and in Svalbard and Jan Mayen can't buy this product.";
  const filledSafety = {
    manufacturer: { name: "Harbor Print Co.", postal: "1 Dock Rd", electronic: "https://harbor.example/contact", country: "DE" },
    responsible: null,
    productType: "Cookbook",
    identifier: "",
    warnings: "",
    noWarnings: true,
  };
  const shipped = (shipping: unknown, safety: typeof filledSafety | null, image: boolean) => ({
    ...parseProduct({ id: "s1", title: "Book", priceCents: 3500, shipping })!,
    legal: safety ? { safety, prop65: "", quantities: [] } : null,
    ...(image ? { image: "https://example.com/book.png" } : {}),
  });
  const said = (product: ReturnType<typeof shipped>) => safetySummary(product.shipping!.countries, product.legal?.safety ?? null, Boolean(product.image));
  const studioWorld = shipped({ cents: 600, region: "world", note: "" }, null, false);
  is("fields not filled, shipped worldwide: the checkout leaves out Germany", shippingNow(studioWorld)!.countries.includes("DE"), false);
  is("and the studio says buyers in the EU and EEA can't buy it", said(studioWorld).endsWith(` ${SOME_CANT}`), true);
  is("after the list of what is needed", said(studioWorld).startsWith("Needed before selling to buyers in the EU/EEA: "), true);
  const studioEuOnly = shipped({ cents: 600, region: "eu", note: "" }, null, true);
  is("shipped only to the EU/EEA: not sold at all", shipsNowhere(studioEuOnly), true);
  is("and the studio says no one can buy it", said(studioEuOnly).endsWith(` ${NO_ONE}`), true);
  const svalbard = shipped({ cents: 600, region: "custom", countries: ["SJ"], note: "" }, null, true);
  is("Svalbard and Jan Mayen only: closed by the checkout, so the studio says so too", [shipsNowhere(svalbard), said(svalbard).endsWith(` ${NO_ONE}`)], [true, true]);
  // Codex U's LEVE: no closing sentence may call a place outside GPSR_AREA "the EU and EEA", and the named partly-in
  // places must be exactly the codes closed outside the area, so a new one cannot be closed under the wrong name.
  is("the only code closed outside the area is SJ, the one the sentences name", SHIP_COUNTRIES.filter((code) => gpsrCloses(code) && !GPSR_AREA.includes(code)), ["SJ"]);
  is("Svalbard and Jan Mayen only: never told it ships only to the EU and EEA", said(svalbard).includes("EU and EEA."), false);
  const svalbardAndUs = shipped({ cents: 600, region: "custom", countries: ["SJ", "US"], note: "" }, null, true);
  is("Svalbard and Jan Mayen with the US: the US stays open and the studio names the place closed", [shippingNow(svalbardAndUs)!.countries, said(svalbardAndUs).endsWith(` ${PARTLY_CANT}`)], [["US"], true]);
  const svalbardGermanyUs = shipped({ cents: 600, region: "custom", countries: ["DE", "SJ", "US"], note: "" }, null, true);
  is("Germany, Svalbard and Jan Mayen and the US: both closed places are named", [shippingNow(svalbardGermanyUs)!.countries, said(svalbardGermanyUs).endsWith(` ${BOTH_CANT}`)], [["US"], true]);
  const germanyUs = shipped({ cents: 600, region: "custom", countries: ["DE", "US"], note: "" }, null, true);
  is("Germany with the US: only the EU and EEA are named", said(germanyUs).endsWith(` ${SOME_CANT}`), true);
  for (const [name, product] of [
    ["filled, shipped worldwide", shipped({ cents: 600, region: "world", note: "" }, filledSafety, true)],
    ["filled but no picture", shipped({ cents: 600, region: "world", note: "" }, filledSafety, false)],
    ["not filled, shipped to the US only", shipped({ cents: 600, region: "us", note: "" }, null, false)],
    ["not filled, shipped worldwide", studioWorld],
    ["not filled, EU/EEA only", studioEuOnly],
  ] as const) {
    const closes = shippingNow(product)!.countries.length < activeShipping(product)!.countries.length;
    // Changed assertion, noted (after the RED commit): either closing sentence counts, "no one can buy" included.
    is(`${name}: the studio says buyers can't buy exactly when the checkout closes a country`, [SOME_CANT, PARTLY_CANT, BOTH_CANT, NO_ONE].some((words) => said(product).endsWith(` ${words}`)), closes);
  }
  is("the form shows the closing in the studio's notice style, from the same rule", /safetyClosed\(product\.shipping\.countries, /.test(editor) && /notice notice-warn/.test(editor), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
