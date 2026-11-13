import { type NextRequest, after } from "next/server";
import { noticeCreator } from "@/lib/account-notice";
import { away, creatorFrom } from "@/lib/studio-route";
import { setPayPalSeller } from "@/lib/store";
import { stopOnboarding } from "@/lib/paypal-sales";

/**
 * Stops selling through the creator's PayPal, on this side. What was already
 * bought stays bought. Removing Marktmorgen's permissions from the PayPal account
 * itself is the creator's to do, in their PayPal settings.
 */
export async function POST(request: NextRequest) {
  const creator = await creatorFrom(request, "payments");
  if (creator instanceof Response) return creator;
  const { ref, store, origin, studio } = creator;
  // A connect started before this is ended first, so its way back, even one already asking PayPal, finds no connect
  // under the store's write lock and writes nothing (lib/store.ts connectPayPalSellerIf). The seller is cleared even
  // when that end is not confirmed, and the creator is then told something went wrong, so they try again.
  const ended = store.statsId ? await stopOnboarding(store.statsId) : true;
  const saved = await setPayPalSeller(ref, null);
  if (!saved || !ended) return away(origin, studio("paypal=error#paypal"));
  if (store.paypalSeller) after(() => noticeCreator(store, { kind: "paypal-disconnected" }));
  return away(origin, studio("paypal=forgotten#paypal"));
}
