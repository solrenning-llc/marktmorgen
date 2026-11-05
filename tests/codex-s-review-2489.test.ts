import { saveReview, visibleReviews, deleteReview, readReview } from "@/lib/reviews";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is } from "./check";

/** Independent real-store invariant: deleting a different fixture cannot turn a rewrite into a new review. */
async function main() {
  const words = ["Clear steps", "Clear steps, nice photos", "Nice photos", "Clear and short", "Short and clear", "Nice photos again"];
  for (let order = 0; order < 24; order += 1) {
    redis.clear();
    const stats = order.toString(16).padStart(32, "a");
    const product = "glaze001";
    const start = Date.UTC(2026, 10, 4, 12);
    const input = (i: number, text: string) => ({ productId: product, email: `glaze${i}@example.com`, reference: `cs_test_glz${i}0000000000`, pi: `pi_glz${i}`, rating: 5, text, name: `Glazer ${i}` });
    let rewrittenId = "";
    for (let i = 0; i < words.length; i += 1) {
      // The intended rewrite moves through all six rank positions, with tied and untied dates.
      const offset = order < 6 ? (i === 1 ? 100 : i) : ((i + order) % 6) * (order % 3);
      const result = await saveReview(stats, input(i, words[i]), ROOM, start + offset);
      if (i === 1 && (result.state === "created" || result.state === "updated")) rewrittenId = result.review.id;
    }
    const before = await readReview(stats, product, rewrittenId);
    const rows = await visibleReviews(stats, product, 0, 10);
    const deleted = rows.find(row => row.reference === "cs_test_glz00000000000");
    if (!deleted) throw new Error("Independent fixture lost its deletion target");
    is("different review is deleted " + order, await deleteReview(stats, product, deleted.id, ROOM), "deleted");
    is("rewrite target still exists " + order, (await readReview(stats, product, rewrittenId))?.text, words[1]);
    const changed = await saveReview(stats, input(1, "Clear steps, I changed my words"), ROOM, start + 1000);
    is("the real rewrite updates rather than creates " + order, changed.state, "updated");
    is("identity and creation time stay original " + order, changed.state === "updated" ? [changed.review.id, changed.review.createdAt] : null, [rewrittenId, before?.createdAt]);
  }
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
