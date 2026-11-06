import { type NextRequest, after } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { isFree, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { launch, setSoon, waitlistViews } from "@/lib/waitlist";
import { queueRelease, runPreorderReleases, waitingCount } from "@/lib/preorders";
import { preorderDeps } from "@/lib/purchase-email";
import { hasContent } from "@/lib/preorder-rules";
import { UnknownReplyError } from "@/lib/redis-reply";

/**
 * The studio's waitlist switches.
 *
 * `{ action: "soon", id, on }` marks a paid product coming soon (a waitlist
 * instead of a buy button) or takes the mark off without emailing anyone;
 * `{ action: "launch", id, note, address }` puts it on sale and starts the
 * one email to everyone who confirmed.
 *
 * Either way off "coming soon", its pre-orders still waiting are handed over
 * (lib/preorders.ts), so it is refused while the product has nothing in it.
 *
 * A session let in without its second step (lib/two-step.ts) may not
 * "launch": that email goes to everyone on the list once, in the creator's own
 * words, and the list is spent. "soon" stays open to it: taking the mark off
 * emails nobody on the waitlist, and the pre-orders it hands over get the
 * fixed delivery email (lib/preorders.ts sendOut), only to buyers who paid
 * for the product, with nothing typed in this request.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 4_000);
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  const id = typeof body.id === "string" ? body.id.slice(0, 40) : "";
  const product = id ? await readListing(store, id) : null;
  if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  if (!store.statsId) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });

  try {
    // Going on sale hands over every pre-order still waiting (lib/preorders.ts),
    // so it cannot happen while there is nothing in the product to hand over.
    const releasing = (body.action === "soon" && body.on !== true) || body.action === "launch";
    if (releasing && !hasContent(product) && (await waitingCount(store, product.id)) > 0) {
      return Response.json({ ok: false, error: "empty" }, { status: 400 });
    }
    if (body.action === "soon") {
      if (body.on === true && isFree(product)) return Response.json({ ok: false, error: "free" }, { status: 400 });
      await setSoon(store, product.id, body.on === true);
      if (body.on !== true) await queueRelease(store, product.id);
    } else if (body.action === "launch") {
      const result = await launch(store, product, { note: body.note, address: body.address });
      if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
      await queueRelease(store, product.id);
    } else {
      return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    }
    // Pre-orders are handed over right after this answer, rather than at the
    // next five-minute job, which picks up whatever is left.
    if (releasing) {
      after(() => runPreorderReleases(storeForHandle, readListing, preorderDeps, Date.now() + 8_000).catch((error) => console.error("handing over pre-orders failed", error)));
    }
    const views = await waitlistViews(store, [product.id]);
    return Response.json({ ok: true, view: views[product.id] ?? { soon: false, confirmed: 0, waiting: 0, launch: null } });
  } catch (error) {
    // A pre-order count or a hand-over job that Redis answered in an unknown shape (sweep APP3): before the switch,
    // an empty product stays coming soon; after it, the job was queued unless this says so. Never said as done.
    if (error instanceof UnknownReplyError) {
      console.error("changing a waitlist could not read or write its pre-orders", error);
      return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    }
    console.error("changing a waitlist failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
