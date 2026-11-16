/**
 * A collection of a store switched off after notices (lib/takedown.ts) is
 * drawn as the resting store, with a 200, and its head said only
 * "Not found — Marktmorgen": no robots line, so search engines were free to
 * keep it, while the store's front page and its products ask to be left out
 * (noindex) the moment it is switched off. Its head now asks the same.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const page = readFileSync("app/[handle]/shop/[collection]/page.tsx", "utf8");
const meta = page.slice(page.indexOf("export async function generateMetadata"), page.indexOf("export default"));

part("A switched-off store's collection");
is("asks search engines to leave it out", meta.includes('if (!found || found.store.suspended) return { title: "Not found — Marktmorgen", robots: { index: false, follow: true } };'), true);
is("as its front page and products do", [/index: !searched && !store\.suspended/.test(readFileSync("app/[handle]/page.tsx", "utf8")), readFileSync("app/[handle]/p/[product]/page.tsx", "utf8").includes("robots: { index: !store.suspended, follow: true }")], [true, true]);
done();
