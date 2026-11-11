/**
 * A8 proof (CX-123 rule 24 and rule 30): lib/stock.ts stockLeft already throws
 * when a limited product's holds come back out of shape ("Stock reading
 * unavailable"), but the store page, the product page and the collection page
 * read it with `.catch(() => null)`, and null is the answer for a product with
 * NO limit. A limited product whose count cannot be read is then drawn as if
 * nobody had ever limited it: no "Sold out" and no "N left", the buy button,
 * and search engines told it is InStock.
 *
 * The checkout still refuses on its own (app/api/store/checkout/route.ts
 * reads the stock under its hold), so no unit is sold that does not exist;
 * what is wrong is what the page tells the buyer.
 *
 * Each check below states the honest outcome, so it FAILS on main today.
 * Synthetic store; one reply injected per case; no network.
 */
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import ProductPage from "@/app/[handle]/p/[product]/page";
import { addProduct, claimHandle, ensureStatsId, setProductExtras, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { stockLeft } from "@/lib/stock";
import { wordsIn } from "@/lib/buyer-words";
import { productSegment } from "@/lib/product-slug";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { answering } from "./security/next-headers";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let stockKey = "";
let inject: (() => unknown[] | Promise<unknown[]>) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  if (inject && batch.some((c) => c[0] === "HGETALL" && c[1] === stockKey)) return inject();
  return real(batch);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {
  throw new Error("No external provider in the A8 proof");
}) as typeof fetch;

async function html(node: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(node, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_a8_only_a_stand_in";
  redis.clear();
  const owner = "a8-stock-proof@example.test";
  await claimHandle(owner, "a8stockproof", "A8 Stock Proof", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_A8Stock0001", subscriptionId: "sub_A8Stock0001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const made = await addProduct(owner, "Signed Print", "A synthetic limited print.", "40", null);
  if (!made.ok) throw new Error("product fixture");
  const limited = await setProductExtras(owner, made.product.id, { stock: 3 });
  if (!limited.ok) throw new Error(`stock fixture: ${limited.reason}`);
  await setStripeAccount(owner, "acct_1A8StockProof01", true);
  await setProductLink(owner, made.product.id, "https://example.test/print");
  const store = (await storeForEmail(owner))!;
  const listing = await readListing(store, made.product.id);
  if (!listing) throw new Error("listing fixture");
  stockKey = `nl:stock:${store.statsId}:${listing.id}`;
  const w = wordsIn(store.language);
  const page = async () => {
    const segment = productSegment(listing);
    answering(new NextRequest(`https://marktmorgen.com/@a8stockproof/p/${segment}`));
    return html((await ProductPage({ params: Promise.resolve({ handle: "@a8stockproof", product: segment }), searchParams: Promise.resolve({}) } as never)) as React.ReactElement);
  };

  /** The availability the page's structured data states, compared whole (never as a substring of a URL). */
  const availability = (html: string) => /"availability":"([^"]*)"/.exec(html)?.[1] ?? null;
  const IN_STOCK = "https://schema.org/InStock";

  part("Control: a whole reading");
  is("three left, read exactly", await stockLeft(store, listing), 3);
  const healthy = await page();
  is("the page says how many are left", healthy.includes(w.left(3, "3")), true);
  is("and search engines are told it is in stock, which is true here", availability(healthy) === IN_STOCK, true);

  const cases: [string, () => unknown[] | Promise<unknown[]>][] = [
    ["holds answered with a string", () => ["x"]],
    ["a hold that is half a record", () => [["cs_test_a8proof0001", "{\"until\":"]]],
    ["no reply at all", () => []],
    ["a failed request", () => Promise.reject(new Error("synthetic Redis failure"))],
  ];
  for (const [name, reply] of cases) {
    part(`Unknown: ${name}`);
    inject = reply;
    is("stockLeft says the reading is unknown", await stockLeft(store, listing).then(() => "known", () => "unknown"), "unknown");
    const shown = await page();
    is("the page never tells search engines it is in stock", availability(shown) === IN_STOCK, false);
    is("nor draws it as a product nobody limited (no count, no sold out, a buy button)", !shown.includes(w.soldOut) && !/\d+ left/.test(shown) && /type="submit"/.test(shown), false);
    inject = null;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
