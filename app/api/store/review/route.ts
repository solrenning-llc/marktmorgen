import { withinStore } from "@/lib/metered-limits";
import { type NextRequest, after } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { dropReviewQuote, refreshStoreQuotes } from "@/lib/store-quotes";
import { ensureStatsId, normaliseHandle, setReviewed, storeForHandle, storeRef } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { type Door, doorFields, openDoor, readDoor } from "@/lib/review-proof";
import { MAX_REVIEW_PHOTO_BYTES, deleteReview, markOneRefunded, readRating, readReview, reviewId, saveReview, setReviewPhoto } from "@/lib/reviews";
import { dropReviewPhoto, keepReviewPhoto } from "@/lib/review-photo";
import { costsPaused } from "@/lib/plan-standing";

/** The words, and a photo shrunk by the buyer's browser (lib/review-photo.ts) sent as text. */
const MAX_BODY_BYTES = 6_000 + Math.ceil(MAX_REVIEW_PHOTO_BYTES * 1.6);
/** Reviews sent from one connection to one store in an hour. */
const IP_LIMIT = 20;
/** Changes to reviews of one order in an hour. */
const ORDER_LIMIT = 10;

/**
 * A buyer writes, changes or deletes their review of something they bought.
 *
 * A plain HTML form, from the thanks page, the review page reached from the
 * list of purchases, or the link in the email that asks for a review. What
 * proves the order travels in hidden fields (lib/review-proof.ts) and is
 * checked with Stripe on every request: the order has to be this store's,
 * paid, not refunded, and hold the product being reviewed. Nothing the form
 * sends can say who the buyer is; the review's id is made from the address
 * Stripe has for that order.
 *
 * The answer is always a page, back where the buyer was, with a word on
 * what happened.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });

  let form: FormData;
  try {
    form = await (await limited(request, MAX_BODY_BYTES)).formData();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const read = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const handle = normaliseHandle(read("handle").slice(0, 40));
  const productId = read("product").slice(0, 40);
  const action = read("action") === "delete" ? "delete" : "save";
  const back = read("back") === "thanks" ? "thanks" : "review";
  const door = readDoor(read);
  if (!handle || !productId || !door) return new Response("Bad request", { status: 400 });

  const found = await storeForHandle(handle);
  if (!found) return new Response("No such store.", { status: 404 });
  let store = found;

  const answer = (status: string, where: Door = door) => {
    const path =
      back === "thanks" && where.via === "session"
        ? `/@${store.handle}/thanks?${new URLSearchParams({ session_id: where.session, review: status, product: productId })}#r-${productId}`
        : `/@${store.handle}/review?${new URLSearchParams({ ...doorFields(where), status, product: productId })}#r-${productId}`;
    return new Response(null, { status: 303, headers: { Location: `${origin}${path}`, "Cache-Control": "no-store" } });
  };

  // A field no person can see: whatever filled it in is told it worked.
  if (read("website").trim()) return answer("saved");

  if (!(await withinStore("review", `${clientAddress(request)}|${store.handle}`, IP_LIMIT, 3600, store))) return answer("slow");

  const opened = await openDoor(store, door);
  if (opened.state !== "ok") return answer(opened.state === "error" ? "error" : opened.state);
  const proof = opened.proof;
  if (!proof.products.some((p) => p.id === productId)) return answer("no");
  if (!(await withinLimit("review-order", proof.reference, ORDER_LIMIT, 3600))) return answer("slow");

  if (!store.statsId) {
    // By the key the store is kept under: an account's other stores are not
    // kept under the owner's address (lib/store.ts).
    const given = await ensureStatsId(storeRef(store));
    if (!given?.statsId) return answer("error");
    store = given;
  }
  const statsId = store.statsId as string;
  const id = reviewId(statsId, productId, proof.email);

  try {
    if (action === "delete") {
      const before = await readReview(statsId, productId, id);
      // Its words leave the store page's quotes first (lib/store-quotes.ts), so "deleted" never leaves them there.
      if (before) await dropReviewQuote(store, before);
      const done = await deleteReview(statsId, productId, id, store);
      if (done === "deleted") {
        after(() => refreshStoreQuotes(store));
        await dropReviewPhoto(before?.photo);
      }
      return answer(done === "busy" ? "busy" : "deleted");
    }
    if (proof.refunded) {
      // Whatever this buyer wrote from this order no longer counts.
      const before = await readReview(statsId, productId, id);
      if (before && before.reference === proof.reference && !before.refunded) {
        await dropReviewQuote(store, before);
        await markOneRefunded(statsId, productId, id);
        after(() => refreshStoreQuotes(store));
      }
      return answer("refunded");
    }
    const rating = readRating(read("rating"));
    if (rating === null) return answer("rating");
    // A photo is checked and kept before the words are, so a photo that cannot be used changes nothing.
    // While the store's plan renewal is unpaid or its plan payment disputed
    // (232 [CA1] 4b), a new photo is new storage nobody is paying for: the
    // words are still saved, the photo is not kept, and the buyer is told.
    const photoPaused = Boolean(read("photo")) && costsPaused(store);
    const sentPhoto = photoPaused ? "" : read("photo");
    const photo = sentPhoto ? await keepReviewPhoto(storeRef(store), sentPhoto) : null;
    if (photo === "photo") return answer("photo");
    const saved = await saveReview(statsId, {
      productId,
      email: proof.email,
      reference: proof.reference,
      pi: proof.pi,
      rating,
      text: read("text"),
      name: read("name"),
      paidAt: proof.paidAt,
    }, store);
    const written = saved.state === "created" || saved.state === "updated";
    if (!written) await dropReviewPhoto(photo);
    // The new photo goes on; one taken off, or replaced, is deleted after the write.
    if (written && (photo || read("photo_remove") === "yes")) {
      const changed = await setReviewPhoto(statsId, productId, id, photo);
      if (typeof changed === "string") await dropReviewPhoto(photo);
      else await dropReviewPhoto(changed.removed);
    }
    // The store page reads ratings only once a store has any (lib/store.ts, reviewed).
    if ((saved.state === "created" || saved.state === "updated") && !store.reviewed) {
      await setReviewed(storeRef(store)).catch((error: unknown) => console.error("noting a store's first review failed", error));
    }
    // "What buyers say" on the store page, kept on the store's record (lib/store-quotes.ts).
    if (saved.state === "created" || saved.state === "updated") after(() => refreshStoreQuotes(store));
    if ((saved.state === "created" || saved.state === "updated") && photoPaused) return answer("photoPaused");
    if (saved.state === "created") return answer("saved");
    if (saved.state === "updated") return answer("updated");
    return answer(saved.state === "invalid" ? "rating" : saved.state);
  } catch (error) {
    console.error("saving a review failed", error);
    return answer("error");
  }
}
