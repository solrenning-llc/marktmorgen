import { type NextRequest, after } from "next/server";
import { StoreFullError } from "@/lib/store-full";
import { setReviewAsk } from "@/lib/store";
import { refreshStoreQuotes } from "@/lib/store-quotes";
import { guardStoreWrite, text } from "@/lib/store-request";
import { MAX_REPLY_TEXT, REVIEW_ID_PATTERN, isHideReason, markSeen, setHidden, setReply, setReviewPhoto } from "@/lib/reviews";
import { dropReviewPhoto } from "@/lib/review-photo";
import { MAX_ASK_DAYS, MIN_ASK_DAYS, readAgain } from "@/lib/review-ask";
import { parseReviewElsewhere } from "@/lib/review-elsewhere";
import { canWrite } from "@/lib/mail";

const PRODUCT_ID = /^[a-z0-9]{6,40}$/;

/**
 * What a creator may do with their buyers' reviews, from the studio:
 *
 *   { action: "hide", product, id, hidden }   take a review's words off the page, or put them back
 *   { action: "reply", product, id, text }    answer it in public; empty text takes the answer away
 *   { action: "photo", product, id }          take the buyer's photo off it, and delete it
 *   { action: "seen", items | all }           take reviews out of the queue of new ones
 *   { action: "ask", days }                   the review-request email: 3 to 30 days, or 0 for off
 *   { action: "ask", days, elsewhere }        and the creator's public review page, "" for none
 *   { action: "ask", days, again }            and one reminder 3 to 14 days after it, 0 for none (636 [GL4](a))
 *
 * There is no action that changes what a buyer wrote or the stars they gave,
 * and none that deletes a review: only its buyer can (lib/reviews.ts). A
 * photo can be taken off, as a picture is what a page should never show
 * against its creator's will.
 */
export async function POST(request: NextRequest) {
  // Moderating is for everyone on the team who answers buyers (lib/team-roles.ts,
  // "reviews"); the email that asks buyers for a review is a store setting.
  const guarded = await guardStoreWrite(request, (sent) => (sent.action === "ask" ? "settings" : "reviews"), 8_000);
  if (!guarded.ok) return guarded.response;
  const body = guarded.body;
  const store = guarded.store;
  const action = text(body.action, 10);

  try {
    if (action === "ask") {
      const days = Number(body.days);
      if (!Number.isInteger(days) || (days !== 0 && (days < MIN_ASK_DAYS || days > MAX_ASK_DAYS))) {
        return Response.json({ ok: false, error: "days" }, { status: 400 });
      }
      // Switching it on needs what every email to people needs here.
      if (days > 0 && !canWrite(store)) return Response.json({ ok: false, error: "email" }, { status: 400 });
      // The creator's public review page (lib/review-elsewhere.ts): "" takes it off, absent keeps it.
      let elsewhere = store.reviewAsk.elsewhere;
      if ("elsewhere" in body) {
        const typed = typeof body.elsewhere === "string" ? body.elsewhere.trim() : "";
        if (!typed) elsewhere = undefined;
        else {
          const page = parseReviewElsewhere(typed);
          if (!page) return Response.json({ ok: false, error: "elsewhere" }, { status: 400 });
          elsewhere = page;
        }
      }
      // One reminder, or none: absent keeps what was chosen, anything out of range is refused.
      let again = store.reviewAsk.again ?? 0;
      if ("again" in body) {
        const asked = Number(body.again);
        if (asked !== 0 && readAgain(asked) === 0) return Response.json({ ok: false, error: "again" }, { status: 400 });
        again = asked;
      }
      await setReviewAsk(guarded.ref, { days, ...(elsewhere ? { elsewhere } : {}), ...(again ? { again } : {}) });
      return Response.json({ ok: true });
    }

    const statsId = store.statsId;
    if (!statsId) return Response.json({ ok: false, error: "missing" }, { status: 400 });

    if (action === "seen") {
      if (body.all === true) {
        await markSeen(statsId, "all");
      } else {
        const items = Array.isArray(body.items) ? body.items.filter((i): i is string => typeof i === "string").slice(0, 200) : [];
        await markSeen(statsId, items);
      }
      return Response.json({ ok: true });
    }

    const productId = text(body.product, 40);
    const id = text(body.id, 24);
    if (!PRODUCT_ID.test(productId) || !REVIEW_ID_PATTERN.test(id)) return Response.json({ ok: false, error: "missing" }, { status: 400 });

    if (action === "photo") {
      // A buyer's photo is taken off only for one of the review rules, as a review is hidden (567 [GD1] (e)).
      if (!isHideReason(body.reason)) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      const taken = await setReviewPhoto(statsId, productId, id, null);
      if (taken === "busy") return Response.json({ ok: false, error: "busy" }, { status: 409 });
      if (taken === "missing") return Response.json({ ok: false, error: "missing" }, { status: 404 });
      await dropReviewPhoto(taken.removed);
      return Response.json({ ok: true });
    }

    const done =
      action === "hide"
        ? await setHidden(statsId, productId, id, body.hidden === true, body.reason)
        : action === "reply"
          ? await setReply(statsId, productId, id, text(body.text, MAX_REPLY_TEXT + 200), store)
          : null;
    if (done === null) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    if (done === "busy") return Response.json({ ok: false, error: "busy" }, { status: 409 });
    if (done === "missing") return Response.json({ ok: false, error: "missing" }, { status: 404 });
    // A review hidden or shown again changes what the store page may quote (lib/store-quotes.ts).
    if (action === "hide") after(() => refreshStoreQuotes(store));
    return Response.json({ ok: true });
  } catch (error) {
    // What does not fit in the store's data room is not written (lib/store-data.ts).
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    console.error("changing a review failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
