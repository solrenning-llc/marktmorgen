import { type NextRequest, after } from "next/server";
import { noticeCreator } from "@/lib/account-notice";
import { away, creatorFrom } from "@/lib/studio-route";
import { disconnectPayPalSeller } from "@/lib/store";

/**
 * Stops selling through the creator's PayPal, on this side. What was already
 * bought stays bought, a payment PayPal still holds as pending is still handed
 * over when it completes, and a refund still takes the purchase back: the
 * account is kept as the store's paypalPast for that (lib/store.ts). Removing
 * Marktmorgen's permissions from the PayPal account itself is the creator's to
 * do, in their PayPal settings.
 */
export async function POST(request: NextRequest) {
  const creator = await creatorFrom(request, "payments");
  if (creator instanceof Response) return creator;
  const { ref, store, origin, studio } = creator;
  const saved = await disconnectPayPalSeller(ref);
  if (!saved) return away(origin, studio("paypal=error#paypal"));
  if (store.paypalSeller) after(() => noticeCreator(store, { kind: "paypal-disconnected" }));
  return away(origin, studio("paypal=forgotten#paypal"));
}
