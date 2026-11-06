/**
 * A limited product whose count cannot be read (CX-123 rule 24 and rule 30;
 * A8 proof fc4197ab on #2879, made permanent here).
 *
 * lib/stock.ts stockLeft throws "Stock reading unavailable" when a limited
 * product's holds come back out of shape or cannot be asked for. The product
 * page, the store page, a collection page and the embedded card each read it
 * once; null is the answer for a product with NO limit, so an unknown count is
 * never read as null. It is drawn as a sold-out one is drawn (no count, no buy
 * button, no gift), with words of its own saying the stock could not be
 * checked, and the product page's structured data says nothing of its
 * availability rather than InStock or SoldOut.
 *
 * Controls: a product with no limit, a known count and a sold-out one draw as
 * before. The checkout still refuses on its own read (app/api/store/checkout),
 * which this test does not change.
 *
 * Synthetic store; one reply injected per case; no network.
 */
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import ProductPage from "@/app/[handle]/p/[product]/page";
import StorePage from "@/app/[handle]/page";
import CollectionPage from "@/app/[handle]/shop/[collection]/page";
import EmbedCard from "@/app/embed/[handle]/[product]/page";
import { addProduct, claimHandle, ensureStatsId, setCollections, setLanguage, setProductExtras, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { stockLeft } from "@/lib/stock";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGES, type LanguageCode } from "@/lib/store-language";
import { collectionSegment } from "@/lib/store-collections";
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
  throw new Error("No external provider in the stock-unknown test");
}) as typeof fetch;

async function html(node: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(node, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

/** One product's card on a page of cards: from its own list item to the next one, or to the end of its list. */
function cardOf(page: string, id: string): string {
  const start = page.indexOf(`id="p-${id}"`);
  if (start < 0) return "";
  const next = page.indexOf('<li id="p-', start + 1);
  const end = page.indexOf("</ul></section>", start);
  const stops = [next, end].filter((n) => n > start);
  return page.slice(start, stops.length ? Math.min(...stops) : undefined);
}

const PAID = JSON.stringify({ until: 0, paid: true });

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_stock_unknown_only_a_stand_in";
  redis.clear();
  const owner = "stock-unknown@example.test";
  await claimHandle(owner, "stockunknown", "Stock Unknown", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_StockUnk0001", subscriptionId: "sub_StockUnk0001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const made = await addProduct(owner, "Signed Print", "A synthetic limited print.", "40", null);
  const open = await addProduct(owner, "Open Guide", "A synthetic guide with no limit.", "20", null);
  if (!made.ok || !open.ok) throw new Error("product fixture");
  const limited = await setProductExtras(owner, made.product.id, { stock: 3 });
  if (!limited.ok) throw new Error(`stock fixture: ${limited.reason}`);
  await setStripeAccount(owner, "acct_1StockUnknown01", true);
  await setProductLink(owner, made.product.id, "https://example.test/print");
  await setProductLink(owner, open.product.id, "https://example.test/guide");
  const grouped = await setCollections(owner, [{ title: "Prints", products: [made.product.id, open.product.id] }]);
  if (!grouped.ok) throw new Error(`collection fixture: ${grouped.reason}`);

  const storeNow = async () => (await storeForEmail(owner))!;
  const store = await storeNow();
  const listing = await readListing(store, made.product.id);
  const unlimited = await readListing(store, open.product.id);
  if (!listing || !unlimited) throw new Error("listing fixture");
  stockKey = `nl:stock:${store.statsId}:${listing.id}`;
  const collection = store.collections![0];

  const productPage = async (which = listing) => {
    const segment = productSegment(which);
    answering(new NextRequest(`https://marktmorgen.com/@stockunknown/p/${segment}`));
    return html((await ProductPage({ params: Promise.resolve({ handle: "@stockunknown", product: segment }), searchParams: Promise.resolve({}) } as never)) as React.ReactElement);
  };
  const storePage = async () => {
    answering(new NextRequest("https://marktmorgen.com/@stockunknown"));
    return html((await StorePage({ params: Promise.resolve({ handle: "@stockunknown" }), searchParams: Promise.resolve({}) } as never)) as React.ReactElement);
  };
  const collectionPage = async () => {
    const segment = collectionSegment(collection);
    answering(new NextRequest(`https://marktmorgen.com/@stockunknown/shop/${segment}`));
    return html((await CollectionPage({ params: Promise.resolve({ handle: "@stockunknown", collection: segment }) } as never)) as React.ReactElement);
  };
  const embedCard = async (which = listing) => {
    answering(new NextRequest(`https://marktmorgen.com/embed/stockunknown/${which.id}`));
    return html((await EmbedCard({ params: Promise.resolve({ handle: "stockunknown", product: which.id }), searchParams: Promise.resolve({}) } as never)) as React.ReactElement);
  };

  const w = wordsIn(store.language);
  const leftLine = /\d+ left/;
  const productBuy = /type="submit"/;
  const cardBuy = /data-buy-step=""|data-checkout=""/;
  const embedBuy = /class="btn st-btn btn-block mt-3"|data-checkout=""/;

  part("The words, in every buyer language");
  const codes = Object.keys(LANGUAGES) as LanguageCode[];
  is("every language says it, in a sentence of its own", codes.map((c) => typeof wordsIn(c).stockUnknown === "string" && wordsIn(c).stockUnknown.trim().length > 20), codes.map(() => true));
  is("never the sold-out words, nor English outside English", codes.map((c) => wordsIn(c).stockUnknown !== wordsIn(c).soldOut && wordsIn(c).stockUnknown !== wordsIn(c).soldOutStop && (c === "en" || wordsIn(c).stockUnknown !== wordsIn("en").stockUnknown)), codes.map(() => true));
  is("in US English", w.stockUnknown, "Stock could not be checked right now. Please try again in a few minutes.");

  part("Control: a product with no limit");
  is("stockLeft answers null, without asking", await stockLeft(store, unlimited), null);
  const free = await productPage(unlimited);
  is("its page says no count, no sold out, nothing unknown, and has its buy button", [leftLine.test(free), free.includes(w.soldOut), free.includes(w.stockUnknown), productBuy.test(free)], [false, false, false, true]);
  is("and search engines are told it is in stock", free.includes("https://schema.org/InStock"), true);
  const freeEmbed = await embedCard(unlimited);
  is("its card says nothing of stock and has its button", [leftLine.test(freeEmbed), freeEmbed.includes(w.stockUnknown), embedBuy.test(freeEmbed)], [false, false, true]);

  part("Control: a whole reading (three left)");
  is("three left, read exactly", await stockLeft(store, listing), 3);
  const healthy = await productPage();
  is("the product page says how many are left, with its buy button", [healthy.includes(w.left(3, "3")), productBuy.test(healthy), healthy.includes(w.stockUnknown)], [true, true, false]);
  is("and search engines are told it is in stock, which is true here", healthy.includes("https://schema.org/InStock"), true);
  const healthyStore = cardOf(await storePage(), listing.id);
  is("the store page's card says how many are left, with its way to buy", [healthyStore.includes(w.left(3, "3")), cardBuy.test(healthyStore), healthyStore.includes(w.stockUnknown)], [true, true, false]);
  const healthyShelf = cardOf(await collectionPage(), listing.id);
  is("so does the collection's card", [healthyShelf.includes(w.left(3, "3")), cardBuy.test(healthyShelf), healthyShelf.includes(w.stockUnknown)], [true, true, false]);
  const healthyEmbed = await embedCard();
  is("so does the embedded card", [healthyEmbed.includes(w.left(3, "3")), embedBuy.test(healthyEmbed), healthyEmbed.includes(w.stockUnknown)], [true, true, false]);

  part("Control: sold out");
  inject = () => [["cs_test_stockunk0001", PAID, "cs_test_stockunk0002", PAID, "cs_test_stockunk0003", PAID]];
  is("none left, read exactly", await stockLeft(store, listing), 0);
  const gone = await productPage();
  is("the product page says sold out, with no buy button and nothing unknown", [gone.includes(w.soldOut), productBuy.test(gone), gone.includes(w.stockUnknown)], [true, false, false]);
  is("and tells search engines it is sold out", [gone.includes("https://schema.org/SoldOut"), gone.includes("https://schema.org/InStock")], [true, false]);
  const goneStore = cardOf(await storePage(), listing.id);
  is("the store page's card says sold out, with no way to buy", [goneStore.includes(w.soldOut), cardBuy.test(goneStore), goneStore.includes(w.stockUnknown)], [true, false, false]);
  const goneShelf = cardOf(await collectionPage(), listing.id);
  is("so does the collection's card", [goneShelf.includes(w.soldOut), cardBuy.test(goneShelf), goneShelf.includes(w.stockUnknown)], [true, false, false]);
  const goneEmbed = await embedCard();
  is("the embedded card says sold out, with no button", [goneEmbed.includes(w.soldOutStop), embedBuy.test(goneEmbed), goneEmbed.includes(w.stockUnknown)], [true, false, false]);
  inject = null;

  const cases: [string, () => unknown[] | Promise<unknown[]>][] = [
    ["holds answered with a string", () => ["x"]],
    ["a hold that is half a record", () => [["cs_test_stockunk0001", "{\"until\":"]]],
    ["no reply at all", () => []],
    ["a failed request", () => Promise.reject(new Error("synthetic Redis failure"))],
  ];
  for (const [name, reply] of cases) {
    part(`Unknown: ${name}`);
    inject = reply;
    is("stockLeft says the reading is unknown", await stockLeft(store, listing).then(() => "known", () => "unknown"), "unknown");
    const shown = await productPage();
    is("the product page says the stock could not be checked", shown.includes(w.stockUnknown), true);
    is("and never draws it as a product nobody limited, nor as sold out: no count, no sold out, no buy button", [leftLine.test(shown), shown.includes(w.soldOut), productBuy.test(shown)], [false, false, false]);
    is("search engines are told nothing of its availability: neither in stock nor sold out", [shown.includes("https://schema.org/InStock"), shown.includes("https://schema.org/SoldOut"), shown.includes('"availability"')], [false, false, false]);
    is("its price is still told, as the page shows it", shown.includes('"@type":"Offer"'), true);
    const front = cardOf(await storePage(), listing.id);
    is("the store page's card says so, with no count, no sold out and no way to buy", [front.includes(w.stockUnknown), leftLine.test(front), front.includes(w.soldOut), cardBuy.test(front)], [true, false, false, false]);
    const shelf = await collectionPage();
    const card = cardOf(shelf, listing.id);
    is("so does the collection's card", [card.includes(w.stockUnknown), leftLine.test(card), card.includes(w.soldOut), cardBuy.test(card)], [true, false, false, false]);
    is("and the product with no limit beside it is drawn as before", [cardBuy.test(cardOf(shelf, unlimited.id)), cardOf(shelf, unlimited.id).includes(w.stockUnknown)], [true, false]);
    const embedded = await embedCard();
    is("the embedded card says so, with no count, no sold out and no button", [embedded.includes(w.stockUnknown), leftLine.test(embedded), embedded.includes(w.soldOutStop), embedBuy.test(embedded)], [true, false, false, false]);
    inject = null;
  }

  part("In the store's own language");
  await setLanguage(owner, "de");
  const de = wordsIn("de");
  inject = () => Promise.reject(new Error("synthetic Redis failure"));
  const german = await productPage();
  const germanEmbed = await embedCard();
  inject = null;
  is("a German store says it in German, on the page and on the card", [german.includes(de.stockUnknown), germanEmbed.includes(de.stockUnknown), german.includes(w.stockUnknown)], [true, true, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
