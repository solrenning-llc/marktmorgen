/**
 * Products of the store in an email (546 [EB1], unit 1; added 2 November
 * 2026): the block's line, the checks before sending and the card, on
 * synthetic products only.
 */
import { MAX_MAIL_PRODUCTS, PRODUCTS_PREFIX, type CardPrice, type CardStyle, type MailProduct, blockProblems, blockWords, leavingProducts, productBlocksIn, productCardHtml, productCardText, productsLine, readProductsLine } from "@/lib/mail-product-block";
import { parseMailBlocks } from "@/lib/mail-body";
import { MAIL_SALE_MARGIN_SECONDS, type PriceFacts } from "@/lib/mail-product-price";
import { contrast, lookColours } from "@/lib/store-look";
import { done, is, part } from "./check";

// Ids as the store makes them (10 hexadecimal characters, lib/store.ts freshId) and an older one.
const A = "3f9a1c2b4d";
const B = "8e7d6c5b4a";
const C = "legacy_id-1";
const D = "0a1b2c3d4e";
const E = "5f6e7d8c9b";
const IMAGES = "https://marktmorgen.com";
const NOW = 1_800_000_000;
const facts: PriceFacts = { free: false, priceCents: 2900, fromCents: 2900, optionCount: 0, interval: null, pwyw: false, sale: null, taxOnTop: false };
const guide: MailProduct = { id: A, title: "Sourdough & Co guide", facts, picture: { url: `${IMAGES}/api/image/${"a".repeat(24)}/${"b".repeat(32)}.jpg`, alt: "The guide's cover" }, href: "https://marktmorgen.com/@ana/p/guide" };
const price: CardPrice = { store: { language: "en", currency: "usd" }, now: NOW };
const style: CardStyle = { button: { fill: "#4c1d95", on: "#ffffff" }, see: (t) => `See ${t}`, level: 3, images: IMAGES, goesTo: (href) => `${href}?ref=mail`, ...price };

part("The block's line");
is("a paragraph of its own: the prefix and 1 to 4 ids, as the store makes them", [productsLine([A, C]), readProductsLine(`  ${productsLine([A, C])}  `), readProductsLine(productsLine([A, B, C, D]))], [`@products ${A} ${C}`, [A, C], [A, B, C, D]]);
is("anything else is not a block", [readProductsLine(PRODUCTS_PREFIX), readProductsLine(productsLine([A, B, C, D, E])), readProductsLine(productsLine([A, A])), readProductsLine(`@products ${A} <b>`), readProductsLine(`@Products ${A}`), readProductsLine(`See @products ${A}`)], [null, null, null, null, null, null]);
is("every block in an email, in order, with Windows line ends too", productBlocksIn(`Hi\r\n\r\n${productsLine([A])}\r\n\r\nText\n\n${productsLine([B, C])}`), [[A], [B, C]]);
is("until it is drawn, the email's blocks read it as text, so nothing else in them changes", parseMailBlocks(productsLine([A])), [{ kind: "text", text: productsLine([A]) }]);

part("Before it goes");
const onSale = new Set([A, B]);
is("fine when each block has a product on sale here", blockProblems(`${productsLine([A, C])}\n\n${productsLine([B])}`, onSale), null);
is("a product not on sale leaves its block by itself, and the creator is told", leavingProducts(`${productsLine([A, C])}\n\n${productsLine([C, B])}`, onSale), [C]);
is("a block left with none stops the email", blockProblems(`${productsLine([A])}\n\n${productsLine([C, D])}`, onSale), { why: "empty", ids: [C, D] });
is("a line that starts like a block and is not one stops it: inside a paragraph, too many, a wrong id, the singular", [`Hi\n${productsLine([A])}`, productsLine([A, B, C, D, E]), `@products ${A} x!`, `@product ${A}`].map((body) => blockProblems(body, onSale)), Array(4).fill({ why: "malformed" }));
is(`exactly ${MAX_MAIL_PRODUCTS} is fine`, blockProblems(productsLine([A, B, C, D]), onSale), null);

part("In plain words");
const titles: Record<string, string> = { [A]: "Guide", [B]: "Planner", [C]: "Old course" };
const titleOf = (id: string) => titles[id] ?? null;
is("who leaves, with “and”, and removed ones counted", [
  blockWords({ why: "leaving", ids: [C] }, titleOf),
  blockWords({ why: "leaving", ids: [A, B, C] }, titleOf),
  blockWords({ why: "leaving", ids: [C, D, E] }, titleOf),
], [
  "“Old course” is not on sale in your store now, so it is left out of this email.",
  "“Guide”, “Planner” and “Old course” are not on sale in your store now, so they are left out of this email.",
  "“Old course” and 2 removed products are not on sale in your store now, so they are left out of this email.",
]);
is("an empty block: publish one if any is still there, else take the block out", [blockWords({ why: "empty", ids: [C] }, titleOf), blockWords({ why: "empty", ids: [D, E] }, titleOf)], [
  "None of the products in a block is on sale in your store now (“Old course”), so this email can't be sent. Publish one, or take the block out.",
  "None of the products in a block is on sale in your store now (2 removed products), so this email can't be sent. Take the block out.",
]);
is("a malformed line says how to fix it", blockWords({ why: "malformed" }, titleOf), "A line starting with @products must be a paragraph of its own with 1 to 4 of your products. Add products from the editor, or take the line out.");

part("The card");
const html = productCardHtml(guide, style);
is("its picture with the creator's description, its name as a heading, its price and a button that names it", [
  html.includes(`<img src="${guide.picture!.url}" alt="The guide's cover" width="438"`),
  html.includes("<h3 ") && html.includes(">Sourdough &amp; Co guide</h3>"),
  html.includes(">$29</p>"),
  html.includes(">See Sourdough &amp; Co guide</a>"),
], [true, true, true, true]);
is("the heading level the email needs", productCardHtml(guide, { ...style, level: 2 }).includes(">Sourdough &amp; Co guide</h2>"), true);
is("the button's words in the store's language", productCardHtml(guide, { ...style, see: (t) => `Ver ${t}` }).includes(">Ver Sourdough &amp; Co guide</a>"), true);
is("the link carries the email's tag", html.includes(`href="${guide.href}?ref=mail"`), true);
is("a picture only from the store's own image service", [productCardHtml({ ...guide, picture: { url: "https://tracker.example/p.gif", alt: "" } }, style).includes("<img"), productCardHtml({ ...guide, picture: null }, style).includes("<img")], [false, false]);
is("a page that is not an https address: no card", [productCardHtml({ ...guide, href: "javascript:alert(1)" }, style), productCardHtml({ ...guide, href: "http://x.example" }, style)], ["", ""]);
is("everything escaped", productCardHtml({ ...guide, title: "<script>\"x\"</script>", picture: { url: guide.picture!.url, alt: "\" onerror=\"x" } }, style).match(/<script|onerror="x/g), null);
const night = lookColours({ theme: "night", accent: "#4c1d95" } as Parameters<typeof lookColours>[0]);
const nightCard = productCardHtml(guide, { ...style, button: { fill: night.accent, on: night.onAccent } });
is("the store's own button pair, which keeps 7:1, even on the Night theme", [nightCard.includes(`background:${night.accent};color:${night.onAccent}`), contrast(night.accent, night.onAccent) >= 7], [true, true]);
is("colours that cannot be read: the site's own pair", productCardHtml(guide, { ...style, button: { fill: "red", on: "#fff" } }).includes("background:#4c1d95;color:#ffffff"), true);
is("no pixel, discount, countdown, stock or rating", /width="1"|height="1"|discount|ends|left in stock|stars?|rating|% off/i.test(html), false);
is("in plain text: name, price and page", productCardText(guide, price), `Sourdough & Co guide ($29): ${guide.href}`);

part("The card's price: written from the store's facts, never typed");
const priced = (f: Partial<PriceFacts>, store = price.store) => {
  const html = productCardHtml({ ...guide, facts: { ...facts, ...f } }, { ...style, store });
  return html.match(/<p style="margin:0 0 12px;color:#1c1917">([^<]*)<\/p>/)?.[1];
};
is("free, one price, a membership, options, pay what you want", [priced({ free: true }), priced({}), priced({ interval: "month", priceCents: 900, fromCents: 900 }), priced({ optionCount: 3, fromCents: 1500 }), priced({ pwyw: true, priceCents: 500 })], ["Free", "$29", "$9 a month", "from $15", "$5 or more"]);
is("tax on top is said; free stays free", [priced({ taxOnTop: true }), priced({ free: true, taxOnTop: true })], ["$29 + tax where it applies", "Free"]);
is("a sale with more than a day to go: its price and end; within a day: the regular price", [priced({ sale: { percent: 20, ends: NOW + 2 * MAIL_SALE_MARGIN_SECONDS } })?.startsWith("Sale price: $23.20, until "), priced({ sale: { percent: 20, ends: NOW + MAIL_SALE_MARGIN_SECONDS } })], [true, "$29"]);
is("in the store's language", priced({ free: true }, { language: "fr", currency: "eur" }), "Gratuit");
is("the plain text says the same price", productCardText({ ...guide, facts: { ...facts, taxOnTop: true } }, price), `Sourdough & Co guide ($29 + tax where it applies): ${guide.href}`);

done();
