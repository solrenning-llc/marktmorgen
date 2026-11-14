import { type NextRequest, after } from "next/server";
import { noticeCreator } from "@/lib/account-notice";
import { away, creatorFrom } from "@/lib/studio-route";
import { attemptStartedAt, checkSeller, endOnboarding, onboardingStarted, onboardingStill, paypalSalesConfigured } from "@/lib/paypal-sales";
import { connectPayPalSellerIf } from "@/lib/store";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";

/**
 * Where PayPal sends the creator back after onboarding. PayPal arrives by
 * redirect, a GET from another site, so the session cookie is what says who
 * this is. Which PayPal account is connected is asked of PayPal by the
 * store's own tracking id; the ids in the address PayPal returns to are not
 * trusted for it.
 */
export async function GET(request: NextRequest) {
  const creator = await creatorFrom(request, "payments", { checkOrigin: false });
  if (creator instanceof Response) return creator;
  const { ref, store, origin, studio } = creator;
  if (!paypalSalesConfigured()) return away(origin, studio("paypal=unavailable#paypal"));
  if (!store.statsId) return away(origin, studio("paypal=error#paypal"));
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return away(origin, studio("paypal=limited#paypal"));
  // Only after a connect started from this store's studio: opened again from the history, or from a link on another
  // site, this address connects nothing (a store that stopped selling with PayPal stays stopped). A connected store
  // is shown as it is; one that is not is told nothing was finished.
  const started = await onboardingStarted(store.statsId);
  if (started === "unknown") return away(origin, studio("paypal=error#paypal"));
  if (!started) return away(origin, studio(store.paypalSeller ? "#paypal" : "paypal=id#paypal"));
  const checked = await checkSeller(store.statsId);
  if (!checked.ok) return away(origin, studio(`paypal=${checked.reason}#paypal`));
  // Written only while this same connect is still the store's current one, read again under the store's write lock:
  // a disconnect, or a newer connect, made while PayPal was being asked wins (lib/store.ts connectPayPalSellerIf).
  const statsId = store.statsId;
  // And never when a disconnect was written at or after this connect began (Codex X5 on #4345).
  const saved = await connectPayPalSellerIf(ref, checked.merchant, () => onboardingStill(statsId, started), attemptStartedAt(started));
  if (saved === "stale") return away(origin, studio("#paypal"));
  if (!saved) return away(origin, studio("paypal=error#paypal"));
  // Only this attempt's own mark: a newer connect started meanwhile keeps its own (Codex G on #4345).
  await endOnboarding(store.statsId, started);
  if (store.paypalSeller?.merchant !== checked.merchant) after(() => noticeCreator(store, { kind: "paypal-connected" }));
  return away(origin, studio("paypal=ready#paypal"));
}
