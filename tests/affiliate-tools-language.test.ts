/**
 * The affiliate's own tools on the store's affiliate page
 * (app/[handle]/affiliates), the campaign-link panel
 * (components/affiliate-campaign-links.tsx) and the commission table by
 * campaign and post (components/affiliate-promotion-results.tsx), speak the
 * store's language (lib/store-language.ts), as the rest of that page does:
 * every word, the share text's disclosure, and each count and amount written
 * that language's way. The amounts themselves never change.
 *
 * Synthetic: nothing is read from a store or a provider.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AffiliateCampaignLinks } from "@/components/affiliate-campaign-links";
import { AffiliatePromotionResults } from "@/components/affiliate-promotion-results";
import type { Book } from "@/lib/affiliates";
import { formatMoney } from "@/lib/money";
import { LANGUAGE_CODES, LANGUAGES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const PRODUCTS = [{ id: "prod_a", title: "Brotbackkurs", url: "https://marktmorgen.com/@kueche/p/brot?via=AFF123" }];

/** 1,234 paid records in euros, one of them earning €12.50, none with a campaign label. */
const LINES = Array.from({ length: 1234 }, (_, i) => ({ ref: `in_${i}`, currency: "eur", how: "click", self: false, base: 1000, commission: i === 0 ? 1250 : 0, promotion: null }));
const book = (complete: boolean) => ({ refundsChecked: complete, invoicesChecked: true, lines: complete ? LINES : [], rows: [], payouts: [], currency: "eur", elsewhere: 0 }) as unknown as Book;

const visible = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();
const spaces = (text: string) => text.replace(/[  ]/g, " ");

// The props are spread from a plain object so the test runs against either shape of the components.
function panel(language?: LanguageCode): string {
  return renderToStaticMarkup(createElement(AffiliateCampaignLinks as never, { products: PRODUCTS, ...(language ? { language } : {}) } as never));
}
function results(complete: boolean, language?: LanguageCode): string {
  return renderToStaticMarkup(createElement(AffiliatePromotionResults as never, { book: book(complete), ...(language ? { language } : {}) } as never));
}
/** The panel's own words, before the shared share panel (components/share-panel.tsx) it draws below them. */
const ownPart = (html: string) => html.split('<div class="grid min-w-0')[0]!;
/** The text a network's share box is handed (the X link carries it as `text`). */
function shareText(html: string): string {
  const href = html.match(/href="(https:\/\/x\.com\/intent\/post\?[^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  return href ? new URL(href).searchParams.get("text") ?? "" : "";
}
const cells = (html: string) => (html.match(/<td[^>]*>.*?<\/td>/g) ?? []).map(visible);
const heads = (html: string) => (html.match(/<th[^>]*>.*?<\/th>/g) ?? []).map(visible);

/** English words a German panel or table must not carry. */
const ENGLISH = /\b(the|your|you|with|this|that|and|of|for|from|link|Create|Product|Campaign|Commission|Channel|Unlabell?ed|Showing|records)\b/;

function main(): void {
  part("English stays as it was (control)");
  const enPanel = panel("en");
  const enResults = results(true, "en");
  is("the panel's summary and label", [visible(ownPart(enPanel)).startsWith("Create a link for a product, post or ad"), /Product/.test(visible(ownPart(enPanel)))], [true, true]);
  is("the share text keeps its exact disclosure", shareText(enPanel), "Brotbackkurs. Affiliate link: I earn a commission if you buy through it.");
  is("the table's figures, the American way", cells(enResults), ["Unlabeled", "Unlabeled", "Unlabeled", "1,234", "€12.50 EUR"]);
  is("the table's headings", heads(enResults), ["Channel", "Campaign", "Post / variant", "Paid records", "Commission"]);
  is("a store with no language set reads English", [visible(ownPart(panel())), cells(results(true))], [visible(ownPart(enPanel)), cells(enResults)]);
  is("the waiting note", visible(results(false, "en")), "Your posts and campaign links Campaign earnings wait until the invoice and refund readings are complete.");

  part("A German store");
  const dePanel = panel("de");
  const deResults = results(true, "de");
  const deWaiting = results(false, "de");
  is("the panel is in German, with no English left", [visible(ownPart(dePanel)).startsWith("Einen Link für ein Produkt"), ENGLISH.test(visible(ownPart(dePanel)))], [true, false]);
  is("the share text's disclosure is in German, with the same meaning", shareText(dePanel), "Brotbackkurs. Affiliate-Link: Ich erhalte eine Provision, wenn über diesen Link gekauft wird.");
  is("the waiting note is in German", [ENGLISH.test(visible(deWaiting)), /Kampagne/.test(visible(deWaiting))], [false, true]);
  is("the table's headings are in German", heads(deResults), ["Kanal", "Kampagne", "Beitrag / Variante", "Bezahlte Einträge", "Provision"]);
  is("its figures are written the German way (1.234, 12,50 €), the amount unchanged", cells(deResults).map(spaces), ["Ohne Bezeichnung", "Ohne Bezeichnung", "Ohne Bezeichnung", "1.234", "12,50 € EUR"]);
  is("nothing around the table is in English", ENGLISH.test(visible(deResults)), false);

  part("Every language of the store");
  const enOwn = visible(ownPart(enPanel));
  const enShare = shareText(enPanel);
  const enText = visible(enResults);
  for (const code of LANGUAGE_CODES) {
    if (code === "en") continue;
    const { locale, english } = LANGUAGES[code];
    const own = visible(ownPart(panel(code)));
    const share = shareText(panel(code));
    const table = results(true, code);
    is(`${english}: the panel's words are not the English ones`, [own === enOwn, own.includes("Create a link"), share.startsWith("Brotbackkurs. "), share === enShare], [false, false, true, false]);
    is(`${english}: the count and the amount are written the ${locale} way`, cells(table).slice(3).map(spaces), [(1234).toLocaleString(locale), `${formatMoney(1250, "eur", locale)} EUR`].map(spaces));
    is(`${english}: the table's words are not the English ones`, [visible(table) === enText, /Paid records|Unlabell?ed|Showing \d/.test(visible(table))], [false, false]);
  }

  done();
}

main();
