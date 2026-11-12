/**
 * Hunt: MAX_DRAFTS is a bound on what a store keeps. A new draft is counted (HLEN) and written (HSET) in two
 * separate round trips with no lock, so two new drafts saved at once at 19 both pass the count and 21 are kept.
 */
import { MAX_DRAFTS, saveDraft } from "@/lib/mail-drafts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
async function main() {
  redis.clear();
  const store = { listId: "hunt3-cap", catalog: { items: [] } } as unknown as Store;
  for (let i = 0; i < MAX_DRAFTS - 1; i += 1) {
    const r = await saveDraft(store, "editor@example.com", { subject: `S${i}`, body: "B", productId: "" });
    if (!r.ok) throw new Error("fixture");
  }
  const results = await Promise.all([1, 2].map((i) => saveDraft(store, `editor${i}@example.com`, { subject: `Race ${i}`, body: "B", productId: "" })));
  const kept = (await redis.pipeline([["HLEN", "nl:mail:drafts:" + store.listId]]))[0];
  // At most one of them is saved (both may be refused as full when they race, never both kept), and the cap holds.
  is("two simultaneous new drafts are never both saved at the cap", results.filter((r) => r.ok).length <= 1, true);
  is(`the store keeps at most ${MAX_DRAFTS} drafts`, kept <= MAX_DRAFTS, true);
  is("each refused save says the drafts are full and leaves nothing", results.every((r) => r.ok || r.reason === "full") && kept === 19 + results.filter((r) => r.ok).length, true);
  done();
}
main();
