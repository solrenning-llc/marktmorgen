import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StoreNotFound, { generateMetadata } from "../app/[handle]/not-found";
import { LANGUAGES, LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";
import { fixture, resetFixture } from "./store-not-found-title-runtime-world";

const titles = { en: "This page isn't here", es: "Esta página no está aquí", fr: "Cette page n'est pas ici", de: "Diese Seite gibt es hier nicht", it: "Questa pagina non è qui", nl: "Deze pagina is er niet", pt: "Esta página não está aqui" };
const escaped = (s: string) => renderToStaticMarkup(createElement("span", null, s)).replace(/^<span>|<\/span>$/g, "");
async function main() {
  part("Real route metadata and React static markup use the seven actual dictionaries");
  for (const code of LANGUAGE_CODES) {
    resetFixture();
    fixture.store = { name: "Sample Store", handle: "sample", language: code, currency: "USD", suspended: false, look: { theme: "light" } };
    const meta = await generateMetadata();
    const html = renderToStaticMarkup(await StoreNotFound());
    is(`${code}: exact generated tab title`, meta.title, `${titles[code]} — Sample Store`);
    is(`${code}: real heading and wrapper language`, [html.match(/<h1[^>]*>(.*?)<\/h1>/)?.[1], html.includes(`lang="${LANGUAGES[code].locale}"`)], [escaped(titles[code]), true]);
    is(`${code}: metadata robots preserved`, meta.robots, { index: false, follow: true });
  }
  for (const mode of ["missing", "suspended", "error", "no-header"]) {
    resetFixture();
    if (mode === "suspended") fixture.store = { name: "Private Store", handle: "sample", language: "pt", currency: "USD", suspended: true, look: { theme: "light" } };
    if (mode === "error") fixture.failure = true;
    if (mode === "no-header") fixture.asked = "";
    is(`${mode}: site fallback tab`, (await generateMetadata()).title, "Not here — Marktmorgen");
    is(`${mode}: site fallback component`, renderToStaticMarkup(await StoreNotFound()), "<p>Site fallback</p>");
    is(`${mode}: fallback robots`, (await generateMetadata()).robots, { index: false, follow: true });
    if (mode === "no-header") is("no header performs no store read", fixture.reads, 0);
  }
  done();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
