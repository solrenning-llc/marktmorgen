/**
 * R36 (audit finding 5, synthetic): around every page of a store
 * (app/[handle]/layout.tsx), what the layout itself draws speaks the store's
 * language (lib/store-language.ts) and is marked with it (WCAG 3.1.1/3.1.2,
 * AX274: `lang` on each passage in another language). The root <html> is
 * lang="en-US", so a passage outside the page's own lang region needs its own.
 *
 * - the skip link, the first thing a keyboard reaches, says the store's words
 *   and carries the store's lang, in each of the 7 languages;
 * - the store chat and the Store assistant drawn around the page carry it too;
 * - the order (skip link, page, chat), the link's target and its classes, and
 *   the shared SkipLink everywhere else, stay as they were.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StoreLayout from "@/app/[handle]/layout";
import { SkipLink } from "@/components/skip-link";
import { LANGUAGE_CODES, LANGUAGES } from "@/lib/store-language";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setAssistant, setAssistantPlan, setInboxSetting, setLanguage, setSubscription, storeForEmail } from "@/lib/store";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SKIP_CLASSES =
  "sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[60] focus:rounded-[10px] focus:bg-white focus:px-4 focus:py-2.5 focus:font-semibold focus:text-violet-deep focus:shadow-lg";

/** The words a buyer of a store in each language should meet on the skip link. */
const SKIP_WORDS: Record<(typeof LANGUAGE_CODES)[number], string> = {
  en: "Skip to the page content",
  es: "Saltar al contenido de la página",
  fr: "Aller au contenu de la page",
  de: "Zum Seiteninhalt springen",
  it: "Vai al contenuto della pagina",
  nl: "Ga naar de inhoud van de pagina",
  pt: "Saltar para o conteúdo da página",
};

const OWNER = "owner@example.com";
const PAGE = '<div id="page">PAGE</div>';

async function draw(): Promise<string> {
  const store = (await storeForEmail(OWNER))!;
  answering(new Request(`https://marktmorgen.com/@${store.handle}`));
  try {
    const node = await StoreLayout({ children: createElement("div", { id: "page" }, "PAGE"), params: Promise.resolve({ handle: `@${store.handle}` }) } as never);
    return renderToStaticMarkup(node as React.ReactElement);
  } finally {
    answering(null);
  }
}

/** The opening tag of the nearest store-themed wrapper before `marker`'s first match, whatever its attributes' order. */
function wrapperOf(html: string, marker: RegExp): string {
  const at = html.search(marker);
  if (at < 0) return "";
  const tags = html.slice(0, at).match(/<div\b[^>]*>/g) ?? [];
  return tags.filter((tag) => /\bclass="st-theme-/.test(tag)).at(-1) ?? "";
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "langues", "Langues Lab", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_R36Layout0001", subscriptionId: "sub_R36Layout0001", active: true, period: paidPeriod() });
  let store = (await storeForEmail(OWNER))!;
  await setInboxSetting(OWNER, { ...store.inbox, chat: true });

  part("The skip link and the chat, in each language a store can speak");
  for (const code of LANGUAGE_CODES) {
    await setLanguage(OWNER, code);
    const locale = LANGUAGES[code].locale;
    const html = await draw();
    const link = html.match(/<a href="#content"[^>]*>([^<]*)<\/a>/);
    is(`${code}: the skip link says the store's words`, link?.[1], SKIP_WORDS[code]);
    is(`${code}: the skip link is marked with the store's language`, link ? new RegExp(`\\blang="${locale}"`).test(link[0]) : "no link", true);
    is(`${code}: the skip link keeps its target and its classes`, link ? link[0].includes(`class="${SKIP_CLASSES}"`) : "no link", true);
    is(`${code}: control: the chat is drawn inside the store's themed wrapper`, wrapperOf(html, /class="st-chat /) !== "", true);
    is(`${code}: the chat's wrapper is marked with the store's language`, new RegExp(`\\blang="${locale}"`).test(wrapperOf(html, /class="st-chat /)), true);
    const order = [html.indexOf('href="#content"'), html.indexOf(PAGE), html.search(/<div\b[^>]*\bclass="st-theme-/)];
    is(`${code}: skip link, page, then chat, in that order`, order.every((n) => n >= 0) && order[0] < order[1] && order[1] < order[2], true);
  }

  part("The Store assistant, where it is on and paid for, in French");
  await setLanguage(OWNER, "fr");
  await setAssistant(OWNER, { on: true, notes: "Every file is a PDF." });
  await setAssistantPlan(OWNER, { subscriptionId: "sub_R36Layout0002", active: true, period: paidPeriod(), cancelsAtEnd: false, disputedAt: "" });
  store = (await storeForEmail(OWNER))!;
  const withAssistant = await draw();
  is("control: the assistant is drawn, not the chat", /data-store-assistant/.test(withAssistant) && (withAssistant.match(/class="st-chat /g) ?? []).length === 1, true);
  is("control: the assistant is drawn inside the store's themed wrapper", wrapperOf(withAssistant, /data-store-assistant/) !== "", true);
  is("the assistant's wrapper is marked with the store's language", /\blang="fr-FR"/.test(wrapperOf(withAssistant, /data-store-assistant/)), true);
  is("the skip link is in French there too", /<a href="#content"[^>]*\blang="fr-FR"[^>]*>Aller au contenu de la page<\/a>/.test(withAssistant), true);

  part("The shared skip link everywhere else is unchanged");
  is(
    "SkipLink with no label draws exactly what it drew before",
    renderToStaticMarkup(createElement(SkipLink)),
    `<a href="#content" class="${SKIP_CLASSES}">Skip to the page content</a>`,
  );

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
