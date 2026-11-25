import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, withinLimit, unknownLimit } from "@/lib/request-guard";
import { captureOrder } from "@/lib/paypal-sales";
import { handOverPayPal } from "@/lib/paypal-delivery";

/**
 * Where PayPal sends the buyer after they approve the payment. PayPal adds
 * the order's id as `token`. The payment is taken here, checked against the
 * order this store opened, and what it bought is handed over at once.
 * Reloading, or arriving twice, takes nothing twice.
 */
export async function GET(request: NextRequest) {
  const origin = originFrom(request);
  const away = (path: string) => new Response(null, { status: 303, headers: { Location: `${origin}${path}`, "Cache-Control": "no-store" } });
  const handle = normaliseHandle(request.nextUrl.searchParams.get("store") ?? "");
  const order = (request.nextUrl.searchParams.get("token") ?? "").slice(0, 40);
  if (!handle) return away("/");
  const store = await storeForHandle(handle);
  if (!store) return away("/");
  const room = await withinLimit("paypal-return", `${clientAddress(request)}|${store.handle}`, 30, 600).catch(unknownLimit);
  if (room === "unknown") return away(`/@${store.handle}?status=error`);
  if (!room) return away(`/@${store.handle}?status=slow`);
  let result: Awaited<ReturnType<typeof captureOrder>>;
  try {
    result = await captureOrder(store, order);
  } catch (error) {
    // An error captureOrder does not turn into an answer (Redis out of reach, for one): nothing is shown as paid, and the
    // buyer gets the store's notice, as for an answer not known, never a bare server error (Claude 6's NIT on #3404, row
    // #3404 of #5285). A payment PayPal took is still in pending, put there before PayPal was asked, so the sweep writes
    // it down and hands it over. Logged without the buyer's details: the store and the error's own name and words.
    console.error("taking a PayPal payment on return failed", store.handle, error instanceof Error ? `${error.name}: ${error.message}` : typeof error);
    return away(`/@${store.handle}?status=paypal-error`);
  }
  if (result.ok) {
    if (result.fresh) await handOverPayPal(store, result.paid).catch((error) => console.error("handing over a PayPal purchase failed", error));
    return away(`/@${store.handle}/thanks?paypal=${encodeURIComponent(order)}`);
  }
  // Not settled yet, or the answer was lost on the way: the thanks page says
  // so, and the sweep hands it over if PayPal completes it.
  if (result.reason === "pending" || result.reason === "error") return away(`/@${store.handle}/thanks?paypal=${encodeURIComponent(order)}`);
  if (result.reason === "declined") return away(`/@${store.handle}?status=paypal-declined`);
  // Another load of the same order is taking the payment right now: neither the thanks page (nothing is under watch
  // for this one) nor "could not be matched" (it may be handed over a moment later).
  if (result.reason === "confirming") return away(`/@${store.handle}?status=paypal-confirming`);
  return away(`/@${store.handle}?status=paypal-error`);
}
