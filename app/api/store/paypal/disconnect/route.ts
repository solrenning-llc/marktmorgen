import { type NextRequest, after } from "next/server";
import { noticeCreator } from "@/lib/account-notice";
import { away, creatorFrom } from "@/lib/studio-route";
import { setPayPalSeller } from "@/lib/store";
import { endOnboarding } from "@/lib/paypal-sales";

/**
 * Stops selling through the creator's PayPal, on this side. What was already
 * bought stays bought. Removing Marktmorgen's permissions from the PayPal account
 * itself is the creator's to do, in their PayPal settings.
 */
export async function POST(request: NextRequest) {
  const creator = await creatorFrom(request, "payments");
  if (creator instanceof Response) return creator;
  const { ref, store, origin, studio } = creator;
  const saved = await setPayPalSeller(ref, null);
  if (!saved) return away(origin, studio("paypal=error#paypal"));
  // A connect started before this is not finished by its way back afterwards.
  if (saved.statsId) await endOnboarding(saved.statsId);
  if (store.paypalSeller) after(() => noticeCreator(store, { kind: "paypal-disconnected" }));
  return away(origin, studio("paypal=forgotten#paypal"));
}
