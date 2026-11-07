import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, withinLimit } from "@/lib/request-guard";
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
  if (!(await withinLimit("paypal-return", `${clientAddress(request)}|${store.handle}`, 30, 600))) return away(`/@${store.handle}?status=slow`);
  // Handed over inside the capture, before the order leaves pending: a hand-over that fails answers "error" and
  // leaves the order pending, so the sweep hands it over (lib/paypal-sales.ts settle), never only logged.
  // A product the creator removed hands nothing over (false): that is a failed hand-over, so the order stays pending.
  const result = await captureOrder(store, order, async (paid) => {
    if (!(await handOverPayPal(store, paid))) throw new Error("a PayPal payment's product is gone: nothing was handed over");
  });
  if (result.ok) return away(`/@${store.handle}/thanks?paypal=${encodeURIComponent(order)}`);
  // Not settled yet, the answer was lost on the way, or the hand-over failed:
  // the thanks page says so, and the sweep hands it over (once PayPal completes it).
  if (result.reason === "pending" || result.reason === "error") return away(`/@${store.handle}/thanks?paypal=${encodeURIComponent(order)}`);
  if (result.reason === "declined") return away(`/@${store.handle}?status=paypal-declined`);
  return away(`/@${store.handle}?status=paypal-error`);
}
