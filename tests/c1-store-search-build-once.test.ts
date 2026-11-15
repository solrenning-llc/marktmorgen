/**
 * The MEDIUM on #4172 at 45a4b04514 (Claude 1 cloud, 12/11/2026) and the coordinator's decisions (13/11/2026):
 *
 *   (a) the index is still kept SEARCH_INDEX_SECONDS: how soon a search finds a renamed product does not change;
 *   (b) a store whose index is over SEARCH_INDEX_MAX_BYTES is not rebuilt on every search (each paid the whole read
 *       against the store's window): the first build notes that it is too large, and its searches are refused with
 *       an honest sentence (searchUnavailable) while the products are listed as usual;
 *   (c) only one search builds the index at a time (SET NX build lock): concurrent searches after it expired each
 *       built and paid their own (8 searches took 56 units where one build is 4). The build is paid before it reads,
 *       inside the public requests the search already reserves, and a refused reservation refuses the search.
 *
 * Synthetic store; in-memory Redis; no network.
 */
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import StorePage from "@/app/[handle]/page";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { STORE_PAGE_SIZE } from "@/lib/catalog";
import { SEARCH_INDEX_SECONDS, searchIndexKey, searchStorePaid } from "@/lib/store-search-index";
import { BLOCK_WORDS } from "@/lib/buyer-words/blocks";
import { listingsToRead } from "@/lib/catalog-read-count";
import { paidPeriod } from "./billing-period-fixture";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { answering } from "./security/next-headers";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let listingReads = 0;
redis.pipeline = (async (batch: Command[]) => {
  listingReads += batch.filter((c) => c[0] === "GET" && /^nl:catalog:.*:l:/.test(String(c[1]))).length;
  // Each command answered on its own turn, as a real round trip: concurrent searches interleave.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return real(batch);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {
  throw new Error("No external provider in this test");
}) as typeof fetch;

function requestsTaken(): number {
  return redis.keys().filter((key) => key.startsWith("nl:traffic:r:")).reduce((sum, key) => sum + Number(redis.run(["GET", key]) ?? 0), 0);
}

async function makeStore(owner: string, handle: string, count: number, title: (n: number) => string, summary: string): Promise<void> {
  await claimHandle(owner, handle, "Build Once", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}01`, subscriptionId: `sub_${handle}01`, active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  for (let n = 1; n <= count; n += 1) {
    const made = await addProduct(owner, title(n), summary, "9", null);
    if (!made.ok) throw new Error(`no product ${n}: ${JSON.stringify(made)}`);
  }
}

async function draw(handle: string, query: Record<string, string>): Promise<string> {
  const search = new URLSearchParams(query).toString();
  answering(new NextRequest(`https://marktmorgen.com/@${handle}${search ? `?${search}` : ""}`, { headers: { "x-forwarded-for": "203.0.113.9" } }));
  const element = await StorePage({ params: Promise.resolve({ handle: `@${handle}` }), searchParams: Promise.resolve(query) } as never);
  const stream = await renderToReadableStream(element as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_store_search_build_once_stand_in";
  redis.clear();

  part("(a) and (c): one build at a time, kept as long as before");
  const owner = "build-once@example.test";
  await makeStore(owner, "buildonce", STORE_PAGE_SIZE + 60, (n) => `Lesson ${n}`, "A synthetic lesson.");
  let store = (await storeForEmail(owner))!;
  const toRead = listingsToRead(store);
  is(`the store record leaves ${toRead} listings to read`, toRead >= 60, true);
  const first = await searchStorePaid(store, "lesson");
  is("the first search finds them", Boolean(first && typeof first === "object" && first.listings.length), true);
  is("the index is kept as long as before", redis.run(["TTL", searchIndexKey(store)]), SEARCH_INDEX_SECONDS);
  advance((SEARCH_INDEX_SECONDS + 1) * 1000);
  store = (await storeForEmail(owner))!;
  listingReads = 0;
  const before = requestsTaken();
  const many = await Promise.all(Array.from({ length: 8 }, () => searchStorePaid(store, "lesson")));
  is(`8 searches at once after it expired read the listings once (${listingReads} read for ${toRead} listings)`, listingReads <= toRead + 8, true);
  const builds = many.filter((r) => r !== null).length;
  is(`only one of them built and answered; the others were refused (answered: ${builds})`, builds, 1);
  is(`and only one build was paid (${requestsTaken() - before} requests taken)`, requestsTaken() - before <= 2 * Math.ceil(toRead / 32) + 16, true);

  part("(b) an index over the cap is built once and its searches are refused, honestly");
  const big = "big-index@example.test";
  const wide = "検".repeat(300);
  await makeStore(big, "bigindex", 1_100, (n) => `${"講".repeat(70)} ${n}`, wide);
  let bigStore = (await storeForEmail(big))!;
  const once = await searchStorePaid(bigStore, "講");
  is("the first search says search is not available here", once, "unavailable");
  bigStore = (await storeForEmail(big))!;
  listingReads = 0;
  const taken = requestsTaken();
  const again = await searchStorePaid(bigStore, "講");
  is("a second search is refused the same way", again, "unavailable");
  is(`without reading or paying for the listings again (${listingReads} read, ${requestsTaken() - taken} taken)`, [listingReads, requestsTaken() - taken <= 1], [0, true]);
  const html = await draw("bigindex", { q: "講" });
  is("the page says so in plain words, as a status", html.includes(String((BLOCK_WORDS.en as Record<string, unknown>).searchUnavailable ?? "no such words").replace(/'/g, "&#x27;")) && html.includes('role="status"'), true);
  is("and lists the products as usual", html.includes(`${"講".repeat(70)} 1`), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
