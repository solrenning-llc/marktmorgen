import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { readOrderAdmitted, takeBuyerRequest } from "@/lib/order-lookup";
import { withinStoreWhy } from "@/lib/metered-limits";
import { feedToken } from "@/lib/podcast-access";

/**
 * "Add it to your podcast app" on the thanks page: the order is read again
 * from Stripe, and the address that paid gets its own feed, shown on the
 * podcast's page.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  let sessionId = "";
  try {
    const form = await (await limited(request, 2_000)).formData();
    handle = normaliseHandle(String(form.get("handle") ?? ""));
    sessionId = String(form.get("session_id") ?? "").slice(0, 200);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("No such store.", { status: 404 });
  const away = (path: string) => new Response(null, { status: 303, headers: { Location: `${origin}${path}`, "Cache-Control": "no-store" } });
  // The order is read from Stripe: counted after the id is known to be an order's, the lookup on the public side and
  // only a paid order on the buyers' (lib/order-lookup.ts). A made-up number spends nothing of the buyers' reserve.
  const order = await readOrderAdmitted(store, sessionId, {
    lookup: () => withinStoreWhy("podcast-open", `${clientAddress(request)}|${store.handle}`, 20, 600, store, "lookup"),
    paid: () => takeBuyerRequest(store),
  });
  if (order.state === "slow") return away(`/@${store.handle}`);
  if (order.state === "resting") return away(`/@${store.handle}/resting`);
  if (order.state !== "paid" || order.gift || order.group || order.preorder || !order.product.podcast || !order.email || order.membership === "ended") return away(`/@${store.handle}`);
  const token = await feedToken(store, order.product.id, order.email);
  if (!token) return away(`/@${store.handle}/podcast/${order.product.id}?status=error`);
  return away(`/@${store.handle}/podcast/${order.product.id}?t=${token}`);
}
