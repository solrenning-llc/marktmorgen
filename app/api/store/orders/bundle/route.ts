import type { NextRequest } from "next/server";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { askBundle } from "@/lib/purchase-cards";
import type { OrdersBundleAnswer } from "@/components/orders-bundle";

/** The longest one answer may run: its lookup waits DOWNLOAD_LOOKUP_MS at the most (lib/buyer-orders.ts, bundleFor). */
export const maxDuration = 30;

function answer(status: number, body: OrdersBundleAnswer): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

/**
 * The products of one bundle on a buyer's list of purchases, asked for with
 * the button under it (components/orders-bundle.tsx): the list does not draw
 * them, so an opening stays small whatever its bundles hold (C3-80).
 *
 * Read as a download is (lib/purchase-cards.ts, askBundle): the link's own
 * limit and the request's call first, then lib/buyer-orders.ts (bundleFor)
 * takes ORDERS_BUNDLE_UNITS of the store's buyer requests before the grant is
 * read and every listing and key through its meter before it is read, and
 * reads only that purchase, from the creator's own Stripe account, so a refund
 * made a minute ago is honored. A store with no room answers "too often" and
 * reads nothing. The page draws the same products without JavaScript
 * (app/[handle]/orders/page.tsx, `bundle`).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const handle = normaliseHandle(params.get("handle") ?? "");
  if (!handle) return answer(400, { ok: false, message: "Which store?" });
  const store = await storeForHandle(handle);
  if (!store) return answer(404, { ok: false, message: "We could not find this store." });
  const asked = await askBundle(store, params.get("token") ?? "", params.get("ref") ?? "", params.get("item") ?? "");
  if (!asked.ok) return answer(asked.status, { ok: false, message: asked.message });
  return answer(200, { ok: true, lines: asked.value.lines, missing: asked.value.missing });
}
