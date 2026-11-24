/**
 * Claude 5's LEVE on #2850 (6913591698), #5285 row #2850: tests/eu-search-order
 * draws the store page for a store whose products sit in its own record
 * (listingsToRead = 0), so the search there never goes through the index kept
 * in Redis (lib/store-search-index.ts readIndex/buildIndex), the path a large
 * store takes. The page's line "results come in the creator's own order" was
 * true there by reading the code, but a change of order only on that path
 * would not have failed a test. Held here, on that path: the results drawn on
 * the store page follow the creator's order, on the search that builds the
 * index and on the next one that reads it, also after the creator moves a
 * product to the top.
 */
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import StorePage from "@/app/[handle]/page";
import { BLOCK_WORDS } from "@/lib/buyer-words/blocks";
import { STORE_PAGE_SIZE, STORE_SEARCH_LIMIT } from "@/lib/catalog";
import { listingsToRead } from "@/lib/catalog-read-count";
import { productSegment } from "@/lib/product-slug";
import { searchIndexKey } from "@/lib/store-search-index";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, moveProduct, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "order-indexed@example.com";
const HANDLE = "kilnlarge";
const NAME = "Kiln Large";

async function searchPage(q: string): Promise<string> {
  answering(new NextRequest(`https://marktmorgen.com/@${HANDLE}?q=${encodeURIComponent(q)}`, { headers: { "x-forwarded-for": "203.0.113.8" } }));
  const node = await StorePage({ params: Promise.resolve({ handle: `@${HANDLE}` }), searchParams: Promise.resolve({ q }) });
  const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return (await new Response(stream).text()).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_search_order_indexed_stand_in";
  redis.clear();
  await claimHandle(OWNER, HANDLE, NAME, "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_orderidx01", subscriptionId: "sub_orderidx01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  // Enough products that the catalog leaves the store record (the large-store path), titles out of A-Z order.
  const count = STORE_PAGE_SIZE + 60;
  const titles = new Map<string, string>();
  for (let n = 0; n < count; n += 1) {
    const title = `Glaze ${String.fromCharCode(90 - (n % 26))}${n}`;
    const made = await addProduct(OWNER, title, "", "20", null);
    if (!made.ok) throw new Error(`no product: ${title}`);
    titles.set(made.product.id, title);
  }
  const hrefOf = (id: string) => `/@${HANDLE}/p/${productSegment({ id, title: titles.get(id) ?? "" })}"`;
  const drawnOrder = (html: string, ids: string[]) => ids.filter((id) => html.includes(hrefOf(id))).sort((a, b) => html.indexOf(hrefOf(a)) - html.indexOf(hrefOf(b)));

  part("Control: this store takes the indexed path");
  let store = (await storeForEmail(OWNER)) as Store;
  is("its catalog is not in its own record", listingsToRead(store) > 0, true);

  const check = async (label: string) => {
    store = (await storeForEmail(OWNER)) as Store;
    const creatorOrder = store.catalog.items.map((item) => item.id);
    const html = await searchPage("glaze");
    is(`${label}: the search answered with matches`, html.includes(BLOCK_WORDS.en.searchFound(count, "glaze")), true);
    const drawn = drawnOrder(html, creatorOrder);
    is(`${label}: as many drawn as the search shows`, drawn.length, Math.min(count, STORE_SEARCH_LIMIT));
    is(`${label}: drawn in the creator's own order, from the first`, drawn, creatorOrder.slice(0, drawn.length));
    is(`${label}: the order line is shown`, html.includes(BLOCK_WORDS.en.searchOrder(NAME)), true);
  };

  part("The search that builds the index");
  await check("built");
  is("the index is kept in Redis", redis.run(["EXISTS", searchIndexKey(store)]), 1);

  part("The next search, which reads the kept index");
  await check("kept");

  part("After the creator moves the last product to the top");
  const last = store.catalog.items[store.catalog.items.length - 1].id;
  is("control: the move is saved", (await moveProduct(OWNER, last, "top")).ok, true);
  await check("moved");
  is("the moved product is drawn first", drawnOrder(await searchPage("glaze"), ((await storeForEmail(OWNER)) as Store).catalog.items.map((i) => i.id))[0], last);

  answering(null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
