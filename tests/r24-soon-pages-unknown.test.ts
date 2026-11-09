/**
 * CX-123 rule 24 on the store's own pages: a product whose "coming soon" state
 * could not be read was drawn as if it were on sale.
 *
 * The store page (app/[handle]/page.tsx) and the collection page
 * (app/[handle]/shop/[collection]/page.tsx) read which products are coming
 * soon with `soonState(...).catch(() => <empty>)`, and soonState itself read a
 * reply that was not a list, or a member that was not a product id, as "not
 * coming soon". Either way a product that may not be out yet showed its Buy
 * button and could go in the cart. The embedded card got the same fix in #2910.
 *
 * With the reading unknown, each page now draws no way to buy any product,
 * says "Buying is not available just now. Try again in a moment." in the
 * store's words (cardBuyUnread, the sentence the embedded card uses), and puts
 * nothing in the cart; each product's title still leads to its page. With only
 * part of it read, a product read as coming soon keeps its waitlist and every
 * other product is unknown. A product coming soon and a product on sale keep
 * their old answers.
 *
 * Synthetic store; one reply injected per case; no network.
 */
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import StorePage from "@/app/[handle]/page";
import CollectionPage from "@/app/[handle]/shop/[collection]/page";
import { addProduct, claimHandle, ensureStatsId, setCollections, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { soonState } from "@/lib/preorders";
import { collectionSegment } from "@/lib/store-collections";
import { wordsIn } from "@/lib/buyer-words";
import { cartWords } from "@/lib/buyer-words/cart";
import { LANGUAGES, type LanguageCode } from "@/lib/store-language";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { answering } from "./security/next-headers";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let soonKey = "";
let inject: (() => unknown[] | Promise<unknown[]>) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  if (inject && batch.some((c) => c[0] === "SMEMBERS" && c[1] === soonKey)) return inject();
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
  process.env.STRIPE_SECRET_KEY = "sk_test_r24_soon_pages_stand_in";
  redis.clear();
  const owner = "r24-soon-pages@example.test";
  await claimHandle(owner, "r24soonpages", "R24 Soon Pages", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_R24Soon0001", subscriptionId: "sub_R24Soon0001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await setStripeAccount(owner, "acct_1R24SoonPages01", true);

  // Two ordinary paid products, so the cart is offered, in one collection.
  const app = await addProduct(owner, "Desktop app", "A synthetic app.", "40", null);
  if (!app.ok) throw new Error("app fixture");
  await setProductLink(owner, app.product.id, "https://example.test/app");
  const guide = await addProduct(owner, "Field guide", "A synthetic guide.", "25", null);
  if (!guide.ok) throw new Error("guide fixture");
  await setProductLink(owner, guide.product.id, "https://example.test/guide");
  const saved = await setCollections(owner, [{ title: "Tools", products: [app.product.id, guide.product.id] }]);
  if (!saved.ok) throw new Error("collection fixture");

  const store = (await storeForEmail(owner))!;
  soonKey = `nl:wl:${store.statsId}:soon`;
  const w = wordsIn(store.language);
  const cw = cartWords(store.language);
  const shopSegment = collectionSegment(store.collections![0]);

  const pages: [string, () => Promise<string>][] = [
    ["the store page", () => html("https://marktmorgen.com/@r24soonpages", () => StorePage({ params: Promise.resolve({ handle: "@r24soonpages" }), searchParams: Promise.resolve({}) } as never))],
    [
      "the collection page",
      () => html(`https://marktmorgen.com/@r24soonpages/shop/${shopSegment}`, () => CollectionPage({ params: Promise.resolve({ handle: "@r24soonpages", collection: shopSegment }) } as never)),
    ],
  ];
  const buy40 = w.buyFor("$40");
  const buy25 = w.buyFor("$25");

  part("Control: nothing coming soon");
  is("soonState reads none coming soon", (await soonState(store)).soon.size, 0);
  for (const [name, draw] of pages) {
    const shown = text(await draw());
    is(`${name}: the first product shows its Buy button`, shown.includes(buy40), true);
    is(`${name}: and the second its own`, shown.includes(buy25), true);
    is(`${name}: both can go in the cart`, shown.includes(cw.add), true);
    is(`${name}: and it never says buying is not available`, shown.includes(UNREAD), false);
  }
  is("the collection page offers to add both to the cart", text(await pages[1][1]()).includes(cw.addAll(2)), true);

  part("Control: one product coming soon, as today");
  await real([["SADD", soonKey, app.product.id]]);
  is("soonState reads it coming soon", (await soonState(store)).soon.has(app.product.id), true);
  for (const [name, draw] of pages) {
    const shown = text(await draw());
    is(`${name}: the product coming soon shows no Buy button`, shown.includes(buy40), false);
    is(`${name}: it offers its waitlist instead`, shown.includes(w.tellMe), true);
    is(`${name}: the product beside it still shows its Buy button`, shown.includes(buy25), true);
    is(`${name}: and it never says buying is not available`, shown.includes(UNREAD), false);
  }
  await real([["SREM", soonKey, app.product.id]]);

  for (const [reading, reply] of [
    ["a failed request", () => Promise.reject(new Error("synthetic Redis failure"))],
    ["no reply at all", () => []],
    ["a word for the list", () => ["QUEUED", []]],
    ["a map for the list", () => [{ [app.product.id]: 1 }, []]],
  ] as const) {
    part(`Coming soon unknown: ${reading}`);
    inject = reply;
    is("soonState says the reading is unknown", await soonState(store).then(() => "known", () => "unknown"), "unknown");
    for (const [name, draw] of pages) {
      const shown = text(await draw());
      is(`${name}: no Buy button for a product that may be coming soon`, shown.includes(buy40), false);
      is(`${name}: nor for the one beside it, whose state is unknown too`, shown.includes(buy25), false);
      is(`${name}: says buying is not available just now`, shown.includes(UNREAD), true);
      is(`${name}: nothing can go in the cart`, shown.includes(cw.add), false);
      is(`${name}: never offers a waitlist it cannot know is right`, shown.includes(w.tellMe), false);
      is(`${name}: the products' titles are still shown`, shown.includes("Desktop app") && shown.includes("Field guide"), true);
    }
    is("the collection page offers no 'add all' either", text(await pages[1][1]()).includes(cw.addAll(2)), false);
    inject = null;
  }

  part("Coming soon read in part: a member that is not a product id");
  inject = () => [[1], []];
  is("soonState says only part of it was read", (await soonState(store)).partial, true);
  for (const [name, draw] of pages) {
    const shown = text(await draw());
    is(`${name}: no Buy button for either product`, shown.includes(buy40) || shown.includes(buy25), false);
    is(`${name}: says buying is not available just now`, shown.includes(UNREAD), true);
    is(`${name}: nothing can go in the cart`, shown.includes(cw.add), false);
    is(`${name}: never offers a waitlist it cannot know is right`, shown.includes(w.tellMe), false);
  }
  is("the collection page offers no 'add all' either", text(await pages[1][1]()).includes(cw.addAll(2)), false);

  part("Coming soon read in part: one product read as coming soon, a member beside it unreadable");
  inject = () => [[app.product.id, null], []];
  const partly = await soonState(store);
  is("soonState keeps the product it read as coming soon", partly.soon.has(app.product.id), true);
  is("and says only part of it was read", partly.partial, true);
  for (const [name, draw] of pages) {
    const shown = text(await draw());
    is(`${name}: the product read as coming soon still offers its waitlist`, shown.includes(w.tellMe), true);
    is(`${name}: and no Buy button`, shown.includes(buy40), false);
    is(`${name}: the other product shows no Buy button either`, shown.includes(buy25), false);
    is(`${name}: and says buying is not available just now`, shown.includes(UNREAD), true);
    is(`${name}: nothing can go in the cart`, shown.includes(cw.add), false);
  }
  inject = null;

  part("Control: a reply read whole is not partial");
  is("soonState is not partial when every member is read", (await soonState(store)).partial, undefined);

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
