import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { PlanInvoicesList } from "@/components/plan-invoices-list";
import { planInvoicesOf } from "@/lib/plan-invoices";
import { ESSENTIAL_PER_DAY } from "@/lib/studio-allowance-rules";

export const metadata: Metadata = {
  title: "Your plan's invoices — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * The invoices of this store's own Marktmorgen plan (601 [KB22] unit U5),
 * for whoever may manage its plan ("billing"), read from Stripe as the page
 * is drawn (lib/plan-invoices.ts). Reached from the plan card in the studio
 * ("What you pay us"), shown there only for a store with a plan subscription.
 */
export default async function StudioInvoicesPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "billing");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const read = await planInvoicesOf(store);
  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: `${studioPath(store)}#billing`, label: "Back to your plan", short: "Plan" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">Your plan</p>
          <h1 className="t-h2 mt-3">Your plan&apos;s invoices</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            {`The invoices Marktmorgen has made for this store's plan, newest first, read from Stripe when this page opens. Each one opens on Stripe's own page, where you can see it, download it and, if it is not paid yet, pay it.${read.state === "none" ? "" : ` Reading them from Stripe takes one of the ${ESSENTIAL_PER_DAY} billing requests your store has each day, the same ones that changing or canceling your plan, deleting your store and downloading your data use, and none of your studio's monthly requests beyond this page's own. Only the plan subscription your store has now is listed: invoices of an earlier one are not shown here.`}`}
          </p>
          <PlanInvoicesList read={read} />
        </main>
      </StudioStorePin>
    </div>
  );
}
