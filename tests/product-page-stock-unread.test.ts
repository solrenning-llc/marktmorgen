/**
 * The product page never sells what it could not count (CX-123 rule 24; Claude 7's unknown-is-never-zero sweep).
 *
 * app/[handle]/p/[product]/page.tsx read a limited product's units left with `stockLeft(...).catch(() => null)` and
 * its license key pool with `outOfKeys(...).catch(() => false)`. null is "no limit" and false is "keys left": a
 * failed or ill-shaped read drew the Buy button, the cart and the gift and group buttons for a product that may be
 * sold out, and a key product's "N left" line. The store and collection pages already say these readings are
 * unknown (tests/r24-keys-pages-unknown.test.ts); the product page now does the same: no way to buy it, no count,
 * and "Buying is not available just now. Try again in a moment." in the store's words. A count read as asked keeps
 * its old answer.
 *
 * Synthetic store; one reply injected per case; no network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import ProductPage from "@/app/[handle]/p/[product]/page";
import { addProduct, claimHandle, ensureStatsId, setProductExtras, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { DEFAULT_KEYS } from "@/lib/key-setup";
import { readListing } from "@/lib/catalog";
import { productSegment } from "@/lib/product-slug";
import { wordsIn } from "@/lib/buyer-words";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { answering } from "./security/next-headers";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let failing: ((c: Command) => boolean) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  if (failing && batch.some(failing)) throw new Error("synthetic Redis failure");
  return real(batch);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {
  throw new Error("No external provider in this test");
}) as typeof fetch;

const UNREAD = "Buying is not available just now. Try again in a moment.";
const text = (markup: string) =>
  markup.replace(/<[^>]*>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function setUp() {
  process.env.STRIPE_SECRET_KEY = "sk_test_product_page_stock_unread";
  redis.clear();
  const owner = "product-stock-unread@example.test";
  await claimHandle(owner, "stockunread", "Stock Unread", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_StockUnread01", subscriptionId: "sub_StockUnread01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await setStripeAccount(owner, "acct_1StockUnread001", true);
  const app = await addProduct(owner, "Desktop app", "A synthetic app.", "40", null);
  if (!app.ok) throw new Error("product fixture");
  await setProductLink(owner, app.product.id, "https://example.test/app");
  const limited = await setProductExtras(owner, app.product.id, { stock: 3 });
  if (!limited.ok) throw new Error(`stock fixture: ${limited.reason}`);
  const keyed = await setProductKeys(owner, app.product.id, { ...DEFAULT_KEYS, source: "pool" });
  if (!keyed.ok) throw new Error("keys fixture");
  const store = (await storeForEmail(owner))!;
  const listing = (await readListing(store, app.product.id))!;
  await real([["RPUSH", `nl:keys:${store.statsId}:${listing.id}:pool`, "KEY-ONE"]]);
  return { store, listing, w: wordsIn(store.language), pool: `nl:keys:${store.statsId}:${listing.id}:pool`, stock: `nl:stock:${store.statsId}:${listing.id}` };
}

async function page(store: Awaited<ReturnType<typeof setUp>>["store"], listing: Awaited<ReturnType<typeof setUp>>["listing"]): Promise<string> {
  const segment = productSegment(listing);
  answering(new NextRequest(`https://marktmorgen.com/@${store.handle}/p/${segment}`));
  const element = await ProductPage({ params: Promise.resolve({ handle: `@${store.handle}`, product: segment }), searchParams: Promise.resolve({}) } as never);
  const stream = await renderToReadableStream(element as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return text(await new Response(stream).text());
}

test("control: counts read as asked keep the Buy button and the units left", async () => {
  const { store, listing, w } = await setUp();
  const shown = await page(store, listing);
  assert.ok(shown.includes(w.buyFor("$40")), "the Buy button");
  assert.ok(shown.includes(w.left(3, "3")), "3 left");
  assert.ok(!shown.includes(UNREAD));
});

for (const [what, pick] of [
  ["the license key pool", (keys: { pool: string; stock: string }) => (c: Command) => c[0] === "LLEN" && c[1] === keys.pool],
  ["the units left", (keys: { pool: string; stock: string }) => (c: Command) => c[0] === "HGETALL" && c[1] === keys.stock],
] as const) {
  test(`${what} not read: no way to buy it, no count, and the page says buying is not available`, async () => {
    const set = await setUp();
    failing = pick(set);
    try {
      const shown = await page(set.store, set.listing);
      assert.ok(!shown.includes(set.w.buyFor("$40")), "no Buy button for something that may be sold out");
      assert.ok(shown.includes(UNREAD), "says buying is not available just now");
      assert.ok(!shown.includes(set.w.left(3, "3")), "never says how many are left");
      assert.ok(!shown.includes(set.w.soldOut), "never says it is sold out");
    } finally {
      failing = null;
    }
  });
}
