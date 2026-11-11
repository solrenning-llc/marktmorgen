import Link from "next/link";
import { REFUND_DAYS } from "@/lib/plan";
/** Existing terms and controls; no accounts, payment operation or certification. */
export function TrustChecks({place}:{place:"home"|"pricing"|"feature"}){
 const heading="trust-checks-"+place;
 return <section aria-labelledby={heading} data-trust-checks className="rounded-3xl border border-line bg-white p-6 sm:p-8">
 <h2 id={heading} className="t-h3">Check the terms before you commit</h2>
 <p className="mt-3 max-w-[46ch] text-ink-soft">Your work stays yours. Read how payments, data and leaving the platform work, then decide whether the fit is right.</p>
 <ul className="mt-6 grid gap-6 sm:grid-cols-2">
 <li><h3 className="font-semibold">Your own Stripe account</h3><p className="mt-2 text-sm text-ink-soft">Direct charges use the creator’s Stripe account. Stripe processing, payout timing, refunds and disputes still apply.</p><Link prefetch={false} href="/platform/your-stripe" className="link mt-2 inline-flex min-h-11 items-center">Follow the payment path</Link></li>
 <li><h3 className="font-semibold">Your records can leave with you</h3><p className="mt-2 text-sm text-ink-soft">Export the contact and order records your role can access. Keep a copy before closing a store; export does not move subscriptions to another provider.</p><Link prefetch={false} href="/privacy" className="link mt-2 inline-flex min-h-11 items-center">Read the data policy</Link></li>
 <li><h3 className="font-semibold">Cancellation from your studio</h3><p className="mt-2 text-sm text-ink-soft">Manage an existing platform subscription through Account. Review its end date and what closing a store changes for buyers.</p><Link prefetch={false} href="/terms#closing" className="link mt-2 inline-flex min-h-11 items-center">Review cancellation terms</Link></li>
 <li><h3 className="font-semibold">A clear platform refund policy</h3><p className="mt-2 text-sm text-ink-soft">{`The first platform payment can be requested back in full within ${REFUND_DAYS} days, under the Terms. A buyer’s refund for a creator’s product follows that offer and applicable rights.`}</p><Link prefetch={false} href="/refunds" className="link mt-2 inline-flex min-h-11 items-center">Read the refund terms</Link></li>
 </ul>
 <p className="mt-5 max-w-[46ch] text-sm text-ink-soft">Paid plans and paid selling remain subject to all opening gates. These terms do not mean sales are open or that earnings are guaranteed.</p>
 </section>;
}
