/**
 * Whether Marktmorgen is open.
 *
 * Open means one thing: a creator can start a paid plan, which is the only
 * moment we take a card. While it is not, the site is a preview of something
 * still being built, and it says so on every public page instead of leaving
 * a visitor to work it out from a list: a store can be opened and set up, and
 * no plan can be started (app/api/billing/checkout/route.ts refuses, and the
 * studio shows no button that would be refused).
 *
 * Canceling and keeping an existing subscription do not read this. Changing
 * to a new plan does: an unreviewed commercial release cannot be bypassed.
 *
 * The server and browser read the same answer. Requesting opening is not
 * enough: the per-customer, after-tax margin review must also be complete,
 * the tax gate's setting must be one sales may be judged on (lib/tax-gate.ts:
 * the current source-based TX/SV policy, without consultation or EU-hosting
 * dependencies), and, since 18 October 2026, every jurisdiction where
 * a tax law makes Marktmorgen the supplier of what a store sells (EU VAT,
 * Implementing Regulation 282/2011 art. 9a; the UK; US states; other
 * countries) must have its treatment built and recorded
 * (lib/deemed-supplier.ts, docs/eu-vat-article-9a.md). A store sells only
 * with a plan (lib/store-checkout.ts canSell), so while this is false no
 * store's checkout opens either.
 */
import { commercialPlansMayOpen } from "@/lib/commercial-margin";
import { deemedSupplierReady } from "@/lib/deemed-supplier";
import { assistantMeetsFloor } from "@/lib/store-assistant-rules";
import { taxGateValid } from "@/lib/tax-gate";
import { stripePlatformEligibilityReady } from "@/lib/stripe-platform-eligibility";

const OPENING_REQUESTED: boolean = false;
export const PLANS_ON_SALE: boolean = commercialPlansMayOpen(OPENING_REQUESTED) && taxGateValid() && deemedSupplierReady() && stripePlatformEligibilityReady();

/**
 * Whether the Store assistant add-on can be bought (lib/assistant-billing.ts):
 * only when the plans are on sale, behind the same review, and only while
 * the add-on alone keeps positive net with the existing cost room at full use
 * (lib/store-assistant-rules.ts, assistantMeetsFloor). Under the most-tax
 * reading, all other release conditions still apply; positive arithmetic alone opens nothing.
 */
export const ASSISTANT_ON_SALE: boolean = PLANS_ON_SALE && assistantMeetsFloor();

// What every public page says at its top while plans are not on sale, and where it leads: words only,
// kept in lib/preview-words.ts so the site menu can say them without running the review above.
export { PREVIEW_LINE, PREVIEW_LINK } from "@/lib/preview-words";

/**
 * The words on a button that leads to making a store. The free days belong
 * to a plan, so a button promises them only while a plan can be started.
 */
export function startWords(trialDays: number): string {
  return PLANS_ON_SALE ? `Try it free for ${trialDays} days` : "Start your store";
}
