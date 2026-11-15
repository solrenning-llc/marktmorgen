/**
 * The studio's product search (lib/catalog.ts studioShelf, a store past STUDIO_PAGE_SIZE products) compared titles
 * with toLowerCase().includes, so "creme brulee" never found "Crème brûlée class", which the store page's own search
 * finds for a buyer (claude7/catalog-hunt-2, 13 November 2026). Both sides are now folded as the store search folds
 * them (searchWords: no accents, no case); a part of a word still finds it, as before. Synthetic store.
 */
import { STUDIO_PAGE_SIZE, studioShelf } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const owner = "studio-shelf@example.test";
  await claimHandle(owner, "studioshelf", "Studio Shelf", "");
  await ensureStatsId(owner);
  for (const title of ["Crème brûlée class", "Pancakes for two", "Café au lait guide"]) {
    if (!(await addProduct(owner, title, "", "9", null)).ok) throw new Error("product fixture");
  }
  for (let n = 1; n <= STUDIO_PAGE_SIZE; n++) {
    if (!(await addProduct(owner, `Bread lesson ${n}`, "", "9", null)).ok) throw new Error("product fixture");
  }
  const store = (await storeForEmail(owner))!;
  const titles = async (q: string) => (await studioShelf(store, { q })).products.map((p) => p.title);

  part("Accents and case");
  is("typed without accents", await titles("creme brulee"), ["Crème brûlée class"]);
  is("typed with other accents and in capitals", await titles("BRÛLÉE"), ["Crème brûlée class"]);
  is("an accented title found by its plain word", await titles("cafe"), ["Café au lait guide"]);
  part("As before");
  is("a part of a word still finds it", await titles("cake"), ["Pancakes for two"]);
  is("a word in no title finds nothing", await titles("sushi"), []);
  is("signs alone are looked for as typed, never as everything", await titles("!!"), []);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
