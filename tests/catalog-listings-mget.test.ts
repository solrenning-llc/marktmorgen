/**
 * lib/catalog.ts reads a store's product records (readListings, readProducts,
 * readProductsStrict, buildHead) in shared MGETs, LISTINGS_PER_MGET keys at
 * one, not one GET a key (calendar-feed room, option B, 10 November 2026): a
 * calendar feed's making reads every call listing, up to MAX_PRODUCTS (2,000),
 * which was 2,000 commands and is now twenty. Read only whole (CX-123 rule 24):
 * one reply per MGET, one value per key, each a string or nothing; any other
 * answer throws UnknownReplyError, never a product taken to be missing.
 * Synthetic stores only.
 */
import { LISTINGS_PER_MGET, listingReads, readListings, readProducts, readProductsStrict } from "@/lib/catalog";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Batch = (string | number)[][];
const real = redis.pipeline.bind(redis);
let sent: Batch = [];
redis.pipeline = (async (batch: Batch) => {
  sent.push(...batch);
  return real(batch);
}) as typeof redis.pipeline;

const CATALOG = "cat-mget";
const idOf = (i: number) => `p${String(i).padStart(9, "0")}`;
const listing = (id: string) => ({ id, title: `Synthetic ${id}`, summary: "", priceCents: 1000, createdAt: 0 });
const storeOf = (count: number): Store =>
  ({
    catalog: {
      id: CATALOG,
      items: Array.from({ length: count }, (_, i) => ({ id: idOf(i), kind: 0, options: [] })),
      head: [],
      inline: null,
    },
  }) as unknown as Store;

/** The commands `work` sends and what it answered or threw. */
async function measured<T>(work: () => Promise<T>): Promise<{ commands: number; keys: number; value: T | "unknown" | string }> {
  sent = [];
  const value = await work().catch((error) => (error instanceof UnknownReplyError ? ("unknown" as const) : String(error)));
  const keys = sent.reduce((sum, c) => sum + (c[0] === "MGET" ? c.length - 1 : c[0] === "GET" ? 1 : 0), 0);
  return { commands: sent.length, keys, value };
}

/** Answers every MGET of a store's product records with `answer`, as Redis would never, for one call. */
async function offShape<T>(answer: (batch: Batch) => unknown[], work: () => Promise<T>): Promise<T | "unknown" | string> {
  redis.pipeline = (async (batch: Batch) => (batch.some((c) => c[0] === "MGET" || (c[0] === "GET" && String(c[1]).startsWith(`nl:catalog:${CATALOG}:`))) ? answer(batch) : real(batch))) as typeof redis.pipeline;
  try {
    return await work().catch((error) => (error instanceof UnknownReplyError ? ("unknown" as const) : String(error)));
  } finally {
    redis.pipeline = (async (batch: Batch) => {
      sent.push(...batch);
      return real(batch);
    }) as typeof redis.pipeline;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const N = 2_000;
  const all: Batch = Array.from({ length: N }, (_, i) => ["SET", `nl:catalog:${CATALOG}:l:${idOf(i)}`, JSON.stringify(listing(idOf(i)))]);
  for (let i = 0; i < all.length; i += 500) await real(all.slice(i, i + 500));
  const store = storeOf(N);

  part("Every product of a store of 2,000, read in MGETs of LISTINGS_PER_MGET keys, not one GET a key");
  {
    is("a lot is a hundred keys", LISTINGS_PER_MGET, 100);
    const read = await measured(() => readListings(store));
    const listings = Array.isArray(read.value) ? read.value : [];
    is(`every listing comes back, in the creator's order (${listings.length})`, [listings.length, listings[0]?.id, listings[N - 1]?.id], [N, idOf(0), idOf(N - 1)]);
    is(`${N} listings in ${read.commands} commands, within ${N / 100} MGETs`, [read.commands <= Math.ceil(N / 100), read.keys], [true, N]);
    is("listingReads counts what readListings sends", listingReads(N), read.commands);
    is("listingReads: nothing for nothing, one MGET for one to a hundred, one more past it", [listingReads(0), listingReads(1), listingReads(100), listingReads(101)], [0, 1, 1, 2]);
    is("a count that is not a number is never priced low", [listingReads(Number.NaN), listingReads(Number.POSITIVE_INFINITY)], [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]);
    const products = await measured(() => readProducts(store));
    is(`readProducts: ${N} products (record and extras) in ${products.commands} commands, within ${(2 * N) / 100}`, [Array.isArray(products.value) ? products.value.length : products.value, products.commands <= Math.ceil((2 * N) / 100)], [N, true]);
    const strict = await measured(() => readProductsStrict(store, [idOf(5), idOf(7)]));
    is("readProductsStrict: two products in one MGET", [Array.isArray(strict.value) ? strict.value.map((p) => p.id) : strict.value, strict.commands], [[idOf(5), idOf(7)], 1]);
  }

  part("Rule 24: an MGET answered off its shape is unknown and throws, never a product taken to be missing");
  {
    const few = storeOf(150);
    const replies = (batch: Batch) => batch.map((c) => Array.from({ length: c.length - 1 }, () => null));
    is("a store whose records Redis says are all gone (each MGET a list of nils) reads none", await offShape(replies, () => readListings(few)), []);
    is("one reply fewer than the MGETs sent", await offShape((batch) => replies(batch).slice(1), () => readListings(few)), "unknown");
    is("an MGET answered one value short", await offShape((batch) => replies(batch).map((r) => (r as unknown[]).slice(1)), () => readListings(few)), "unknown");
    is("an MGET answered with a value that is neither text nor nothing", await offShape((batch) => replies(batch).map((r) => (r as unknown[]).map(() => 7)), () => readListings(few)), "unknown");
    is("an MGET answered with something that is not a list", await offShape((batch) => batch.map(() => "OK"), () => readListings(few)), "unknown");
    is("readProducts: a value that is neither text nor nothing is unknown, not a product left out", await offShape((batch) => replies(batch).map((r) => (r as unknown[]).map(() => 7)), () => readProducts(few)), "unknown");
  }
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
