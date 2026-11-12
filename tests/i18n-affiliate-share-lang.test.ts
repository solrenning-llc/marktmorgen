/**
 * The affiliate page of a store (app/[handle]/affiliates) is drawn in the
 * store's language and marked with it (lang="de-DE" on a German store). Its
 * campaign-link panel (components/affiliate-campaign-links.tsx) speaks that
 * language, but below its own words it draws the shared share panel
 * (components/share-panel.tsx), which is written only in English ("Copy",
 * "Post it", "Link type", "For print, slides and talks"). Inside a German
 * page, that English must carry its own lang (WCAG 3.1.2), or a screen reader
 * reads it with German pronunciation.
 *
 * Synthetic: nothing is read from a store or a provider.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AffiliateCampaignLinks } from "@/components/affiliate-campaign-links";
import { LANGUAGE_CODES, LANGUAGES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const PRODUCTS = [{ id: "prod_a", title: "Brotbackkurs", url: "https://marktmorgen.com/@kueche/p/brot?via=AFF123" }];
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/** The lang in force at `index` of `html`, read from the open elements around it ("" when none says). */
function langAt(html: string, index: number): string {
  const stack: { tag: string; lang: string | null }[] = [];
  const tags = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  for (let m = tags.exec(html); m && m.index < index; m = tags.exec(html)) {
    const [, closing, name, attrs, self] = m;
    const tag = name.toLowerCase();
    if (closing) {
      const at = stack.map((s) => s.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
    } else if (!self && !VOID.has(tag)) {
      stack.push({ tag, lang: /\slang="([^"]*)"/.exec(attrs)?.[1] ?? null });
    }
  }
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].lang !== null) return stack[i].lang as string;
  return "";
}

function drawn(language: LanguageCode): string {
  // Inside the page's own mark, as on app/[handle]/affiliates.
  return renderToStaticMarkup(
    createElement("div", { lang: LANGUAGES[language].locale }, createElement(AffiliateCampaignLinks, { products: PRODUCTS, language })),
  );
}

const SHARE = '<div class="grid min-w-0';
const ENGLISH_WORDS = ["Post it", "Link type", "For print, slides and talks"];

part("The panel's own words stay in the store's language");
for (const code of LANGUAGE_CODES) {
  const html = drawn(code);
  is(`${code}: the panel's summary is marked with the page's language`, langAt(html, html.indexOf("<summary")), LANGUAGES[code].locale);
}

part("The shared, English-only share panel is marked as English on every store");
for (const code of LANGUAGE_CODES) {
  const html = drawn(code);
  const at = html.indexOf(SHARE);
  is(`${code}: the share panel is drawn, in English`, [at > 0, ENGLISH_WORDS.every((w) => html.includes(w))], [true, true]);
  is(`${code}: its English carries an English lang`, /^en\b/.test(langAt(html, at + 1)), true);
}

done();
