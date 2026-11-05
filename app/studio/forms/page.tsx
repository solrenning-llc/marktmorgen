import type { Metadata } from "next";
import { visiblePipelines } from "@/lib/pipeline-access-rules";
import { readPipelineAccess } from "@/lib/pipeline-access";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { FormsEditor, type SavedForm } from "@/components/forms-editor";
import { MAX_CONVERTIBLE_FORM_RESPONSES, formOpportunityRef } from "@/lib/form-opportunity";
import { readForms, readResponses } from "@/lib/form-store";
import { readCards } from "@/lib/catalog";
import { readTeam } from "@/lib/team";
import { readOpportunityReview, type OpportunityReviewData } from "@/lib/crm";
import { labeledStages } from "@/lib/crm-rules";
import { can } from "@/lib/team-roles";

export const metadata: Metadata = {
  title: "Forms — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/** How many answers of each form the studio lists; the file has all of them. */
const SHOWN = MAX_CONVERTIBLE_FORM_RESPONSES;

/**
 * The store's forms, surveys and quizzes (lib/forms.ts), and their answers.
 * Making them is part of the public page ("page"); their answers are shown
 * only to a role that may also download the store's files ("export"), since
 * they can hold people's addresses and words.
 */
export default async function StudioFormsPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "page");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const reads = can(view.role, "export");
  const forms = await readForms(store.statsId);
  const canCreateDeals = reads && can(view.role, "orders") && forms.length > 0;
  const emptyReview: OpportunityReviewData = { available: false, stages: [], deals: [], pipelines: [], versions: {} };
  const [reviewData, team] = canCreateDeals
    ? await Promise.all([readOpportunityReview(store.statsId), readTeam(store.sid).catch(() => null)])
    : [emptyReview, null] as const;
  // A teammate sees only the pipelines the store lets them, and makes deals only in those they may change (639 [GL7](7)).
  const restricted = view.role !== "owner" && view.role !== "admin";
  const access = canCreateDeals && restricted ? await readPipelineAccess(store.statsId, view.email).catch(() => null) : {};
  const seen = visiblePipelines(reviewData.pipelines, view.role, access);
  const seenStages = new Set(seen.flatMap((p) => p.stages.map((stage) => stage.id)));
  const changeable = seen.filter((p) => p.access === "edit").map((p) => ({ id: p.id, name: p.name, stages: p.stages }));
  // Each stage named with its pipeline once there is more than one (lib/crm-rules.ts).
  const dealStages = !restricted ? (reviewData.pipelines.length ? labeledStages(reviewData.pipelines) : reviewData.stages) : changeable.length ? labeledStages(changeable) : [];
  const existingDeals = reviewData.deals.filter((deal) => !restricted || seenStages.has(deal.stage)).map(({ id, title, email, stage, formResponseRef }) => ({ id, title, email, stage, formResponseRef }));
  const dealAssignees = team ? [...new Set([store.email, ...team.members.filter(member => can(member.role, "orders")).map(member => member.email)])] : [];
  const saved: SavedForm[] = await Promise.all(
    forms.map(async (form) => {
      const { responses, total } = reads ? await readResponses(store.statsId, form.id, SHOWN) : { responses: [], total: 0 };
      return { form, total, latest: responses.map(response => ({ ...response, opportunityRef: canCreateDeals && store.statsId ? formOpportunityRef(store.statsId, form.id, response) : undefined })) };
    }),
  );
  const cards = await readCards(store);
  const products = [...cards.values()].map((p) => ({ id: p.id, title: p.title }));
  const sid = store.sid;

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
          <p className="eyebrow">Forms</p>
          <h1 className="t-h2 mt-3">Forms, surveys and quizzes</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Ask your questions on one of your own pages: add a Form block to it under Pages. On a page that is a step of a funnel, sending the form leads on to the
            next step.
          </p>
          {canCreateDeals && !reviewData.available && saved.some(item => item.total > 0) ? <p className="notice notice-warn mt-6" role="status">Opportunities could not be checked. Answers and exports remain available; reload Forms before creating another opportunity. <a className="underline" href={`/studio/deals?store=${encodeURIComponent(sid)}`}>Open Deals</a></p> : null}
          <div className="mt-8">
            <FormsEditor key={sid} existingDealsAvailable={reviewData.available} existingDeals={existingDeals} currency={store.currency} dealAssignees={dealAssignees} sid={sid} dealStages={dealStages} saved={saved} products={products} exportBase={`/api/store/forms/export?${sid ? `store=${sid}&` : ""}id=`} />
          </div>
          {!reads && forms.length ? <p className="mt-4 text-sm text-ink-soft">Your role does not see the answers: they can hold people&apos;s addresses and words.</p> : null}
        </main>
      </StudioStorePin>
    </div>
  );
}
