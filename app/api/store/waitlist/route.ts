import { type NextRequest, after } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { isFree, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { launch, launchReadMostBytes, setSoon, waitlistViews } from "@/lib/waitlist";
import { queueRelease, runPreorderReleases, waitingCount } from "@/lib/preorders";
import { preorderDeps } from "@/lib/purchase-email";
import { hasContent } from "@/lib/preorder-rules";
import { UnknownReplyError } from "@/lib/redis-reply";
import { IncludedBytes, PAGE_INCLUDED_BYTES } from "@/lib/sent-bytes";
import { holdStudio, refusedJson } from "@/lib/studio-route";
import { forceAllowance } from "@/lib/store-allowance";
import { refreshPeriod } from "@/lib/billing-sync";

/** Studio requests a launch's read of `bytes` costs beyond the request's own (lib/sent-bytes.ts, IncludedBytes). */
const unitsFor = (bytes: number) => new IncludedBytes().take(bytes, PAGE_INCLUDED_BYTES).units;

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
 * "launch" needs "send": that email goes to everyone on the list once, in the
 * creator's own words, and the list is spent. So an Editor, who has no sending
 * to the list (lib/team-roles.ts), may not launch, and neither may a session
 * let in without its second step ("send" is one of lib/two-step.ts
 * LOCKED_NEEDS). "soon" stays "products", open to both: taking the mark off
 * emails nobody on the waitlist, and the pre-orders it hands over get the
 * fixed delivery email (lib/preorders.ts sendOut), only to buyers who paid
 * for the product, with nothing typed in this request.
 *
 * A change that was saved but whose view cannot be read afterwards answers
 * `{ ok: true, viewsUnread: true }` (CX-123 rule 24): saved, numbers unread.
 */
export async function POST(request: NextRequest) {
  // Launching emails the whole waitlist: "send", as app/api/store/product-update (audit of the API routes, 11 Nov 2026).
  const guarded = await guardStoreWrite(request, (body) => (body.action === "launch" ? "send" : "products"), 4_000);
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
      // The launch reads the whole list once, to start its email with every confirmed address (#5010 row 149): the
      // studio requests for its most bytes are taken before it reads, refused before anything is read without them,
      // and what it did not move is given back; a list that grew in between is counted past the figure, never free.
      const most = unitsFor(await launchReadMostBytes(store, product.id));
      const held = most > 0 ? await holdStudio(store, most) : null;
      if (held && !held.ok) return refusedJson("used", held.message);
      const moved = { bytes: 0 };
      // Settled whether the launch returns or throws (Claude 4 2Wb's note on #5281): a launch stopped after its read
      // keeps the requests for what it read and gives back the rest. A failed settling is logged, never in the answer.
      const settle = async () => {
        const used = unitsFor(moved.bytes);
        if (held?.ok) {
          if (used < most) await held.give(most - used);
          else if (used > most) await held.force(used - most);
        } else if (used > 0) await forceAllowance(await refreshPeriod(store), "studio", used);
      };
      let result: Awaited<ReturnType<typeof launch>>;
      try {
        result = await launch(store, product, { note: body.note, address: body.address }, moved);
      } finally {
        await settle().catch((error: unknown) => console.error("settling a launch's studio requests failed", error));
      }
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
    // The change is saved by now. A view that cannot be read after it is
    // answered as unread, never as a failure (it was saved) and never drawn
    // from a set that could not be read.
    const views = await waitlistViews(store, [product.id]).catch((error: unknown) => {
      console.error("reading a waitlist after a saved change failed", error);
      return null;
    });
    if (!views) return Response.json({ ok: true, viewsUnread: true });
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
