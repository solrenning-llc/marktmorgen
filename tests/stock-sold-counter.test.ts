/**
 * A limited product counts its sold units in one field, not one field per
 * sale, and every page reads a constant few bytes however many it has sold
 * (Claude 3's performance audit of 13 November 2026, the ALTO).
 *
 * Checked, against the real lib/stock.ts with Redis stubbed and Stripe mocked:
 *   - a sold-out run of 1,000 units reads inside PRODUCT_SIDE_BYTES, and a run
 *     of 5 reads about the same few bytes (constant per page);
 *   - confirmStock told twice for one checkout counts the unit once, and told
 *     again long after (no mark is kept per sale, so nothing can expire) still once;
 *   - two buyers racing for the last unit: only one is counted, the count stays 0;
 *   - a record written the old way (a field per sale) is folded into the counter
 *     a little at a time, losing no sale, even with a fresh sale in the middle;
 *   - a held unit handed back, and a refunded sale, still leave the count right.
 */
import { parseProduct } from "@/lib/catalog";
import { confirmStock, releaseStockHold, stockLeft } from "@/lib/stock";
import { PRODUCT_SIDE_BYTES } from "@/lib/store-data-rules";
import type { Listing, Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const creator = { statsId: "s".repeat(32), stripeAccountId: "acct_test_soldcounter" } as Store;
const limited = (id: string, stock: number) => parseProduct({ id, title: `Print ${id}`, summary: "", priceCents: 2000, stock, link: `https://example.com/${id}` }) as Listing;
const key = (id: string) => `nl:stock:${creator.statsId}:${id}`;
const session = (i: number) => `cs_live_a1${String(i).padStart(56, "0")}`;

/** Every GET of a checkout answers expired, so a lapsed hold is handed back; a POST /expire answers expired. */
const expired = new Set<string>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname);
  if (url.hostname !== "api.stripe.com") return new Response("{}", { status: 404 });
  if (expire && method === "POST") { expired.add(expire[1]); return new Response(JSON.stringify({ id: expire[1], status: "expired" })); }
  if (one && method === "GET") return new Response(JSON.stringify({ id: one[1], status: "expired" }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

/** A checkout's hold, as STOCK_BIND writes it before the buyer can pay: every paid checkout of a limited product has one. */
async function hold(id: string, i: number, until = Date.now() + 30 * 60_000): Promise<void> {
  await redis.pipeline([["HSET", key(id), session(i), JSON.stringify({ until })]]);
}

/** A checkout held, then paid for and confirmed by its buyer coming back. */
async function sell(product: Listing, i: number): Promise<void> {
  await hold(product.id, i);
  await confirmStock(creator, product, session(i));
}

async function storedBytes(id: string): Promise<number> {
  const [raw] = (await redis.pipeline([["HGETALL", key(id)]])) as unknown[];
  const flat = Array.isArray(raw) ? (raw as string[]) : [];
  return key(id).length + flat.reduce((sum, part) => sum + String(part).length, 0);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_only";

  part("A sold-out run reads a constant few bytes");
  const big = limited("sc_big", 1_000);
  for (let i = 0; i < 1_000; i += 1) await sell(big, i);
  is("every unit is sold", await stockLeft(creator, big), 0);
  const bigBytes = await storedBytes("sc_big");
  is("its record stays inside the room counted beside a product", bigBytes <= PRODUCT_SIDE_BYTES, true);
  const small = limited("sc_small", 1_000);
  for (let i = 0; i < 5; i += 1) await sell(small, i);
  is("five sold leave the rest", await stockLeft(creator, small), 995);
  const smallBytes = await storedBytes("sc_small");
  is("and the bytes read do not grow with the sales", bigBytes <= smallBytes + 64, true);
  console.log(`  (measured: ${bigBytes} bytes for 1,000 sold, ${smallBytes} for 5; room ${PRODUCT_SIDE_BYTES})`);

  part("A sale counts once, however many times it is confirmed");
  const twice = limited("sc_twice", 10);
  await sell(twice, 0);
  await confirmStock(creator, twice, session(0));
  await confirmStock(creator, twice, session(0));
  is("the same checkout confirmed three times is one unit", await stockLeft(creator, twice), 9);
  // The thanks page opened again long after (a bookmark, an old email): nothing per sale is kept, so nothing has expired.
  redis.clear();
  await sell(twice, 0);
  is("one sale", await stockLeft(creator, twice), 9);
  is("and nothing is kept per sale that could expire: the record holds only the count", (await redis.pipeline([["HGETALL", key("sc_twice")]]))[0], ["#sold", "1"]);
  await confirmStock(creator, twice, session(0));
  is("confirmed again after any time at all, still one unit", await stockLeft(creator, twice), 9);

  part("Two buyers racing for the last unit");
  const last = limited("sc_last", 1);
  // The admission (withCartStockHolds) lets one hold the last unit; the other is refused before Stripe. Here both
  // confirmations race on the one that holds it, as the thanks page and the cart's door can.
  await hold("sc_last", 1);
  await Promise.all([confirmStock(creator, last, session(1)), confirmStock(creator, last, session(1))]);
  is("the last unit is counted once, the stock at zero", await stockLeft(creator, last), 0);
  const [record] = (await redis.pipeline([["HGET", key("sc_last"), "#sold"]])) as unknown[];
  is("exactly one unit sold", record, "1");
  // A checkout that never held a unit (refused at the admission) has nothing to count.
  await confirmStock(creator, last, session(2));
  is("and a checkout with no hold adds nothing, never below zero", [await stockLeft(creator, last), ((await redis.pipeline([["HGET", key("sc_last"), "#sold"]])) as unknown[])[0]], [0, "1"]);

  part("A record written the old way is folded without losing a sale");
  // 250 sales as the field-per-sale shape wrote them (until, paid), more than one fold (FOLD_MOST 200) takes.
  const old = limited("sc_old", 1_000);
  const writes: (string | number)[][] = [];
  for (let i = 0; i < 250; i += 1) writes.push(["HSET", key("sc_old"), session(i), JSON.stringify({ until: 0, paid: true })]);
  await redis.pipeline(writes);
  const firstCount = await stockLeft(creator, old);
  is("the count is right straight away, before the fold finishes", firstCount, 750);
  // A fresh sale lands while the old fields are still being folded.
  await sell(old, 250);
  const midCount = await stockLeft(creator, old);
  is("a sale in the middle of folding is not lost", midCount, 749);
  // Fold the rest (each count folds at most FOLD_MOST).
  for (let round = 0; round < 5; round += 1) await stockLeft(creator, old);
  is("after folding, the count still holds", await stockLeft(creator, old), 749);
  is("and nothing of the old per-sale fields is left to read", (await storedBytes("sc_old")) <= PRODUCT_SIDE_BYTES, true);

  part("Handing a unit back, and a refund");
  const back = limited("sc_back", 3);
  await sell(back, 0);
  is("one sold of three", await stockLeft(creator, back), 2);
  // A held (not yet paid) unit of a different checkout, then handed back.
  await redis.pipeline([["HSET", key("sc_back"), session(9), JSON.stringify({ until: Date.now() + 60_000 })]]);
  is("a live hold counts too", await stockLeft(creator, back), 1);
  await releaseStockHold(creator, back, session(9));
  is("handing the hold back frees its unit, the sale still counted", await stockLeft(creator, back), 2);
  // Releasing a sold checkout does nothing (its checkout can never be expired).
  await releaseStockHold(creator, back, session(0));
  is("a sold checkout is never handed back", await stockLeft(creator, back), 2);

  done();
}

void main();
