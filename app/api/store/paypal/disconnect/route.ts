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
  // The seller is cleared with the moment of this disconnect, in one locked write (lib/store.ts setPayPalSeller): a
  // connect started before it is never finished by its way back, even one already asking PayPal, whatever ending its
  // mark below comes back as (Codex X4 and X5 on #4345). The mark is then ended too, so an old way back is not even
  // asked of PayPal; a mark that could not be ended runs out within a day and stays refused meanwhile.
  const saved = await setPayPalSeller(ref, null);
  if (!saved) return away(origin, studio("paypal=error#paypal"));
  if (store.statsId && !(await stopOnboarding(store.statsId))) console.error("a PayPal connect's mark could not be ended; the disconnect stands");
  if (store.paypalSeller) after(() => noticeCreator(store, { kind: "paypal-disconnected" }));
  return away(origin, studio("paypal=forgotten#paypal"));
}
