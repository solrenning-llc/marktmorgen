import { readFileSync } from "node:fs";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { generateMetadata } from "@/app/[handle]/not-found";
import { claimHandle, setLanguage } from "@/lib/store";
import { answering } from "./security/next-headers";
import { done, is, part } from "./check";

const TITLES: Record<LanguageCode, string> = {
  en: "This page isn't here",
  es: "Esta página no está aquí",
  fr: "Cette page n'est pas ici",
  de: "Diese Seite gibt es hier nicht",
  it: "Questa pagina non è qui",
  nl: "Deze pagina is er niet",
  pt: "Esta página não está aqui",
};

part("A known store's not-found tab uses the same localized title as its page");
for (const code of LANGUAGE_CODES) {
  is(`${code}: localized missing-page title`, wordsIn(code).missingTitle, TITLES[code]);
}

// The route's own generateMetadata, run for a known store in each language and for an unknown one, rather than its
// source read as text (LEVE on #2643, board #5285). The request's store comes from the proxy's header, as in Next.
part("The not-found tab title, from the route's own generateMetadata");
const OWNER = "not-found-title@example.test";
const ask = (store: string) => answering(new Request("https://marktmorgen.com/@x/gone", { headers: store ? { "x-nimbus-store": store } : {} }));
async function main(): Promise<void> {
  await claimHandle(OWNER, "goneshop", "Gone Shop", "");
  for (const code of LANGUAGE_CODES) {
    await setLanguage(OWNER, code);
    ask("@goneshop");
    const meta = await generateMetadata();
    is(`${code}: the tab is the localized phrase and the store's name`, meta.title, `${TITLES[code]} — Gone Shop`);
    is(`${code}: the page is not indexed`, meta.robots, { index: false, follow: true });
  }
  ask("@nosuchshop");
  is("an unknown store keeps the site-wide English title", (await generateMetadata()).title, "Not here — Marktmorgen");
  ask("");
  is("no store asked keeps the site-wide English title", (await generateMetadata()).title, "Not here — Marktmorgen");
  answering(null);
  const page = readFileSync("app/[handle]/not-found.tsx", "utf8");
  is("metadata and page share one request-cached store loader", [page.includes("cache(async () =>"), page.match(/await loadStore\(\)/g)?.length], [true, 2]);
  done();
}

void main();
