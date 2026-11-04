/**
 * "What buyers say" on the store page (lib/store-quotes.ts, added 9 October
 * 2026): the newest reviews with words, kept on the store's record. Checked:
 *
 *   - the newest first, at most three, each with its product's title;
 *   - never a hidden review, never a refunded one, never one with too few words;
 *   - nothing chosen by its stars: a newer three-star review comes before an
 *     older five-star one;
 *   - kept again after a change, and long words cut at a word.
 */
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { markOneRefunded, saveReview, setHidden } from "@/lib/reviews";
import { refreshStoreQuotes } from "@/lib/store-quotes";
import { QUOTE_CHARS, parseQuotes, quoteText } from "@/lib/store-quotes-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

async function main(): Promise<void> {
  redis.clear();
  const owner = "quotes@example.com";
  await claimHandle(owner, "quoteshop", "Quote Shop", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  const a = await addProduct(owner, "Bread Book", "", "19", null);
  const b = await addProduct(owner, "Cake Course", "", "49", null);
  if (!a.ok || !b.ok) throw new Error("no products");
  const day = 86_400_000;
  const base = Date.now() - 20 * day;
  const review = async (n: number, product: string, rating: number, text: string) => {
    const saved = await saveReview(statsId, { productId: product, email: `r${n}@example.com`, reference: `cs_test_q${n}`, pi: `pi_q${n}`, rating, text, name: `Reader ${n}` }, ROOM, base + n * day);
    if (saved.state !== "created") throw new Error(`review ${n}: ${saved.state}`);
    return saved.review.id;
  };
  await review(1, a.product.id, 5, "The rye loaf alone was worth every cent of it.");
  await review(2, b.product.id, 3, "Good lessons, though the sponge took me three tries.");
  const short = await review(3, a.product.id, 5, "Great!");
  const hidden = await review(4, b.product.id, 1, "I did not like the way the videos were filmed at all.");
  const refunded = await review(5, a.product.id, 4, "Clear steps and a friendly tone all the way through.");
  await setHidden(statsId, b.product.id, hidden, true, "unrelated");
  await markOneRefunded(statsId, a.product.id, refunded);
  void short;

  part("The newest with words, never hidden, refunded or too short");
  await refreshStoreQuotes((await storeForEmail(owner))!);
  let store = (await storeForEmail(owner))!;
  is("two, newest first, with stars, words, names and titles", store.quotes.map((q) => [q.ti, q.r, q.t, q.n]), [
    ["Cake Course", 3, "Good lessons, though the sponge took me three tries.", "Reader 2"],
    ["Bread Book", 5, "The rye loaf alone was worth every cent of it.", "Reader 1"],
  ]);

  part("Kept again after a change");
  await review(6, b.product.id, 5, "My family asks for the lemon cake every single week now.");
  await refreshStoreQuotes(store);
  store = (await storeForEmail(owner))!;
  is("the new one leads, three at most", [store.quotes.length, store.quotes[0].n], [3, "Reader 6"]);

  part("Words and kept lists made safe");
  const long = quoteText(`${"word ".repeat(100)}end`);
  is("long words cut at a word, with a mark", [long.length <= QUOTE_CHARS + 1, long.endsWith("word…")], [true, true]);
  is("a kept list with nonsense in it", parseQuotes([{ p: "x", r: 9, t: "a" }, { p: "y", r: 4, t: "fine", ti: "T" }, "z"]).map((q) => [q.p, q.r]), [["y", 4]]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
