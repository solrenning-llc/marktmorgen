/**
 * 254 [WH3], unit 1: an honest trust line on the store page, from what the
 * store's record already says (no new read of Stripe or anything else):
 *
 *   - that Stripe has enabled the creator's own account to take card
 *     payments, only while the store can sell (lib/store-checkout.ts canSell,
 *     the same test as its Buy button), so it goes away by itself when that
 *     stops being true, and does not show while paid selling is closed;
 *   - since when the store is on Marktmorgen, from its own record.
 *
 * Words only: Stripe's Marks page (stripe.com/legal/marks, last updated June
 * 12, 2023, read 15 November 2026) allows the word mark "in text to
 * truthfully and accurately refer to us", never implying "endorsement or
 * sponsorship". So no logo, no "verified by Stripe", no seal.
 *
 * What fails here: the payments line shown when the store cannot sell; a date
 * that cannot be read turned into one; any "verified", "trusted", "top",
 * sales count, rating or picture in the line; a buyer language without it;
 * the store page not drawing it.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { trustLines } from "@/lib/store-trust";
import { trustWords } from "@/lib/buyer-words/trust";
import { StoreTrustLine } from "@/components/store-trust-line";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

part("What it says, and when");
is("selling, with a date", trustLines({ selling: true, createdAt: "2026-03-04T10:00:00.000Z", language: "en" }), ["Stripe has enabled this creator's own account to take card payments.", "On Marktmorgen since March 2026."]);
is("not selling: no payments line", trustLines({ selling: false, createdAt: "2026-03-04T10:00:00.000Z", language: "en" }), ["On Marktmorgen since March 2026."]);
is("an unreadable date: no age line", trustLines({ selling: true, createdAt: "", language: "en" }), ["Stripe has enabled this creator's own account to take card payments."]);
is("a date in another shape: no age line", trustLines({ selling: false, createdAt: "yesterday", language: "en" }), []);
is("a date in the future: no age line", trustLines({ selling: false, createdAt: "2099-01-01T00:00:00.000Z", language: "en" }, Date.parse("2026-11-15T00:00:00Z")), []);
is("the month in the store's language", trustLines({ selling: false, createdAt: "2026-03-04T10:00:00.000Z", language: "de" }), ["Seit März 2026 auf Marktmorgen."]);

part("Never more than is true");
for (const code of LANGUAGE_CODES) {
  const w = trustWords(code);
  is(`${code}: words for both lines`, [w.payments.length > 20, w.since("X").includes("X")], [true, true]);
  is(`${code}: no seal, rank, count or endorsement word`, /verif|trusted|certif|top |best|official|endors|garant|guarant|\d/i.test(`${w.payments} ${w.since("")}`), false);
}

part("On the page");
const html = renderToStaticMarkup(createElement(StoreTrustLine, { lines: ["Stripe has enabled this creator's own account to take card payments.", "On Marktmorgen since March 2026."] }));
is("plain words in a list, no picture", /<ul/.test(html) && !/<img|<svg/.test(html), true);
is("nothing drawn without lines", renderToStaticMarkup(createElement(StoreTrustLine, { lines: [] })), "");
const page = readFileSync("app/[handle]/page.tsx", "utf8");
is("the store page draws it from its own selling test", page.includes("<StoreTrustLine lines={trustLines({ selling, createdAt: store.createdAt, language: store.language })} />"), true);

done();
