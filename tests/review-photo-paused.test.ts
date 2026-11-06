/**
 * 232 [CA1] unit 4b1: while a store's plan renewal is unpaid (or its plan
 * payment disputed), a buyer's review photo is new storage nobody is paying
 * for. The review route still saves the words, does not read or store the
 * photo, and tells the buyer; a store that is paid up checks and keeps photos
 * as before.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/review/route";
import { addProduct, claimHandle, ensureStatsId, recordPlanDispute, setStripeAccount, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { readReview, reviewId, setReviewPhoto } from "@/lib/reviews";
import { costsPaused } from "@/lib/plan-standing";
import { reviewPhotoPath } from "@/lib/review-photo";
import { REVIEW_NOTICES } from "@/components/review-form";
import { GIVING_WORDS } from "@/lib/buyer-words/giving";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_review_photo_paused_only";

const OWNER = "photo-paused@example.com";
const HANDLE = "photo-paused-shop";
const ACCOUNT = "acct_1TestPhotoP001";
const SESSION = "cs_test_reviewphotopaused0001";
const BUYER = "buyer-photo@example.com";

let productId = "";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
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
      payment_intent: { id: "pi_ReviewPhotoPaused01", latest_charge: { refunded: false, amount_refunded: 0 } },
    });
  }
  return Response.json({ error: { message: "not in this test" } }, { status: 404 });
}) as typeof fetch;

/** A JPEG's first bytes, enough to be read (as in tests/review-photo.test.ts). */
function jpeg(width: number, height: number): string {
  const bytes = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, ...new Array(12).fill(0)];
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

function send(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ handle: HANDLE, product: productId, session_id: SESSION, back: "review", rating: "5", text: "Great recipes.", ...fields })) form.set(k, v);
  return POST(new NextRequest("https://marktmorgen.com/api/store/review", { method: "POST", body: form, headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com" } }));
}
const statusOf = (res: Response) => { return new URL(res.headers.get("location") ?? "https://x/").searchParams.get("status"); };

async function main() {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Photo Paused Shop", "");
  await ensureStatsId(OWNER);
  const linked = await setStripeAccount(OWNER, ACCOUNT, true);
  if (!linked.ok) throw new Error(`no account: ${linked.reason}`);
  const added = await addProduct(OWNER, "Weeknight recipes", "Thirty dinners.", "10");
  if (!("product" in added) || !added.product) throw new Error("no product");
  productId = (added as { product: { id: string } }).product.id;

  part("Renewal unpaid: the words are saved, the photo is not, and the buyer is told");
  await setSubscription(OWNER, { customerId: "cus_ReviewPhotoPause", subscriptionId: "sub_ReviewPhotoPause", active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: true });
  let store = (await storeForEmail(OWNER))!;
  is("the store's costs are paused", costsPaused(store), true);
  const paused = await send({ photo: jpeg(1200, 900) });
  is("answered with the photo notice", statusOf(paused), "photoPaused");
  // A photo that could not even be read is not looked at either: nothing of it was handled.
  is("an unreadable photo gets the same answer, so it was never checked or stored", statusOf(await send({ photo: "data:image/jpeg;base64,<not-a-photo>", text: "Great recipes." })), "photoPaused");
  store = (await storeForEmail(OWNER))!;
  const id = reviewId(store.statsId as string, productId, BUYER);
  const review = await readReview(store.statsId as string, productId, id);
  is("the review's words were saved", review?.text, "Great recipes.");
  is("with no photo", review?.photo ?? null, null);
  is("the notice is a done notice, not an alert", REVIEW_NOTICES.photoPaused, { text: GIVING_WORDS.en.reviewNotices.photoPaused });
  is("every buyer language says it", Object.values(GIVING_WORDS).every((w) => typeof (w.reviewNotices as Record<string, string>).photoPaused === "string"), true);
  is("German in the formal register", /\bIhre\b/.test((GIVING_WORDS.de.reviewNotices as Record<string, string>).photoPaused), true);

  part("A photo already on the review stays while paused");
  const earlier = { path: await reviewPhotoPath(storeRef(store), "image/jpeg"), width: 1200, height: 900 };
  await setReviewPhoto(store.statsId as string, productId, id, earlier);
  is("a new photo is not added", statusOf(await send({ photo: jpeg(1200, 900) })), "photoPaused");
  is("and the earlier one is still there", (await readReview(store.statsId as string, productId, id))?.photo, earlier);

  part("No photo sent: the usual answer");
  const noPhoto = await send({ text: "Still great." });
  is("updated, not the photo notice", statusOf(noPhoto), "updated");

  part("Paid up again: the photo path is tried as before");
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", period: paidPeriod(), renewalUnpaid: false });
  store = (await storeForEmail(OWNER))!;
  is("costs no longer paused", costsPaused(store), false);
  is("an unreadable photo is checked again, and refused", statusOf(await send({ photo: "data:image/jpeg;base64,<not-a-photo>" })), "photo");

  part("A plan payment disputed with the bank pauses it the same way");
  const disputed = await recordPlanDispute(storeRef(store), { id: "du_ReviewPhotoPause1", status: "open", at: Math.floor(Date.now() / 1000), coversUntil: Math.floor(Date.now() / 1000) + 30 * 86_400 });
  is("the dispute is written down", Boolean(disputed), true);
  store = (await storeForEmail(OWNER))!;
  is("costs paused by the dispute", costsPaused(store), true);
  is("the photo is not read", statusOf(await send({ photo: "data:image/jpeg;base64,<not-a-photo>" })), "photoPaused");
  is("the creator is told in the same words", (await import("@/lib/plan-dispute-rules")).DISPUTE_PAUSED_WORDS.includes("your buyers' review photos included"), true);

  done();
}

main();
