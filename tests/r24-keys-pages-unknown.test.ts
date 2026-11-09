/**
 * CX-123 rule 24 on the store's own pages (follow-up of Claude 3's focal
 * review of #2910, 8 November 2026): a product that hands out license keys
 * from a pool whose count could not be read was drawn as if keys were left.
 *
 * The store page (app/[handle]/page.tsx) and the collection page
 * (app/[handle]/shop/[collection]/page.tsx) read the pool with
 * `outOfKeys(...).catch(() => false)`, and false means "keys left": the Buy
 * button, the "N left" line of a limited product and the cart were drawn. The
 * checkout refuses on its own; what was wrong is what the page told the buyer.
 * The product page (app/[handle]/p/[product]/page.tsx) has the same reading;
 * it is left to a later unit because open pull requests change the same lines.
 *
 * With the count unknown, each page now draws no way to buy that product,
 * says "Buying is not available just now. Try again in a moment." in the
 * store's words (cardBuyUnread, the sentence the embedded card uses since
 * #2910), and hides the "N left" line; the product's title still leads to its
 * page. A key left and an empty pool keep their old answers.
 *
 * Synthetic store; one reply injected per case; no network.
 */
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import StorePage from "@/app/[handle]/page";
import CollectionPage from "@/app/[handle]/shop/[collection]/page";
import { addProduct, claimHandle, ensureStatsId, setCollections, setProductExtras, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { DEFAULT_KEYS } from "@/lib/key-setup";
import { readListing } from "@/lib/catalog";
import { outOfKeys } from "@/lib/licence-keys";
import { collectionSegment } from "@/lib/store-collections";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGES, type LanguageCode } from "@/lib/store-language";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { answering } from "./security/next-headers";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let poolKey = "";
let inject: (() => unknown[] | Promise<unknown[]>) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  if (inject && batch.some((c) => c[0] === "LLEN" && c[1] === poolKey)) return inject();
  return real(batch);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {
  throw new Error("No external provider in this test");
}) as typeof fetch;

async function html(url: string, run: () => Promise<unknown>): Promise<string> {
  answering(new NextRequest(url));
  const stream = await renderToReadableStream((await run()) as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

/** The rendered text, with tags and entities read, so a sentence is found whatever markup holds it. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const UNREAD = "Buying is not available just now. Try again in a moment.";

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_r24_keys_pages_stand_in";
  redis.clear();
  const owner = "r24-keys-pages@example.test";
  await claimHandle(owner, "r24keyspages", "R24 Keys Pages", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_R24Keys0001", subscriptionId: "sub_R24Keys0001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await setStripeAccount(owner, "acct_1R24KeysPages01", true);

  // A product with a key pool, limited to three, and an ordinary product beside it.
  const app = await addProduct(owner, "Desktop app", "A synthetic app.", "40", null);
  if (!app.ok) throw new Error("key product fixture");
  await setProductLink(owner, app.product.id, "https://example.test/app");
  const limited = await setProductExtras(owner, app.product.id, { stock: 3 });
  if (!limited.ok) throw new Error(`stock fixture: ${limited.reason}`);
  const keyed = await setProductKeys(owner, app.product.id, { ...DEFAULT_KEYS, source: "pool" });
  if (!keyed.ok) throw new Error("keys fixture");
  const guide = await addProduct(owner, "Field guide", "A synthetic guide.", "25", null);
  if (!guide.ok) throw new Error("guide fixture");
  await setProductLink(owner, guide.product.id, "https://example.test/guide");
  const saved = await setCollections(owner, [{ title: "Tools", products: [app.product.id, guide.product.id] }]);
  if (!saved.ok) throw new Error("collection fixture");

  const store = (await storeForEmail(owner))!;
  const listing = (await readListing(store, app.product.id))!;
  poolKey = `nl:keys:${store.statsId}:${listing.id}:pool`;
  await real([["RPUSH", poolKey, "KEY-ONE"]]);
  const w = wordsIn(store.language);
  const shopSegment = collectionSegment((await storeForEmail(owner))!.collections![0]);

  const pages: [string, () => Promise<string>][] = [
    ["the store page", () => html("https://marktmorgen.com/@r24keyspages", () => StorePage({ params: Promise.resolve({ handle: "@r24keyspages" }), searchParams: Promise.resolve({}) } as never))],
    [
      "the collection page",
      () => html(`https://marktmorgen.com/@r24keyspages/shop/${shopSegment}`, () => CollectionPage({ params: Promise.resolve({ handle: "@r24keyspages", collection: shopSegment }) } as never)),
    ],
  ];
  const buy40 = w.buyFor("$40");
  const buy25 = w.buyFor("$25");

  part("Controls: the pool read as asked");
  is("a key left: outOfKeys says not out", await outOfKeys(store, listing), false);
  for (const [name, draw] of pages) {
    const shown = text(await draw());
    is(`${name}: a key left shows the Buy button`, shown.includes(buy40), true);
    is(`${name}: and the limited product's "3 left"`, shown.includes(w.left(3, "3")), true);
    is(`${name}: and never says buying is not available`, shown.includes(UNREAD), false);
  }
  inject = () => [0];
  is("an empty pool: outOfKeys says out", await outOfKeys(store, listing), true);
  for (const [name, draw] of pages) {
    const shown = text(await draw());
    is(`${name}: an empty pool shows no Buy button`, shown.includes(buy40), false);
    is(`${name}: and says sold out, as today`, shown.includes(w.soldOut), true);
    is(`${name}: and never says buying is not available`, shown.includes(UNREAD), false);
  }
  inject = null;

  for (const [reading, reply] of [
    ["a failed request", () => Promise.reject(new Error("synthetic Redis failure"))],
    ["no reply at all", () => []],
    ["a word for the count", () => ["QUEUED"]],
    ["a negative count", () => [-1]],
  ] as const) {
    part(`The key count unknown: ${reading}`);
    inject = reply;
    is("outOfKeys says the reading is unknown", await outOfKeys(store, listing).then(() => "known", () => "unknown"), "unknown");
    for (const [name, draw] of pages) {
      const shown = text(await draw());
      is(`${name}: no Buy button for something that may be sold out`, shown.includes(buy40), false);
      is(`${name}: says buying is not available just now`, shown.includes(UNREAD), true);
      is(`${name}: never says how many are left`, shown.includes(w.left(3, "3")), false);
      is(`${name}: never says it is sold out`, shown.includes(w.soldOut), false);
      is(`${name}: the product's title is still shown`, shown.includes("Desktop app"), true);
      is(`${name}: the product beside it still shows its Buy button`, shown.includes(buy25), true);
    }
    inject = null;
  }

  part("The sentence, in every language the store can have");
  const codes = Object.keys(LANGUAGES) as LanguageCode[];
  is("cardBuyUnread exists in every language", codes.filter((code) => typeof (wordsIn(code) as unknown as Record<string, unknown>).cardBuyUnread !== "string"), []);
  is("in English it is the sentence the embedded card says", (wordsIn("en") as unknown as Record<string, unknown>).cardBuyUnread, UNREAD);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
