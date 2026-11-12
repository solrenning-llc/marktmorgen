/**
 * A store switched off after notices (lib/takedown.ts) keeps its collection
 * pages out of search engines, as its front page and products already do
 * (issue #4128). The page answers 200 with the resting page, so without a
 * robots line it stayed indexable. Synthetic store, no network.
 */
import { generateMetadata } from "@/app/[handle]/shop/[collection]/page";
import { addProduct, claimHandle, ensureStatsId, noteTakedown, setCollections, storeForEmail, type Store } from "@/lib/store";
import { collectionSegment } from "@/lib/store-collections";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "collection-robots@example.test";

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "robotshop", "Robot Shop", "Synthetic store.");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  const added = await addProduct(OWNER, "Fictional guide", "", "9", null);
  if (!added.ok) throw new Error("no product");
  const saved = await setCollections(OWNER, [{ title: "Guides", products: [added.product.id] }]);
  if (!saved.ok) throw new Error("no collection");
  const collection = ((await storeForEmail(OWNER)) as Store).collections![0];
  const params = { params: Promise.resolve({ handle: "@robotshop", collection: collectionSegment(collection) }) };

  part("a live store's collection with a published product is indexable");
  is("live: robots", (await generateMetadata(params)).robots, { index: true, follow: true });

  part("a switched-off store's collection is not");
  await noteTakedown(OWNER, null, true);
  const off = await generateMetadata(params);
  is("suspended: robots noindex, follow", off.robots, { index: false, follow: true });
  is("suspended: title unchanged", off.title, "Not found — Marktmorgen");

  done();
}

void main();
