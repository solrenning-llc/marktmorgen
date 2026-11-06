import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { countStudio, studioPath, studioView } from "@/lib/studio-route";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { STORE_ID_PATTERN } from "@/lib/store";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { PlanInvoicesList } from "@/components/plan-invoices-list";
import { ESSENTIAL_WORDS, PLAN_INVOICES_PER_DAY, planInvoicesOf } from "@/lib/plan-invoices";

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
  // A store named twice or in another shape is never read as "the one remembered" (as app/studio/disputes).
  if (query.store !== undefined && (typeof query.store !== "string" || !STORE_ID_PATTERN.test(query.store))) redirect("/studio");
  // Counted below, once the store is the one asked for, so a store that cannot be opened is never counted twice (review 2).
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "billing", { count: false });
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  // Another store's invoices are never drawn under this one's address: back to the studio of the one that opened.
  if (found.fellBack) redirect(studioPath(found.view.store));
  const { view } = found;
  // The page's own STUDIO_PAGE_UNITS, as studioView counts every page and as the Terms say; past them, the paused page.
  const counted = await countStudio(view.store, null, STUDIO_PAGE_UNITS);
  if (!counted.ok) redirect(studioPath(view.store, `why=${counted.reason}`, "paused"));
  const store = counted.store ?? view.store;
  const read = await planInvoicesOf(store);
  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: `${studioPath(store)}#billing`, label: "Back to your plan", short: "Plan" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">Your plan</p>
          <h1 className="t-h2 mt-3">Your plan&apos;s invoices</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            {`The invoices Marktmorgen has made for this store's plan, newest first, read from Stripe when this page opens. Each one opens on Stripe's own page, where you can see it, download it and, if it is not paid yet, pay it.${read.state === "none" ? "" : ` Each read takes one of ${ESSENTIAL_WORDS}, and only while fewer than ${PLAN_INVOICES_PER_DAY} of them have been used, so changing or canceling your plan always keeps the rest. It takes none of your studio's monthly requests beyond this page's own. Only the plan subscription your store has now is listed: invoices of an earlier one are not shown here.`}`}
          </p>
          <PlanInvoicesList read={read} />
        </main>
      </StudioStorePin>
    </div>
  );
}
