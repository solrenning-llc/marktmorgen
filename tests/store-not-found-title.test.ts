import { readFileSync } from "node:fs";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
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

const page = readFileSync("app/[handle]/not-found.tsx", "utf8");
is("the not-found route computes metadata for the known store", page.includes("export async function generateMetadata"), true);
is("the tab title uses the localized missing-page phrase and store name", page.includes("`${w.missingTitle} — ${store.name}`"), true);
is("metadata and page share one request-cached store loader", [page.includes("cache(async () =>"), page.match(/await loadStore\(\)/g)?.length], [true, 2]);
is("the unknown-store fallback remains the site-wide English title", page.includes('title: "Not here — Marktmorgen"'), true);
done();
