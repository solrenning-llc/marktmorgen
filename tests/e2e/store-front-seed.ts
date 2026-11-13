/**
 * The stores tests/e2e/store-front-audit.mjs opens, written through the
 * studio's own functions into the stand-in database of tests/e2e/services.mjs.
 * Synthetic only: example.com addresses, fixture account ids, no real service.
 *
 *   - a11yfront: a full store. Nine products in two sections (preview, callout
 *     and thumbnail cards; free; limited "3 left"; sold out; coming soon), two
 *     collections, a line of news, two reviews and "What buyers say", a links
 *     block with a heading, two questions, a blog and affiliates.
 *   - a11yempty: a store with nothing in it.
 *   - a11ylong: thirty products, so a second page and a search.
 *   - a11yedge: the two cases asked for in the review of PR #2987. A product
 *     whose title is one letter, with no summary and no details (so no
 *     "Read more"), and text made of narrow letters (i, l, t, f, j, r) at the
 *     longest each field allows: the bio, a product's title and summary with
 *     details, a question (up to MAX_FAQ_Q) and a question's answer. Narrow
 *     letters fit more characters on a line than the average a width
 *     estimate assumes (WCAG 1.4.8).
 *
 * Prints one JSON line at the end: the full store's product ids and the
 * segment of its first collection.
 */
import {
  addProduct, addStoreLink, claimHandle, ensureStatsId, setAffiliateSetting, setAnnouncement, setCollections, setFaq, setPostCount,
  setProductAbout, setProductDisplay, setProductExtras, setProductImage, setProductLink, setReviewed, setSections, setStripeAccount,
  setSubscription, storeForEmail,
} from "@/lib/store";
import { saveReview } from "@/lib/reviews";
import { setSoon } from "@/lib/waitlist";
import { refreshStoreQuotes } from "@/lib/store-quotes";
import { redisPipeline } from "@/lib/redis";
import { collectionSegment } from "@/lib/store-collections";
import { MAX_SUMMARY_LENGTH, MAX_TITLE_LENGTH } from "@/lib/catalog-rules";
import { MAX_BIO_LENGTH } from "@/lib/store-field-rules";
import { MAX_FAQ_Q } from "@/lib/store-faq";

const FULL = "front-owner@example.com", EMPTY = "empty-owner@example.com", LONG = "long-owner@example.com", EDGE = "edge-owner@example.com";

/** Words of narrow letters only, cut at a word boundary to at most `length` characters. */
function narrowText(length: number): string {
  const words = ["little", "lilt", "fill", "till", "it", "is", "ill-lit", "if", "jilt", "slit", "tilt", "rill", "frill", "lift", "flit", "rift", "trill", "jilts", "fit"];
  let text = "";
  for (let n = 0; ; n++) {
    const next = (text ? text + " " : "") + words[n % words.length];
    if (next.length > length) return text;
    text = next;
  }
}

async function open(owner: string, handle: string, name: string, bio: string, account: string) {
  const claimed = await claimHandle(owner, handle, name, bio);
  if (!claimed.ok) throw new Error(`${handle} refused: ${claimed.reason}`);
  const seeded = await ensureStatsId(owner);
  if (!seeded?.statsId) throw new Error("no statsId");
  await setStripeAccount(owner, account, true);
  await setSubscription(owner, { active: true, tier: "creator", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 });
  return seeded;
}

async function made(owner: string, title: string, summary: string, price: string): Promise<string> {
  const result = await addProduct(owner, title, summary, price, null);
  if (!result.ok) throw new Error(`${title} refused: ${result.reason}`);
  const linked = await setProductLink(owner, result.product.id, `https://example.com/${result.product.id}`);
  if (!linked.ok) throw new Error(`${title} link refused`);
  return result.product.id;
}

async function main(): Promise<void> {
  const seeded = await open(FULL, "a11yfront", "Quiet Oven", "Bread at home, one loaf at a time. A store on this computer only.", "acct_fixtureFront01");
  const ids: Record<string, string> = {};
  ids.cover = await made(FULL, "Starter Loaf Guide", "Your first sourdough loaf in three days, step by step.", "19");
  await setProductImage(FULL, ids.cover, { path: `images/${"a".repeat(24)}/${"f".repeat(32)}.jpg`, width: 1200, height: 800, alt: "A round sourdough loaf on a board", bytes: 1, small: null });
  await setProductDisplay(FULL, ids.cover, "preview");
  await setProductAbout(FULL, ids.cover, true);
  ids.callout = await made(FULL, "Rye Week", "Seven days of rye, one bake a day.", "29");
  await setProductImage(FULL, ids.callout, { path: `images/${"a".repeat(24)}/${"e".repeat(32)}.jpg`, width: 1200, height: 900, alt: "A sliced dark rye loaf", bytes: 1, small: null });
  await setProductDisplay(FULL, ids.callout, "callout");
  await setProductAbout(FULL, ids.callout, true);
  ids.thumb = await made(FULL, "Crust Notes", "How to get a crackling crust in a home oven.", "9");
  await setProductImage(FULL, ids.thumb, { path: `images/${"a".repeat(24)}/${"d".repeat(32)}.jpg`, width: 800, height: 800, alt: "A loaf with a dark crust", bytes: 1, small: null });
  await setProductAbout(FULL, ids.thumb, true);
  ids.plain = await made(FULL, "Bread Basics Workbook", "Twelve pages to fill in while you bake.", "14");
  await setProductAbout(FULL, ids.plain, true);
  ids.free = await made(FULL, "Flour Cheat Sheet", "Which flour for which bread, on one page.", "0");
  ids.limited = await made(FULL, "Signed Recipe Card", "A printed card, signed, three left in the run.", "12");
  if (!(await setProductExtras(FULL, ids.limited, { stock: 3 })).ok) throw new Error("stock");
  ids.soldOut = await made(FULL, "Workshop Apron", "The apron from the workshop, now sold out.", "35");
  if (!(await setProductExtras(FULL, ids.soldOut, { stock: 1 })).ok) throw new Error("stock");
  await redisPipeline([["HSET", `nl:stock:${seeded.statsId}:${ids.soldOut}`, "cs_test_apron1", JSON.stringify({ until: 0, paid: true })]]);
  ids.soon = await made(FULL, "Pizza Weekend", "Two days of pizza dough, coming this winter.", "25");

  for (const [n, rating, text] of [[1, 5, "The loaf finally rose for me."], [2, 4, "Clear steps; day two took me longer."]] as const) {
    const saved = await saveReview(seeded.statsId!, { productId: ids.cover, email: `front${n}@example.com`, reference: `cs_test_front${n}`, pi: `pi_front${n}`, rating, text, name: `Baker ${n}` }, seeded, Date.now() - (10 - n) * 86_400_000);
    if (saved.state !== "created") throw new Error(`review ${n}: ${saved.state}`);
  }
  await setReviewed(FULL);
  const sections = await setSections(FULL, [{ title: "Guides", at: ids.cover }, { title: "Things to hold", at: ids.limited }]);
  if (!sections.ok) throw new Error("sections " + sections.reason);
  const collections = await setCollections(FULL, [{ title: "Sourdough", blurb: "", products: [ids.cover, ids.callout] }, { title: "Free things", blurb: "", products: [ids.free] }]);
  if (!collections.ok) throw new Error("collections " + collections.reason);
  const news = await setAnnouncement(FULL, { text: "New: Rye Week, one bake a day", product: ids.callout });
  if (!news.ok) throw new Error("news");
  await addStoreLink(FULL, "Elsewhere", "", { header: true });
  await addStoreLink(FULL, "The bread podcast", "https://example.com/podcast");
  await addStoreLink(FULL, "Weekly letter", "https://example.org/letter");
  await setFaq(FULL, [{ q: "Do I need a starter?", a: "Yes. Every guide shows how to wake one up." }, { q: "Is there a refund?", a: "Within 14 days, if nothing was opened." }]);
  await setPostCount(FULL, 2);
  await setAffiliateSetting(FULL, { enabled: true, percent: 20, days: 30, rates: {} } as never);
  const full = await storeForEmail(FULL);
  if (!full) throw new Error("no store");
  await setSoon(full, ids.soon, true);
  await refreshStoreQuotes(full).catch(() => undefined);

  await open(EMPTY, "a11yempty", "Empty Shelf", "", "acct_fixtureEmpty1");

  await open(LONG, "a11ylong", "Long Pantry", "Thirty recipes, one at a time.", "acct_fixtureLong01");
  for (let n = 1; n <= 30; n++) {
    const id = await made(LONG, `Pantry recipe ${n}`, `Recipe number ${n}, with what is in the cupboard.`, "3");
    if (n % 3 === 0) await setProductAbout(LONG, id, true);
  }

  // The review's two cases (PR #2987): a one-letter title without details, and narrow-letter text at full length.
  await open(EDGE, "a11yedge", "Thin Type", narrowText(MAX_BIO_LENGTH), "acct_fixtureEdge01");
  await made(EDGE, "Q", "", "5");
  const narrow = await made(EDGE, narrowText(MAX_TITLE_LENGTH), narrowText(MAX_SUMMARY_LENGTH), "7");
  await setProductAbout(EDGE, narrow, true);
  await made(EDGE, "Plain neighbor", "A product of ordinary words, so the grid has more than the two cases.", "9");
  const faq = await setFaq(EDGE, [{ q: "Is it little?", a: narrowText(400) }, { q: narrowText(MAX_FAQ_Q), a: "A question at the longest a question can be." }]);
  if (!faq?.faq?.length) throw new Error("edge faq");

  console.log(JSON.stringify({ ids, coll: collectionSegment(collections.store.collections![0]) }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
