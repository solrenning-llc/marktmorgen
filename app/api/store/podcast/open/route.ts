import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { fromAnotherSite, limited, limitUnknownResponse, unknownLimit } from "@/lib/request-guard";
import { readOrder } from "@/lib/store-checkout";
import { feedToken } from "@/lib/podcast-access";
import { takeBuyerRead } from "@/lib/buyer-actions";

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
  // One of the store's public requests on the buyers' side: the order is read from Stripe (lib/buyer-actions.ts).
  const taken = await takeBuyerRead(store).catch(unknownLimit);
  // A count that could not be read is never "resting" or "too many" (rule 24): it could not be checked just now.
  if (taken === "unknown") return limitUnknownResponse();
  if (!taken) return away(`/@${store.handle}/resting`);
  const order = await readOrder(store, sessionId);
  if (order.state !== "paid" || order.gift || order.group || order.preorder || !order.product.podcast || !order.email || order.membership === "ended") return away(`/@${store.handle}`);
  const token = await feedToken(store, order.product.id, order.email);
  if (!token) return away(`/@${store.handle}/podcast/${order.product.id}?status=error`);
  return away(`/@${store.handle}/podcast/${order.product.id}?t=${token}`);
}
