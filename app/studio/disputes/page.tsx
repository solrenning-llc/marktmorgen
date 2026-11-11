import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { STORE_ID_PATTERN } from "@/lib/store";
import { can } from "@/lib/team-roles";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { DisputePurchaseReviewPanel } from "@/components/dispute-purchase-review";

export const metadata: Metadata = { title: "Disputed purchases — Marktmorgen", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
type Params = { searchParams: Promise<{ store?: string | string[] }> };
export default async function StudioDisputesPage({ searchParams }: Params) {
  const query = await searchParams;
  if (query.store !== undefined && (typeof query.store !== "string" || !STORE_ID_PATTERN.test(query.store))) redirect("/studio");
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "export");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  if (found.fellBack) redirect(studioPath(found.view.store));
  const { view } = found, { store } = view;
  return <div className="min-h-screen bg-paper text-ink">
    <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
    <StudioStorePin sid={store.sid}>
      <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
        <p className="eyebrow">Disputed purchases</p>
        <h1 className="t-h2 mt-3">Review one disputed purchase</h1>
        <p className="mt-3 max-w-2xl text-ink-soft">Check a payment on this store&apos;s Stripe account before preparing your response. This page only reads the purchase record; it does not send evidence or promise a result.</p>
        <DisputePurchaseReviewPanel connected={Boolean(store.stripeAccountId)} />
        {/* Only the account's owner may open that page (it reads the whole Stripe account), so only the owner is shown the link. */}
        {can(view.role, "payments") ? <p className="mt-8 text-sm text-ink-soft">Payments that never went through are elsewhere: <Link href={studioPath(store, "", "declines")} className="underline underline-offset-4">Payments that did not go through</Link></p> : null}
      </main>
    </StudioStorePin>
  </div>;
}
