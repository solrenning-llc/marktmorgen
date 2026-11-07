/**
 * A ceiling on the photos one review can take (Claude 4, C4-20261106-2720-C5-160). Every new review photo is a put
 * to Vercel Blob, a paid operation the SDK may retry, made before anything else; the only ceilings were the store's
 * public figure and ten changes per order an hour, so one buyer could make many puts. Now:
 *
 *   - each review takes at most MAX_REVIEW_PHOTOS new photos over its whole life, counted on the review's own
 *     record (photoPuts) and on a hash beside it, by the write the review already makes (one more read and write in
 *     the same requests), under the product's lock;
 *   - the slot is granted by that write BEFORE the put; a write that fails, is busy or has no room never puts;
 *   - a photo past the ceiling is not stored, the words are, and the buyer is told so in plain words;
 *   - a put that fails after its slot was granted keeps the slot used (the cost side fails closed), the words stay
 *     saved and the buyer is told the photo was not added;
 *   - taking a photo off needs no put and no slot;
 *   - a counter that cannot be read is taken as the ceiling, never as zero;
 *   - deleting the review and writing it again does not reset the count (review M1 on #2863): the count is also kept
 *     on its own hash beside the product's reviews, which a buyer's delete leaves in place; it goes with a person's
 *     erasure (second review of #2863: the id is computed again from their address), with the product's reviews
 *     (dropReviews) or with the store;
 *   - no helper puts a review photo without a slot.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/review/route";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { dropReviews, forgetReviewsPerson, parseReview, readReview, reviewId } from "@/lib/reviews";
import * as summaryRules from "@/lib/review-summary";
import * as reviewPhoto from "@/lib/review-photo";
import { REVIEW_NOTICES } from "@/components/review-form";
import { GIVING_WORDS } from "@/lib/buyer-words/giving";
import { PERSON_DATA } from "@/lib/person-data";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { blobControl } from "./review-photo-limit-blob";
import { files } from "./failure-cleanup-world";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_review_photo_limit_only";

const OWNER = "photo-limit@example.com";
const HANDLE = "photo-limit-shop";
const ACCOUNT = "acct_1TestPhotoL001";
const SESSIONS: Record<string, { email: string; pi: string }> = {
  cs_test_reviewphotolimit00001: { email: "buyer-one@example.com", pi: "pi_ReviewPhotoLimit01" },
  cs_test_reviewphotolimit00002: { email: "buyer-two@example.com", pi: "pi_ReviewPhotoLimit02" },
};
const [ONE, TWO] = Object.keys(SESSIONS);

let productId = "";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const session = url.pathname.replace("/v1/checkout/sessions/", "");
  if (url.hostname === "api.stripe.com" && SESSIONS[session]) {
    return Response.json({
      id: session,
      status: "complete",
      payment_status: "paid",
      amount_total: 1000,
      created: Math.floor(Date.now() / 1000) - 3600,
      mode: "payment",
      metadata: { store: HANDLE, product: productId },
      customer_details: { email: SESSIONS[session].email },
      payment_intent: { id: SESSIONS[session].pi, latest_charge: { refunded: false, amount_refunded: 0 } },
    });
  }
  return Response.json({ error: { message: "not in this test" } }, { status: 404 });
}) as typeof fetch;

/** A JPEG's first bytes, enough to be read (as in tests/review-photo.test.ts). */
function jpeg(width: number, height: number): string {
  const bytes = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, ...new Array(12).fill(0)];
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

/** The order an hour allows ten changes; the ceiling under test is not that one, so each send starts a fresh hour. */
function forgetOrderHour(): void {
  for (const key of redis.keys()) if (key.includes("review-order")) redis.run(["DEL", key]);
}

async function send(session: string, fields: Record<string, string>) {
  forgetOrderHour();
  const form = new FormData();
  for (const [k, v] of Object.entries({ handle: HANDLE, product: productId, session_id: session, back: "review", rating: "5", text: "Great recipes.", ...fields })) form.set(k, v);
  return POST(new NextRequest("https://marktmorgen.com/api/store/review", { method: "POST", body: form, headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com" } }));
}
const statusOf = (res: Response) => new URL(res.headers.get("location") ?? "https://x/").searchParams.get("status");

async function main() {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Photo Limit Shop", "");
  await ensureStatsId(OWNER);
  const linked = await setStripeAccount(OWNER, ACCOUNT, true);
  if (!linked.ok) throw new Error(`no account: ${linked.reason}`);
  const added = await addProduct(OWNER, "Weeknight recipes", "Thirty dinners.", "10");
  if (!("product" in added) || !added.product) throw new Error("no product");
  productId = (added as { product: { id: string } }).product.id;
  await setSubscription(OWNER, { customerId: "cus_ReviewPhotoLimit", subscriptionId: "sub_ReviewPhotoLimit", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId as string;
  const idOne = reviewId(statsId, productId, SESSIONS[ONE].email);
  const idTwo = reviewId(statsId, productId, SESSIONS[TWO].email);
  const kept = (id: string) => readReview(statsId, productId, id);
  const MAX = (summaryRules as Record<string, unknown>).MAX_REVIEW_PHOTOS;

  part("The ceiling is a number of the code, the same everywhere");
  is("three new photos per review over its whole life", MAX, 3);

  part("A write that cannot be made never puts a photo");
  const lock = `nl:rev:lock:${statsId}:${productId}`;
  redis.run(["SET", lock, "someone-else", "EX", 60]);
  is("the product is busy: the buyer is told", statusOf(await send(ONE, { photo: jpeg(1200, 900) })), "busy");
  is("and no photo was put, not even one deleted after", blobControl.puts.length, 0);
  redis.run(["DEL", lock]);

  part("Healthy: the first photo, then two replacements");
  is("the first review with a photo is saved", statusOf(await send(ONE, { photo: jpeg(1200, 900) })), "saved");
  const first = (await kept(idOne))?.photo ?? null;
  is("its photo is on the review", Boolean(first && files.has(first.path)), true);
  is("one put", blobControl.puts.length, 1);
  is("the review counts one photo granted", (await kept(idOne) as unknown as { photoPuts?: number })?.photoPuts, 1);
  is("a second photo replaces it", statusOf(await send(ONE, { photo: jpeg(1000, 800), text: "Second photo." })), "updated");
  const second = (await kept(idOne))?.photo ?? null;
  is("the new one is on, the old one deleted", { on: second?.path !== first?.path && files.has(second?.path ?? ""), old: files.has(first?.path ?? "") }, { on: true, old: false });
  is("a third photo replaces it too", statusOf(await send(ONE, { photo: jpeg(900, 700), text: "Third photo." })), "updated");
  const third = (await kept(idOne))?.photo ?? null;
  is("three puts in all", blobControl.puts.length, 3);
  is("the review counts three", (await kept(idOne) as unknown as { photoPuts?: number })?.photoPuts, 3);

  part("Past the ceiling: the words are saved, the photo is not put");
  is("a fourth photo: the buyer is told it was not added", statusOf(await send(ONE, { photo: jpeg(800, 600), text: "Fourth try." })), "photoLimit");
  is("its words were saved", (await kept(idOne))?.text, "Fourth try.");
  is("the third photo is still the one shown", (await kept(idOne))?.photo, third);
  is("no fourth put", blobControl.puts.length, 3);
  is("a fifth photo: the same answer", statusOf(await send(ONE, { photo: jpeg(700, 500), text: "Fifth try." })), "photoLimit");
  is("still three puts", blobControl.puts.length, 3);
  is("the count stays at the ceiling", (await kept(idOne) as unknown as { photoPuts?: number })?.photoPuts, 3);
  is("an edit with no photo is the usual answer", statusOf(await send(ONE, { text: "Just words." })), "updated");

  part("Taking the photo off needs no put and no slot");
  is("removed", statusOf(await send(ONE, { photo_remove: "yes", text: "No photo now." })), "updated");
  is("the review has no photo", (await kept(idOne))?.photo ?? null, null);
  is("the old photo is deleted", files.has(third?.path ?? ""), false);
  is("no put for it", blobControl.puts.length, 3);
  is("over the review's whole life: a photo after it was taken off is not put either", statusOf(await send(ONE, { photo: jpeg(800, 600) })), "photoLimit");
  is("still three puts", blobControl.puts.length, 3);

  part("Deleting the review and writing it again does not reset the count (review M1 on #2863)");
  for (let round = 1; round <= 3; round += 1) {
    is(`round ${round}: the buyer deletes their review`, statusOf(await send(ONE, { action: "delete" })), "deleted");
    is(`round ${round}: the review is gone`, await kept(idOne), null);
    is(`round ${round}: written again with a photo, the words are saved and the photo is refused`, statusOf(await send(ONE, { photo: jpeg(800, 600), text: `Again ${round}.` })), "photoLimit");
    is(`round ${round}: no new put`, blobControl.puts.length, 3);
    is(`round ${round}: the new record carries the kept count`, (await kept(idOne) as unknown as { photoPuts?: number })?.photoPuts, 3);
  }
  const countKey = `nl:rev:${statsId}:${productId}:photos`;
  is("control: the buyer's own delete keeps the count", [statusOf(await send(ONE, { action: "delete" })), redis.run(["HGET", countKey, idOne])], ["deleted", "3"]);

  part("A person's erasure takes the count too (second review of #2863): nothing is left under an id their address gives again");
  is("erased with their review already deleted: no review to delete", (await forgetReviewsPerson(statsId, [productId], SESSIONS[ONE].email, store)).records, 0);
  is("the count under their id is gone", redis.run(["HGET", countKey, idOne]), null);
  is("written again after the erasure, a photo is a new review's first", statusOf(await send(ONE, { photo: jpeg(800, 600), text: "After erasure." })), "saved");
  is("one new put, inside a new slot", blobControl.puts.length, 4);
  const healthy = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const reply = await healthy(commands);
    // The count's deletion answered in an unknown shape; every other command as Redis answers it.
    return reply.map((r, i) => (commands[i][0] === "HDEL" && String(commands[i][1]).endsWith(":photos") ? "garbled" : r));
  }) as typeof redis.pipeline;
  const refused = await forgetReviewsPerson(statsId, [productId], SESSIONS[ONE].email, store).then(() => "done", (error: unknown) => (error as Error).name);
  redis.pipeline = healthy;
  is("the count's deletion answered in an unknown shape: the erasure is not said as done", refused, "UnknownReplyError");
  is("and the review, with its photo to delete, is still there for the erasure's next try", Boolean((await kept(idOne))?.photo), true);
  is("erased with the review there", (await forgetReviewsPerson(statsId, [productId], SESSIONS[ONE].email, store)).records, 1);
  is("its count goes with it", redis.run(["HGET", countKey, idOne]), null);

  part("A put that fails after its slot was granted");
  blobControl.fail = true;
  is("the buyer is told the photo was not added", statusOf(await send(TWO, { photo: jpeg(1200, 900), text: "Words from two." })), "photoFailed");
  blobControl.fail = false;
  is("the words were saved", (await kept(idTwo))?.text, "Words from two.");
  is("with no photo", (await kept(idTwo))?.photo ?? null, null);
  is("the slot stays used: the cost side fails closed", (await kept(idTwo) as unknown as { photoPuts?: number })?.photoPuts, 1);
  is("one put was tried", blobControl.puts.length, 5);

  part("The kept count read in an unknown shape is the ceiling, never zero");
  const SESSION_THREE = "cs_test_reviewphotolimit00003";
  SESSIONS[SESSION_THREE] = { email: "buyer-three@example.com", pi: "pi_ReviewPhotoLimit03" };
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const reply = await original(commands);
    // The kept count's read, answered in an unknown shape; every other command as Redis answers it.
    return reply.map((r, i) => (commands[i][0] === "HGET" && String(commands[i][1]).endsWith(":photos") ? ["garbled"] : r));
  }) as typeof redis.pipeline;
  const unknownStatus = statusOf(await send(SESSION_THREE, { photo: jpeg(1200, 900), text: "Words from three." }));
  redis.pipeline = original;
  is("a new review whose kept count reads garbled: the words are saved, the photo refused", unknownStatus, "photoLimit");
  is("no put for it", blobControl.puts.length, 5);

  part("The kept count goes with the product's reviews");
  is("control: the count is kept on its own hash", redis.keys().includes(countKey), true);
  await dropReviews(statsId, productId);
  is("dropReviews deletes it with the reviews", redis.keys().includes(countKey), false);
  is(
    "the person's own page says the count is erased with their reviews",
    PERSON_DATA.some((line) => line.file === "lib/reviews.ts" && line.how === "erased" && /new photos/.test(line.what)),
    true,
  );
  is("and never that it is kept", PERSON_DATA.some((line) => line.file === "lib/reviews.ts" && line.how === "kept" && /new photos|one-way id/.test(line.what)), false);

  part("No put outside a granted slot (second review of #2863, LEVE)");
  is("the photo module has no helper that puts without a slot", "keepReviewPhoto" in reviewPhoto, false);

  part("The counter as kept");
  const raw = (extra: Record<string, unknown>) =>
    JSON.stringify({ id: "a".repeat(24), productId: "prod000001", reference: "cs_x", pi: "pi_x", rating: 5, text: "x", name: "", createdAt: 1, editedAt: 0, hidden: false, refunded: false, reply: null, photo: null, ...extra });
  const puts = (extra: Record<string, unknown>) => (parseReview(raw(extra)) as unknown as { photoPuts?: number } | null)?.photoPuts ?? 0;
  is("a review written before the counter counts none", puts({}), 0);
  is("a count kept is read as kept", puts({ photoPuts: 2 }), 2);
  is("a count that is not a whole number is taken as the ceiling, never as zero", [puts({ photoPuts: "1" }), puts({ photoPuts: -1 }), puts({ photoPuts: 1.5 }), puts({ photoPuts: null })], [3, 3, 3, 3]);
  is("a count past the ceiling is the ceiling", puts({ photoPuts: 99 }), 3);

  part("What the buyer reads");
  is("the ceiling's notice is a done notice: the review was saved", REVIEW_NOTICES.photoLimit, { text: GIVING_WORDS.en.reviewNotices.photoLimit });
  is("a failed put is said as something that went wrong", REVIEW_NOTICES.photoFailed?.alert, true);
  is("every buyer language says both", Object.values(GIVING_WORDS).every((w) => ["photoLimit", "photoFailed"].every((k) => typeof (w.reviewNotices as Record<string, string>)[k] === "string")), true);
  is("each names the ceiling's number", Object.values(GIVING_WORDS).every((w) => (w.reviewNotices as Record<string, string>).photoLimit?.includes(String(MAX))), true);
  is("German in the formal register", /\bIhre\b/.test((GIVING_WORDS.de.reviewNotices as Record<string, string>).photoLimit ?? ""), true);
  is("the store-paused notice keeps its own words", GIVING_WORDS.en.reviewNotices.photoPaused, "Your review was saved, but the new photo was not added: this store is not taking new photos right now.");

  done();
}

main();
