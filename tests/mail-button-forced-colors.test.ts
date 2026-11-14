/**
 * AX274 item 5 (emails), WCAG 1.4.1 Use of Color and 1.4.11 Non-text Contrast,
 * under forced colors (Windows High Contrast, and mail apps that follow it).
 * Chromium with forced-colors active, 13 November 2026: an email's button,
 * "Get the guide", lost its filled background, as forced colors do, and having
 * no border and no underline it became a line of blue words, told apart from
 * the text around it only by its color.
 *
 * What must hold: the button carries a transparent border, invisible in normal
 * colors and drawn by forced colors, so it stays a visible box; its padding is
 * 2 px less on each side, so it keeps exactly the size it had. Its colors, its
 * words and its address are unchanged.
 */
import { bodyHtml } from "@/lib/mail-body";
import { productCardHtml, type CardStyle, type MailProduct } from "@/lib/mail-product-block";
import type { PriceFacts } from "@/lib/mail-product-price";
import { done, is, part } from "./check";

const html = bodyHtml("[Get the guide](https://example.com/guide)");
const style = html.match(/<a href="https:\/\/example\.com\/guide" style="([^"]*)">Get the guide<\/a>/)?.[1] ?? "";

part("A button stays a box under forced colors");
is("the button is drawn", style.length > 0, true);
is("it has a transparent 2 px border", /border:2px solid transparent/.test(style), true);
is("its padding is 2 px less, so its size is unchanged", /padding:10px 20px/.test(style), true);
is("it is still a filled pill with no underline in normal colors", /display:inline-block/.test(style) && /border-radius:999px/.test(style) && /text-decoration:none/.test(style) && /background:/.test(style), true);

part("A product card's button too");
const facts: PriceFacts = { free: false, priceCents: 2900, fromCents: 2900, optionCount: 0, interval: null, pwyw: false, sale: null, taxOnTop: false };
const product: MailProduct = { id: "3f9a1c2b4d", title: "Sourdough guide", facts, picture: null, href: "https://marktmorgen.com/@harbor/p/sourdough" } as unknown as MailProduct;
const cardStyle: CardStyle = { button: { fill: "#4c1d95", on: "#ffffff" }, see: (t) => `See ${t}`, level: 3, images: "https://marktmorgen.com", goesTo: (href) => href, store: { language: "en", currency: "usd" }, now: 1_800_000_000 } as CardStyle;
const card = productCardHtml(product, cardStyle).match(/<a href="[^"]*" style="([^"]*)">See Sourdough guide<\/a>/)?.[1] ?? "";
is("the card's button is drawn", card.length > 0, true);
is("it has the transparent 2 px border and the 2 px smaller padding", /border:2px solid transparent/.test(card) && /padding:10px 20px/.test(card), true);

done();
