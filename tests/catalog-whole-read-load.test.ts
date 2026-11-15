/**
 * 772 [SA4], unit 4, baseline: what the two whole-catalog reads cost today, at
 * the current ceiling (MAX_PRODUCTS) and at 10,000 and 100,000 products, on the
 * in-memory database. Synthetic stores only, no real data, no network.
 *
 * It measures the code as it is, so the study (docs/sa4-catalog-study-2026-11-15.md)
 * rests on counted commands, not on reading the code:
 *
 *   searchStore     a visitor's store search (lib/catalog.ts)
 *   readAllListings a product save, an import, an export, a closing (lib/catalog.ts)
 *
 * Today both read one listing per product outside the record's head, so the
 * count grows with the catalog. The checks hold that exact growth, so that the
 * design of unit 2 (an index outside the store record, a word index for the
 * search) has a measured baseline to beat. When unit 5 builds it, the search
 * checks below change to a ceiling that does not grow with the catalog.
 * Nothing here changes MAX_PRODUCTS or any other limit.
 */
import { readAllListings, searchStore, STORE_PAGE_SIZE } from "@/lib/catalog";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { listingsToRead } from "@/lib/catalog-read-count";
import { LISTING_READ_BYTES } from "@/lib/read-ceilings";
import { type Store, addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let commands: (string | number)[][] = [];
let bytes = 0;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands.push(...batch);
  const replies = await pipeline(batch);
  for (const reply of replies as unknown[]) if (typeof reply === "string") bytes += Buffer.byteLength(reply);
  return replies;
}) as typeof redis.pipeline;

const CATALOG = "cat-load-synthetic";
const idOf = (n: number) => `p${String(n).padStart(9, "0")}`;
/** One real listing, as addProduct writes it, every field the readers expect: the template every synthetic product copies. */
let template: Record<string, unknown> = {};
const listing = (id: string, n: number) => ({ ...template, id, title: n === 7 ? "Synthetic watercolor course" : `Synthetic product ${n}` });

async function readTemplate(): Promise<void> {
  redis.clear();
  const owner = "load-baseline@example.com";
  await claimHandle(owner, "loadbaseline", "Load Baseline", "");
  await ensureStatsId(owner);
  const made = await addProduct(owner, "Synthetic template", "A synthetic listing for the load baseline.", "10", null);
  if (!made.ok) throw new Error("no template product");
  const store = (await storeForEmail(owner))!;
  const [raw] = (await pipeline([["GET", `nl:catalog:${store.catalog.id}:l:${made.product.id}`]])) as unknown[];
  if (typeof raw !== "string") throw new Error("the template listing was not stored where readListings reads it");
  template = JSON.parse(raw) as Record<string, unknown>;
}

/** A synthetic store of `count` visible products, the first page in the record's head, the rest stored one by one. */
async function storeOf(count: number): Promise<Store> {
  redis.clear();
  const ids = Array.from({ length: count }, (_, n) => idOf(n));
  for (let i = 0; i < ids.length; i += 5_000) {
    await pipeline(ids.slice(i, i + 5_000).map((id, k) => ["SET", `nl:catalog:${CATALOG}:l:${id}`, JSON.stringify(listing(id, i + k))]));
  }
  return {
    handle: "loadsynthetic",
    catalog: {
      id: CATALOG,
      items: ids.map((id) => ({ id, kind: 0, options: [] })),
      head: ids.slice(0, STORE_PAGE_SIZE).map((id, n) => listing(id, n)),
      inline: null,
    },
  } as unknown as Store;
}

const listingGets = () => commands.filter((c) => c[0] === "GET" && String(c[1]).startsWith(`nl:catalog:${CATALOG}:l:`)).length;

async function measure(read: () => Promise<unknown>): Promise<{ gets: number; bytes: number; ms: number }> {
  commands = [];
  bytes = 0;
  const started = performance.now();
  await read();
  return { gets: listingGets(), bytes, ms: Math.round(performance.now() - started) };
}

async function main(): Promise<void> {
  await readTemplate();
  for (const count of [MAX_PRODUCTS, 10_000, 100_000]) {
    part(`A synthetic store of ${count.toLocaleString("en-US")} products`);
    const store = await storeOf(count);
    const outside = count - STORE_PAGE_SIZE;
    is("every product outside the first page is a listing to read", listingsToRead(store), outside);

    const search = await measure(() => searchStore(store, "watercolor"));
    is("one search reads one listing per product outside the first page, today", search.gets, outside);
    is("and moves no more than the review ceiling per listing", search.bytes <= outside * LISTING_READ_BYTES, true);

    const all = await measure(() => readAllListings(store));
    is("reading the whole catalog reads the same listings", all.gets, outside);
    console.log(`  baseline ${count}: search ${search.gets} GET, ${search.bytes} bytes, ${search.ms} ms; whole read ${all.gets} GET, ${all.bytes} bytes, ${all.ms} ms`);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
