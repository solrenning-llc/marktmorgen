/**
 * A store's front page names one address as its own, however the handle in
 * the address bar was written. Handles are read without regard to case
 * (normaliseHandle), so /@LocalShop draws the same page as /@localshop; with
 * the canonical left to the root layout's relative "./", that page named
 * /@LocalShop as its own and was indexable there too: one store, as many
 * addresses as spellings. The front page now names storeAddress(store), the
 * address its sitemap lists (lib/store-sitemap.ts), here or on its live domain.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const page = readFileSync("app/[handle]/page.tsx", "utf8");
const meta = page.slice(page.indexOf("export async function generateMetadata"), page.indexOf("export default async function StorePage"));

part("The front page's canonical");
is("always the store's own address, never the spelling asked for", meta.includes("alternates: { canonical: storeAddress(store) },"), true);
is("not left to the root layout's relative one only on a domain", meta.includes("...(ownDomain ? { alternates"), false);
done();
