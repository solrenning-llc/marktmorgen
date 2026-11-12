/**
 * A search on the store page (app/[handle]/page.tsx, lib/catalog.ts
 * searchStore) pays for the listings it reads before it reads them.
 *
 * A search reads the listing of every visible product the store record does
 * not carry: up to MAX_PRODUCTS (2,000) GETs and their records for one
 * visitor's query. It took one public request (withinStore "store-search"),
 * priced as a later page (tests/traffic-cost.ts: 10 + 8 commands), so a
 * stranger's 30 searches every ten minutes (the per-connection limit) on a
 * store of 2,000 products made it read about 60,000 listings for 30 requests
 * of its window. The other public reads that grow with the store (the store's
 * map, an affiliate's page: lib/public-read-rules.ts) take one more request
 * for each PUBLIC_LISTINGS_PER_UNIT listings, before reading; the search now
 * does the same, and a search the window refuses reads none.
 *
 * Synthetic store; in-memory Redis; no network.
 */
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import StorePage from "@/app/[handle]/page";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { STORE_PAGE_SIZE } from "@/lib/catalog";
import { listingsToRead } from "@/lib/catalog-read-count";
import { PUBLIC_LISTINGS_PER_UNIT, listingUnits } from "@/lib/public-read-rules";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { answering } from "./security/next-headers";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let listingReads = 0;
redis.pipeline = (async (batch: Command[]) => {
  listingReads += batch.filter((c) => c[0] === "GET" && /^nl:catalog:.*:l:/.test(String(c[1]))).length;
  return real(batch);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {
  throw new Error("No external provider in this test");
}) as typeof fetch;

const HANDLE = "costsearch";
const EXTRA = 100;

/** Every public request the store's windows have counted so far. */
function requestsTaken(): number {
  return redis
    .keys()
    .filter((key) => key.startsWith("nl:traffic:r:"))
    .reduce((sum, key) => sum + Number(redis.run(["GET", key]) ?? 0), 0);
}

/** Draws the store page for `query` and says what it took and read. */
async function draw(query: Record<string, string>): Promise<{ taken: number; read: number; html: string }> {
  const before = requestsTaken();
  listingReads = 0;
  const search = new URLSearchParams(query).toString();
  answering(new NextRequest(`https://marktmorgen.com/@${HANDLE}${search ? `?${search}` : ""}`));
  const element = await StorePage({ params: Promise.resolve({ handle: `@${HANDLE}` }), searchParams: Promise.resolve(query) } as never);
  const stream = await renderToReadableStream(element as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  const html = await new Response(stream).text();
  return { taken: requestsTaken() - before, read: listingReads, html };
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_cost_store_search_stand_in";
  redis.clear();
  const owner = "cost-store-search@example.test";
  await claimHandle(owner, HANDLE, "Cost Search", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_CostSearch01", subscriptionId: "sub_CostSearch01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  for (let n = 1; n <= STORE_PAGE_SIZE + EXTRA; n += 1) {
    const made = await addProduct(owner, `Lesson ${n}`, "A synthetic lesson.", "9", null);
    if (!made.ok) throw new Error(`no product ${n}`);
  }
  const store = (await storeForEmail(owner))!;
  const toRead = listingsToRead(store);
  is(`the store record carries the first page; ${toRead} listings are read from their own records`, toRead >= EXTRA, true);

  part("A page of the store, without a search");
  const plain = await draw({});
  is("the first page reads no listing", plain.read, 0);

  part("A search");
  const searched = await draw({ q: "lesson" });
  is("it read every listing the record does not carry", searched.read, toRead);
  is("and found them", searched.html.includes(`Lesson ${STORE_PAGE_SIZE + 1}`), true);
  const extra = searched.taken - plain.taken;
  is(
    `it took the search's own request and one for each ${PUBLIC_LISTINGS_PER_UNIT} listings it read (${1 + listingUnits(searched.read)}), not ${extra}`,
    extra >= 1 + listingUnits(searched.read),
    true,
  );

  part("A search the window has no room for");
  const key = redis.keys().find((k) => k.startsWith("nl:traffic:r:"))!;
  // Room for the page and the search's own request, not for the listings it would read.
  redis.run(["SET", key, String(publicVisitLimit(requestLimitFor(store)) - 2)]);
  const refused = await draw({ q: "lesson" });
  is("it reads no listing", refused.read, 0);
  is("and the page is drawn without it", refused.html.includes(`Lesson ${STORE_PAGE_SIZE + 1}`), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
