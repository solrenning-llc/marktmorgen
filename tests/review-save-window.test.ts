/**
 * Claude 5 iZByNH's MEDIUM on #5400 @da7e353e9d (7112752228): the orders page's door (token + ref) proved an order of
 * any age, so an order paid 400 days ago saved its first review and rewrote it the next store month. Every order a store
 * ever took could then write once each month, and the line "review-writes" (tests/plan-cost-registry.ts), which prices
 * REVIEW_DOOR_MONTHS store months of orders, was no worst-month ceiling. A review is now saved or changed only within
 * REVIEW_SAVE_SECONDS of the order (MAX_ASK_DAYS + REVIEW_LINK_SECONDS), through every door; deleting is never refused.
 *
 * Synthetic store, buyers and orders; in-memory Redis; Stripe stood in; no network.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { POST } from "@/app/api/store/review/route";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readReview, reviewId, saveReview } from "@/lib/reviews";
import { ordersLinkFor } from "@/lib/buyer-orders";
import { MAX_ASK_DAYS } from "@/lib/review-ask";
import { REVIEW_LINK_SECONDS, REVIEW_SAVE_SECONDS } from "@/lib/review-proof";
import { GIVING_WORDS } from "@/lib/buyer-words/giving";
import { ReviewForm } from "@/components/review-form";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_review_save_window_only";

const OWNER = "review-save-window@example.com";
const HANDLE = "review-save-window";
const ACCOUNT = "acct_1TestRevWindow";
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
/** Orders paid this many days ago, each by its own buyer. */
const ORDERS = [
  { session: "cs_test_reviewsavewindow0400", buyer: "old-buyer@example.com", pi: "pi_ReviewSaveWindow400", days: 400 },
  { session: "cs_test_reviewsavewindow0089", buyer: "recent-buyer@example.com", pi: "pi_ReviewSaveWindow089", days: 89 },
  { session: "cs_test_reviewsavewindow0091", buyer: "late-buyer@example.com", pi: "pi_ReviewSaveWindow091", days: 91 },
];

let productId = "";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const asked = ORDERS.find((o) => url.pathname === `/v1/checkout/sessions/${o.session}`);
  if (url.hostname === "api.stripe.com" && asked) {
    return Response.json({
      id: asked.session,
      status: "complete",
      payment_status: "paid",
      amount_total: 1000,
      created: now() - asked.days * DAY,
      mode: "payment",
      metadata: { store: HANDLE, product: productId },
      customer_details: { email: asked.buyer },
      payment_intent: { id: asked.pi, latest_charge: { refunded: false, amount_refunded: 0 } },
    });
  }
  return Response.json({ error: { message: "not in this test" } }, { status: 404 });
}) as typeof fetch;

async function send(fields: Record<string, string>): Promise<string | null> {
  afterTasks.length = 0;
  const form = new FormData();
  for (const [k, v] of Object.entries({ handle: HANDLE, product: productId, back: "review", ...fields })) form.set(k, v);
  const res = await POST(new NextRequest("https://marktmorgen.com/api/store/review", { method: "POST", body: form, headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com" } }));
  for (const task of afterTasks.splice(0)) await (task as () => Promise<unknown>)();
  return new URL(res.headers.get("location") ?? "https://x/").searchParams.get("status");
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Review Save Window", "");
  await ensureStatsId(OWNER);
  const linked = await setStripeAccount(OWNER, ACCOUNT, true);
  if (!linked.ok) throw new Error(`no account: ${linked.reason}`);
  const added = await addProduct(OWNER, "Sourdough course", "Bread in a week.", "10");
  if (!("product" in added) || !added.product) throw new Error("no product");
  productId = (added as { product: { id: string } }).product.id;
  await setSubscription(OWNER, { customerId: "cus_ReviewSaveWindow", subscriptionId: "sub_ReviewSaveWindow", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId as string;
  const tokenFor = async (email: string) => new URL((await ordersLinkFor(store, email, `https://marktmorgen.com/@${HANDLE}`))!).searchParams.get("token")!;

  part("The window is the ask's and the link's, in days");
  is("REVIEW_SAVE_SECONDS is MAX_ASK_DAYS and the link's days", REVIEW_SAVE_SECONDS, MAX_ASK_DAYS * DAY + REVIEW_LINK_SECONDS);
  is("the buyer is told the same number of days", GIVING_WORDS.en.reviewNotices.late.includes(`${REVIEW_SAVE_SECONDS / DAY} days`), true);

  part("An order paid 400 days ago, through the orders page: nothing is saved, and deleting still works");
  const [old, recent, late] = ORDERS;
  const oldToken = await tokenFor(old.buyer);
  const oldId = reviewId(statsId, productId, old.buyer);
  is("a first review is refused, in plain words", await send({ token: oldToken, ref: old.session, rating: "5", text: "Lovely bread.", name: "Old Buyer" }), "late");
  is("and nothing was kept", await readReview(statsId, productId, oldId), null);
  const kept = await saveReview(statsId, { productId, email: old.buyer, reference: old.session, pi: old.pi, rating: 4, text: "Saved back then.", name: "Old Buyer" }, ROOM);
  is("(a review saved back then, when the order was new)", kept.state, "created");
  is("rewriting it is refused too", await send({ token: oldToken, ref: old.session, rating: "1", text: "Changed now.", name: "Old Buyer" }), "late");
  is("and it keeps its words", (await readReview(statsId, productId, oldId))?.text ?? null, "Saved back then.");
  is("deleting it is never refused", await send({ token: oldToken, ref: old.session, action: "delete", confirm: "yes" }), "deleted");
  is("and it is gone", await readReview(statsId, productId, oldId), null);

  part("The edges: 89 days saves, 91 days does not");
  is("an order paid 89 days ago saves its review", await send({ token: await tokenFor(recent.buyer), ref: recent.session, rating: "5", text: "Still fresh.", name: "Recent Buyer" }), "saved");
  is("an order paid 91 days ago does not", await send({ token: await tokenFor(late.buyer), ref: late.session, rating: "5", text: "A bit late.", name: "Late Buyer" }), "late");

  part("The review page draws no fields it could not save: a closed order says why, and deleting stays");
  const draw = (closed: boolean, existing: Awaited<ReturnType<typeof readReview>>) =>
    renderToStaticMarkup(createElement(ReviewForm, { handle: HANDLE, door: { token: oldToken, ref: old.session }, product: { id: productId, title: "Sourdough course" }, existing, storeName: "Review Save Window", back: "review", notice: null, closed }));
  const saved = await saveReview(statsId, { productId, email: old.buyer, reference: old.session, pi: old.pi, rating: 4, text: "Saved back then.", name: "Old Buyer" }, ROOM);
  const review = saved.state === "created" ? saved.review : null;
  const closedPage = draw(true, review);
  is("closed: no field to save", [closedPage.includes('value="save"'), closedPage.includes('name="rating"'), closedPage.includes("<textarea")], [false, false, false]);
  is("closed: it says why, in plain words", closedPage.includes(GIVING_WORDS.en.reviewNotices.late.replace(/'/g, "&#x27;")), true);
  is("closed: the review saved back then can still be deleted", closedPage.includes('value="delete"'), true);
  const openPage = draw(false, review);
  is("open: the fields are there, as before", [openPage.includes('value="save"'), openPage.includes("<textarea")], [true, true]);

  part("The words, in every language the site speaks");
  for (const [language, words] of Object.entries(GIVING_WORDS)) {
    is(`${language}: the refusal names the days and says a review can still be deleted`, typeof words.reviewNotices.late === "string" && words.reviewNotices.late.includes("90"), true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
