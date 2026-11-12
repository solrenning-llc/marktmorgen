/**
 * A search on the store page (app/[handle]/page.tsx, lib/catalog.ts
 * searchStore) pays for the listings it reads before it reads them.
 *
 * Before: a search read the listing of every visible product the store record does
 * not carry: up to MAX_PRODUCTS (2,000) GETs and their records for one
 * visitor's query. It took one public request (withinStore "store-search"),
 * priced as a later page (tests/traffic-cost.ts: 10 + 8 commands), so a
 * stranger's 30 searches every ten minutes (the per-connection limit) on a
 * store of 2,000 products made it read about 60,000 listings for 30 requests
 * of its window. The other public reads that grow with the store (the store's
 * map, an affiliate's page: lib/public-read-rules.ts) take one more request
 * for each PUBLIC_LISTINGS_PER_UNIT listings, before reading; the search now
 * does the same. Paying the whole read on every search (the first version of
 * #4172) shut a real buyer out of a large store after four searches, so the
 * whole read is now done once for everybody, kept ten minutes and paid as
 * shared work (lib/store-search-index.ts); each search pays for the matches it
 * shows and their checkout boxes. A search the window refuses reads none and
 * says so.
 *
 * Synthetic store; in-memory Redis; no network.
 */
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import StorePage from "@/app/[handle]/page";
import { addProduct, claimHandle, ensureStatsId, setProductExtras, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { STORE_PAGE_SIZE, STORE_SEARCH_LIMIT } from "@/lib/catalog";
import { SEARCH_INDEX_SECONDS, searchIndexKey } from "@/lib/store-search-index";
import { BLOCK_WORDS } from "@/lib/buyer-words/blocks";
import { listingsToRead } from "@/lib/catalog-read-count";
import { listingUnits } from "@/lib/public-read-rules";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { paidPeriod } from "./billing-period-fixture";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { answering } from "./security/next-headers";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let listingReads = 0;
redis.pipeline = (async (batch: Command[]) => {
  const gets = batch.filter((c) => c[0] === "GET" && /^nl:catalog:.*:l:/.test(String(c[1])));
  listingReads += gets.length;
  return real(batch);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {
  throw new Error("No external provider in this test");
}) as typeof fetch;

const HANDLE = "costsearch";
const EXTRA = 100;
/** Lessons with three checkout boxes each. */
const BOXED = 5;

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
  answering(new NextRequest(`https://marktmorgen.com/@${HANDLE}${search ? `?${search}` : ""}`, { headers: { "x-forwarded-for": "203.0.113.7" } }));
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
  const ids: string[] = [];
  for (let n = 1; n <= STORE_PAGE_SIZE + EXTRA; n += 1) {
    const made = await addProduct(owner, `Lesson ${n}`, "A synthetic lesson.", "9", null);
    if (!made.ok) throw new Error(`no product ${n}`);
    ids.push(made.product.id);
  }
  // Checkout boxes on the lessons a search shows, offering tools no "lesson" search matches.
  const tools: string[] = [];
  for (let n = 1; n <= 3 * BOXED; n += 1) {
    const made = await addProduct(owner, `Tool ${n}`, "A synthetic tool.", "9", null);
    if (!made.ok) throw new Error(`no tool ${n}`);
    await setProductLink(owner, made.product.id, `https://example.com/tool-${n}`);
    tools.push(made.product.id);
  }
  for (let n = 0; n < BOXED; n += 1) {
    for (let slot = 0; slot < 3; slot += 1) {
      const set = await setProductExtras(owner, ids[30 + n], { bump: { productId: tools[3 * n + slot], priceCents: 500, pitch: "Add it." }, slot });
      if (!set.ok) throw new Error(`no box ${n}/${slot}: ${JSON.stringify(set)}`);
    }
  }
  const store = (await storeForEmail(owner))!;
  const toRead = listingsToRead(store);
  is(`the store record carries the first page; ${toRead} listings are read from their own records`, toRead >= EXTRA, true);

  part("A page of the store, without a search");
  const plain = await draw({});
  is("the first page reads no listing", plain.read, 0);

  part("The first search reads every listing once, paid as shared work, and keeps the index");
  const first = await draw({ q: "lesson" });
  is("it found them", first.html.includes(`Lesson ${STORE_PAGE_SIZE + 1}`), true);
  is(`every listing it read was paid first (${first.taken - plain.taken} taken for ${first.read} read)`, first.taken - plain.taken >= listingUnits(first.read), true);
  is("the index is kept ten minutes", redis.run(["TTL", searchIndexKey(store)]), SEARCH_INDEX_SECONDS);

  part("A later search reads only what it shows, and pays for it, the checkout boxes too");
  const second = await draw({ q: "lesson" });
  const shownAtMost = STORE_SEARCH_LIMIT + 3 * BOXED;
  is(`it reads at most the ${STORE_SEARCH_LIMIT} matches it shows and their ${3 * BOXED} boxes (read ${second.read}), not all ${toRead}`, second.read <= shownAtMost, true);
  is(`and pays for each (${second.taken - plain.taken} taken)`, second.taken - plain.taken >= listingUnits(second.read), true);
  is("the same results", second.html.includes(`Lesson ${STORE_PAGE_SIZE + 1}`), true);
  const narrow = await draw({ q: "lesson 101" });
  is(`a narrow search reads its one match (read ${narrow.read}) and takes at most two requests besides the page`, [narrow.read <= 1, narrow.taken - plain.taken <= 2], [true, true]);

  const boxed = await draw({ q: "lesson 31" });
  is(
    `a search whose one match offers three boxes reads them and pays one request more than a match without boxes (${boxed.taken} against ${narrow.taken})`,
    [boxed.read, boxed.taken - narrow.taken],
    [4, 1],
  );

  part("A buyer who searches a dozen times is not shut out of the store");
  for (let n = 0; n < 12; n += 1) await draw({ q: `lesson ${n + 1}` });
  const after = await draw({});
  is("the store's first page is still drawn for them", after.html.includes("Lesson 1"), true);

  part("A product added builds a new index, so a search finds it at once");
  await addProduct(owner, "Brand new lesson", "Fresh.", "9", null);
  const added = await draw({ q: "brand" });
  is("found", added.html.includes("Brand new lesson"), true);

  part("A search the window has no room for reads nothing and says so");
  advance((SEARCH_INDEX_SECONDS + 1) * 1000);
  const key = redis.keys().find((k) => k.startsWith("nl:traffic:r:"))!;
  // Room for the page, not for the listings the search would read.
  redis.run(["SET", key, String(publicVisitLimit(requestLimitFor((await storeForEmail(owner))!)) - 2)]);
  const refused = await draw({ q: "lesson" });
  is("it reads no listing", refused.read, 0);
  is("and the page is drawn without it", refused.html.includes(`Lesson ${STORE_PAGE_SIZE + 1}`), false);
  is("with the note a refused search shows, as a status", refused.html.includes(BLOCK_WORDS.en.searchSlow) && refused.html.includes('role="status"'), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
