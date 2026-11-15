/**
 * Searching a long store's products (lib/catalog.ts, searchStore; added 9
 * October 2026). Checked: every word must be in the title or the one-line
 * summary, as the start of a word, whatever its case or accents; drafts are
 * never found; results keep the creator's order and stop at two pages'
 * worth, with how many there were in all.
 */
import { addProduct, claimHandle, ensureStatsId, setProductHidden, storeForEmail } from "@/lib/store";
import { STORE_SEARCH_LIMIT, matchesSearch, searchStore, searchWords } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  part("Words");
  is("no accents, no case, letters and digits", searchWords("Crème Brûlée, 2 ways!"), ["creme", "brulee", "2", "ways"]);
  is("every word, at the start of a word", [
    matchesSearch({ title: "Sourdough Bread Book", summary: "" }, "bread sour"),
    matchesSearch({ title: "Sourdough Bread Book", summary: "Loaves for beginners" }, "beginner loaf"),
    matchesSearch({ title: "Crème brûlée class", summary: "" }, "CREME"),
    matchesSearch({ title: "Pancakes", summary: "" }, "cake"),
    matchesSearch({ title: "Pancakes", summary: "" }, "   "),
  ], [true, false, true, false, false]);
  is("an apostrophe or a hyphen in a title never hides it from the words typed without them, nor with them", [
    matchesSearch({ title: "Beginner’s Guide to Bread", summary: "" }, "beginners guide"),
    matchesSearch({ title: "Mom's Recipes", summary: "" }, "moms"),
    matchesSearch({ title: "Mom's Recipes", summary: "" }, "mom’s recipes"),
    matchesSearch({ title: "The E-book Pack", summary: "" }, "ebook"),
    matchesSearch({ title: "The E-book Pack", summary: "" }, "e-book"),
    matchesSearch({ title: "The Ebook Pack", summary: "" }, "e-book"),
    matchesSearch({ title: "Straße Photos", summary: "" }, "strasse"),
    matchesSearch({ title: "Łódź walking tour", summary: "" }, "lodz"),
    matchesSearch({ title: "Mom's Recipes", summary: "" }, "dad"),
  ], [true, true, true, true, true, true, true, true, false]);

  part("A store's products");
  const owner = "search@example.com";
  await claimHandle(owner, "searchshop", "Search Shop", "");
  await ensureStatsId(owner);
  const ids: string[] = [];
  for (let n = 1; n <= STORE_SEARCH_LIMIT + 5; n++) {
    const made = await addProduct(owner, n % 2 ? `Bread lesson ${n}` : `Cake lesson ${n}`, n === 4 ? "With chocolate" : "", "9", null);
    if (!made.ok) throw new Error("no product");
    ids.push(made.product.id);
  }
  await setProductHidden(owner, ids[2], true);
  const store = (await storeForEmail(owner))!;
  const choc = await searchStore(store, "chocolate cake");
  is("the one with both words", [choc.total, choc.listings.map((l) => l.title)], [1, ["Cake lesson 4"]]);
  const bread = await searchStore(store, "bread");
  is("a draft is never found", bread.listings.some((l) => l.id === ids[2]), false);
  const all = await searchStore(store, "lesson");
  is("in the creator's order, two pages at most, with the count in all", [all.listings.length, all.total, all.listings[0].title], [STORE_SEARCH_LIMIT, STORE_SEARCH_LIMIT + 4, "Bread lesson 1"]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
