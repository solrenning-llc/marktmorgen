import { dealActionFilter } from "@/lib/crm-deal-filter";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { DealsBoard } from "@/components/deals-board";
import { DealChannelsLoader, DealChannelsWaiting } from "@/components/deal-channels-table";
import { Suspense } from "react";
import { readTeam } from "@/lib/team";
import { can } from "@/lib/team-roles";
import { readFields, readOpportunityReview } from "@/lib/crm";
import { DealsUnavailable } from "@/components/deals-unavailable";
import { pipelineLimit } from "@/lib/crm-rules";

export const metadata: Metadata = {
  title: "Deals, pipelines and fields — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * A store's deals, in its pipelines, and its own fields about each person (lib/crm-rules.ts),
 * for a role that may read orders with buyers' addresses ("orders"): a deal
 * names a person, and a field is something kept about one.
 */
export default async function StudioDealsPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "orders");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const [loadedFields, inventory, team] = await Promise.all([readFields(store.statsId).catch(() => null), readOpportunityReview(store.statsId), readTeam(store.sid).catch(() => null)]);
  const fields = loadedFields ?? [];
  const available = inventory.available && loadedFields !== null && team !== null;
  const assignees = [store.email, ...(team?.members ?? []).filter(m => can(m.role, "orders")).map(m => m.email)];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader
        current={store}
        role={view.role}
        stores={view.stores}
        owned={view.owned}
        action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }}
      />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">Deals and fields</p>
          <h1 className="t-h2 mt-3">Your deals, pipelines and what you keep about people</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Only your team sees any of this. Nothing here sends anything by itself; a workflow you set to start from a stage, under Email, can. Each person&apos;s answers to your fields are on their page under{" "}
            <a className="underline underline-offset-4" href={studioPath(store, "", "people")}>
              Buyers
            </a>
            .
          </p>
          <div className="mt-8">
            {available ? <DealsBoard key={(store.sid || store.handle) + ":" + dealActionFilter(query.followup)} deals={inventory.deals} stages={inventory.stages} pipelines={inventory.pipelines} pipelineMax={pipelineLimit(store)} fields={fields} currency={store.currency} assignees={assignees} today={today} initialFilter={dealActionFilter(query.followup)} requestHref={can(view.role, "send") ? studioPath(store, "", "requests") : undefined} /> : <DealsUnavailable storeId={store.sid} buyersHref={studioPath(store, "", "people")} fields={fields} followup={dealActionFilter(query.followup)} />}
          </div>
          {/* 639 [GL7](9): the deals' value by where their people first came from; streamed in after the board. */}
          {available ? (
            <Suspense fallback={<DealChannelsWaiting />}>
              <DealChannelsLoader store={store} deals={inventory.deals} stages={inventory.stages} />
            </Suspense>
          ) : null}
        </main>
      </StudioStorePin>
    </div>
  );
}
