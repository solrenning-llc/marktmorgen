import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { readListing } from "@/lib/catalog";
import { PreorderDayUnconfirmed, preorderViews, setExpectedDay, soonOne } from "@/lib/preorders";
import { preorderProblem, readExpectedDay } from "@/lib/preorder-rules";
import { UnknownReplyError } from "@/lib/redis-reply";

/**
 * The studio's pre-order switch (lib/preorders.ts), for a product marked
 * coming soon.
 *
 * `{ id, day, agree: true }` takes pre-orders, expected on `day` (from
 * tomorrow to a year ahead), or moves that day; `agree` is the creator
 * saying they refund every pre-order in full if it does not come out, which
 * the product's page then tells buyers. `{ id, day: null }` stops taking them;
 * those already paid still wait for the product and are handed over when it
 * goes on sale.
 *
 * The change saved, its pre-orders read in an unknown shape answer 503
 * "preorders_unread": the counts are not invented as 0 (sweep APP3). The
 * change itself not confirmed (its write answered in another shape) answers
 * 502 "day_unconfirmed", never "Saved." (independent review of #3005).
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 2_000);
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  const id = typeof body.id === "string" ? body.id.slice(0, 40) : "";
  const product = id ? await readListing(store, id) : null;
  if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  if (!store.statsId) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });

  try {
    if (body.day === null) {
      await setExpectedDay(store, product.id, null);
    } else {
      const problem = preorderProblem(product);
      if (problem) return Response.json({ ok: false, error: problem }, { status: 400 });
      if (!(await soonOne(store, product.id)).soon) return Response.json({ ok: false, error: "soon" }, { status: 400 });
      const day = readExpectedDay(body.day);
      if (!day) return Response.json({ ok: false, error: "day" }, { status: 400 });
      if (body.agree !== true) return Response.json({ ok: false, error: "agree" }, { status: 400 });
      await setExpectedDay(store, product.id, day);
    }
    const views = await preorderViews(store, [product.id]);
    return Response.json({ ok: true, view: views[product.id] ?? { day: null, waiting: 0, given: 0, refunded: 0 } });
  } catch (error) {
    if (error instanceof PreorderDayUnconfirmed) {
      console.error("a pre-order change could not be confirmed saved", error);
      return Response.json({ ok: false, error: "day_unconfirmed" }, { status: 502 });
    }
    if (error instanceof UnknownReplyError) {
      console.error("a pre-order change was saved, but its pre-orders could not be read", error);
      return Response.json({ ok: false, error: "preorders_unread" }, { status: 503 });
    }
    console.error("changing a pre-order failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
