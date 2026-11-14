/**
 * "Delete my review" asks first (Claude 6's audit 21, HIGH; WCAG 3.3.4 AA and 3.3.6 AAA). The button used to delete
 * the buyer's stars, words and photo at the first press, with no question and no way back. Now:
 *
 *   - the first press (a plain form, no JavaScript needed) changes nothing: the route answers "confirmDelete" before
 *     the rate limits and before any call to Stripe, so asking costs no paid call and no slot of an hour's tries;
 *   - the page then shows, in place of the button, a question that names the product and says exactly what goes (the
 *     rating with its number of stars, the words when there are any, the photo when there is one) and that it cannot
 *     be brought back; the answer's address points at that question, which takes focus (tabindex -1), so a screen
 *     reader reads it at once and a second Enter by mistake presses nothing;
 *   - only "Yes, delete my review" (confirm=yes) deletes; "Keep my review" is a link back to the same page that says
 *     the review was not deleted (a status, not an alert), with focus on that sentence;
 *   - a form from a page drawn before this change (action=delete with no confirm) is asked the question too.
 *
 * Synthetic store, buyer, order and photo only; Stripe and the file store are stand-ins.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/review/route";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readReview, reviewId } from "@/lib/reviews";
import { REVIEW_NOTICES, ReviewForm } from "@/components/review-form";
import { GIVING_WORDS } from "@/lib/buyer-words/giving";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { files } from "./failure-cleanup-world";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_review_delete_confirm_only";

const OWNER = "delete-confirm@example.com";
const HANDLE = "delete-confirm-shop";
const ACCOUNT = "acct_1TestDelConf001";
const SESSION = "cs_test_reviewdeleteconfirm001";
const BUYER = "buyer-delete@example.com";

let productId = "";
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.stripe.com") stripeCalls += 1;
  if (url.hostname === "api.stripe.com" && url.pathname === `/v1/checkout/sessions/${SESSION}`) {
    return Response.json({
      id: SESSION,
      status: "complete",
      payment_status: "paid",
      amount_total: 1000,
      created: Math.floor(Date.now() / 1000) - 3600,
      mode: "payment",
      metadata: { store: HANDLE, product: productId },
      customer_details: { email: BUYER },
      payment_intent: { id: "pi_ReviewDeleteConf01", latest_charge: { refunded: false, amount_refunded: 0 } },
    });
  }
  return Response.json({ error: { message: "not in this test" } }, { status: 404 });
}) as typeof fetch;

function jpeg(width: number, height: number): string {
  const bytes = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, ...new Array(12).fill(0)];
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

async function send(fields: Record<string, string>, back = "review") {
  const form = new FormData();
  for (const [k, v] of Object.entries({ handle: HANDLE, product: productId, session_id: SESSION, back, ...fields })) form.set(k, v);
  return POST(new NextRequest("https://marktmorgen.com/api/store/review", { method: "POST", body: form, headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com" } }));
}
const where = (res: Response) => new URL(res.headers.get("location") ?? "https://x/");
const statusOf = (res: Response) => where(res).searchParams.get("status") ?? where(res).searchParams.get("review");

type Words = Record<string, unknown>;
const word = (code: keyof typeof GIVING_WORDS, key: string) => (GIVING_WORDS[code] as unknown as Words)[key];

async function main() {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Delete Confirm Shop", "");
  await ensureStatsId(OWNER);
  const linked = await setStripeAccount(OWNER, ACCOUNT, true);
  if (!linked.ok) throw new Error(`no account: ${linked.reason}`);
  const added = await addProduct(OWNER, "Sourdough course", "Bread in a week.", "10");
  if (!("product" in added) || !added.product) throw new Error("no product");
  productId = (added as { product: { id: string } }).product.id;
  await setSubscription(OWNER, { customerId: "cus_ReviewDeleteConf", subscriptionId: "sub_ReviewDeleteConf", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId as string;
  const id = reviewId(statsId, productId, BUYER);

  is("set-up: the review is written with stars, words and a photo", statusOf(await send({ rating: "4", text: "Good loaves.", photo: jpeg(1200, 900) })), "saved");
  const written = await readReview(statsId, productId, id);
  const photoPath = written?.photo?.path ?? "";
  is("set-up: all three are kept", { rating: written?.rating, text: written?.text, photo: files.has(photoPath) }, { rating: 4, text: "Good loaves.", photo: true });

  part("The first press of \"Delete my review\" changes nothing (3.3.4, 3.3.6)");
  stripeCalls = 0;
  const asked = await send({ action: "delete" });
  is("the answer asks first", statusOf(asked), "confirmDelete");
  is("the address points at the question", where(asked).hash, `#r-${productId}-delete`);
  const after = await readReview(statsId, productId, id);
  is("the stars, the words and the photo are all still there", { rating: after?.rating, text: after?.text, photo: after?.photo?.path === photoPath && files.has(photoPath) }, { rating: 4, text: "Good loaves.", photo: true });
  is("asking made no call to Stripe", stripeCalls, 0);
  is("from the thanks page too", statusOf(await send({ action: "delete" }, "thanks")), "confirmDelete");
  is("and still nothing deleted", (await readReview(statsId, productId, id))?.text, "Good loaves.");
  is("a confirm that is not exactly yes still only asks", statusOf(await send({ action: "delete", confirm: "true" })), "confirmDelete");

  part("The page asks in plain words what will go, and offers to keep it");
  const existing = await readReview(statsId, productId, id);
  const draw = (notice: string | null, lang: keyof typeof GIVING_WORDS = "en") =>
    renderToStaticMarkup(
      createElement(ReviewForm, {
        handle: HANDLE,
        door: { session_id: SESSION },
        product: { id: productId, title: "Sourdough course" },
        existing,
        storeName: "Delete Confirm Shop",
        back: "review",
        notice,
        lang,
      }),
    );
  const plain = draw(null);
  is("before: the delete form carries no yes", plain.includes('name="confirm"'), false);
  is("before: no question yet", plain.includes(`id="r-${productId}-delete"`), false);
  const page = draw("confirmDelete");
  const ask = word("en", "deleteReviewAsk");
  const what = word("en", "deleteReviewWhat");
  is("the question names the product", typeof ask === "function" && page.includes((ask as (t: string) => string)("Sourdough course").replace(/'/g, "&#x27;")), true);
  is("it says what goes: the 4 stars, the words and the photo, from the store's page, for good",
    typeof what === "function" && page.includes((what as (s: number, w: boolean, p: boolean, st: string) => string)(4, true, true, "Delete Confirm Shop").replace(/'/g, "&#x27;")), true);
  is("the question takes focus when the page opens on it", new RegExp(`id="r-${productId}-delete"[^>]*tabindex="-1"|tabindex="-1"[^>]*id="r-${productId}-delete"`).test(page), true);
  is("only the yes button sends confirm=yes", (page.match(/name="confirm" value="yes"/g) ?? []).length, 1);
  is("the yes button says what it does", typeof word("en", "deleteReviewYes") === "string" && page.includes(String(word("en", "deleteReviewYes"))), true);
  is("the first delete button is gone while asking", page.includes(`>${GIVING_WORDS.en.deleteReview}<`), false);
  const keepHref = page.match(/<a[^>]*href="([^"]*status=kept[^"]*)"/)?.[1]?.replace(/&amp;/g, "&") ?? "";
  is("\"Keep my review\" is a plain link back to this page", keepHref.startsWith(`/@${HANDLE}/review?`), true);
  is("it keeps what proves the order and names the product", new URL(keepHref, "https://x").searchParams.get("session_id") === SESSION && new URL(keepHref, "https://x").searchParams.get("product") === productId, true);
  is("it points at the sentence that says nothing was deleted", new URL(keepHref, "https://x").hash, `#r-${productId}-said`);
  is("the keep link is the form's own words", typeof word("en", "deleteReviewKeep") === "string" && page.includes(String(word("en", "deleteReviewKeep"))), true);
  is("no alert is shown for the question itself", /role="alert"/.test(page), false);

  const kept = draw("kept");
  is("kept: a status sentence, not an alert", REVIEW_NOTICES.kept, { text: GIVING_WORDS.en.reviewNotices.kept });
  is("kept: the sentence takes focus", new RegExp(`id="r-${productId}-said"[^>]*tabindex="-1"|tabindex="-1"[^>]*id="r-${productId}-said"`).test(kept), true);
  is("kept: the form is back with its delete button", kept.includes(`>${GIVING_WORDS.en.deleteReview}<`), true);
  const thanks = renderToStaticMarkup(createElement(ReviewForm, { handle: HANDLE, door: { session_id: SESSION }, product: { id: productId, title: "Sourdough course" }, existing, storeName: "Delete Confirm Shop", back: "thanks", notice: "confirmDelete" }));
  const thanksKeep = new URL((thanks.match(/<a[^>]*href="([^"]*)"[^>]*>[^<]*Keep/)?.[1] ?? "").replace(/&amp;/g, "&"), "https://x");
  is("from the thanks page the link goes back to the thanks page", [thanksKeep.pathname, thanksKeep.searchParams.get("review"), thanksKeep.searchParams.get("session_id")], [`/@${HANDLE}/thanks`, "kept", SESSION]);

  part("Only the yes deletes");
  is("yes: deleted", statusOf(await send({ action: "delete", confirm: "yes" })), "deleted");
  is("the review is gone", await readReview(statsId, productId, id), null);
  is("its photo is deleted with it", files.has(photoPath), false);

  part("Every buyer language says it");
  const keys = ["deleteReviewAsk", "deleteReviewWhat", "deleteReviewYes", "deleteReviewKeep"];
  is("each language has the question, the list, the yes and the keep", Object.keys(GIVING_WORDS).filter((code) => !keys.every((k) => word(code as keyof typeof GIVING_WORDS, k) !== undefined)), []);
  is("each language has both notices", Object.values(GIVING_WORDS).every((w) => ["confirmDelete", "kept"].every((k) => typeof (w.reviewNotices as Record<string, string>)[k] === "string")), true);
  const one = word("en", "deleteReviewWhat");
  is("with no words and no photo, only the rating is named", typeof one === "function" ? (one as (s: number, w: boolean, p: boolean, st: string) => string)(1, false, false, "Shop") : "", "This deletes your 1-star rating from Shop's page. It cannot be brought back.");
  is("German in the formal register", typeof word("de", "deleteReviewWhat") === "function" && /\bIhre\b/.test((word("de", "deleteReviewWhat") as (s: number, w: boolean, p: boolean, st: string) => string)(4, true, true, "Laden")), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
