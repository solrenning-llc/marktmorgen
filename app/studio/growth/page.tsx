import { TemplateLibrary } from "@/components/template-library";
import { templateLibraryCards } from "@/lib/template-library";
import { storeBase } from "@/lib/purchase-email";
import { isFree } from "@/lib/store";
import { can } from "@/lib/team-roles";
import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { studioPath, studioView } from "@/lib/studio-route";
import { GROWTH_GOALS, growthActions, growthGoal, growthCampaignGoal, growthReview } from "@/lib/growth-plan";

import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { starterCard } from "@/lib/funnel-starter-catalog";

export const metadata: Metadata = { title: "Growth — Marktmorgen", robots: { index: false, follow: false } };
type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/** Canonical templates and already loaded catalog metadata. Private saved sections
 * are read only after their explicit button through the existing quota-checked API. */
export default async function GrowthPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "member");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store, role } = view;
  const goal = growthGoal(query.goal);
  const actions = growthActions(goal, role);
  const review = growthReview(goal,role);
  const campaignGoal = growthCampaignGoal(goal, role);
  const campaigns = campaignGoal ? FUNNEL_STARTERS.map(starterCard).filter(card => card.goal === campaignGoal) : [];
  const linkFor = (path: string) => path.startsWith("#") ? studioPath(store) + path : studioPath(store, "", path);
  return <div className="min-h-screen bg-paper text-ink">
    <StudioHeader current={store} role={role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
    <StudioStorePin sid={store.sid}>
      <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
        <StudioTrail store={store} here="Growth" />
        <h1 className="t-h2 mt-3">Choose your next business goal</h1>
        <p className="mt-3 max-w-2xl text-ink-soft">Choose one goal, review the steps, then open the tools you need. These are starting points, not forecasts or promises of sales.</p>
        {can(role,"stats") ? <p className="mt-5"><Link href={studioPath(store)+"#grow-your-sales"} prefetch={false} className="link inline-flex min-h-11 items-center">Grow your sales — settings and measured payment records</Link></p> : null}
        <nav aria-label="Growth goals" className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {GROWTH_GOALS.map(item => <Link key={item.id} prefetch={false} href={studioPath(store, "goal=" + item.id, "growth")} aria-current={goal === item.id ? "page" : undefined} className={"card min-h-32 p-5 " + (goal === item.id ? "ring-2 ring-violet-deep" : "")}>
            <span className="font-semibold">{item.label}</span>
            <span className="mt-2 block text-sm text-ink-soft">{item.hint}</span>
          </Link>)}
        </nav>
        <section aria-labelledby="growth-plan" className="card mt-8 p-5 sm:p-8">
          <h2 id="growth-plan" className="text-lg font-semibold">Your next steps</h2>
          {actions.length ? <ol className="mt-5 space-y-4">{actions.map((action,index) => <li key={action.title} className="flex items-start gap-4">
            <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-lilac font-semibold">{index+1}</span>
            <div className="min-w-0"><Link prefetch={false} className="inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4" href={linkFor(action.path)}>{action.title}</Link><p className="text-sm text-ink-soft">{action.why}</p></div>
          </li>)}</ol> : <p className="mt-4 text-sm text-ink-soft">Your role does not include the tools for this goal. Ask the store owner to work through this plan.</p>}
          <p className="mt-5 text-sm text-ink-soft">Open the relevant tool to review its current records. This guide does not check live checkout, delivery, consent or campaign readiness, and starts nothing automatically.</p>
        </section>
        {review ? <section className="card mt-8 p-5 sm:p-8" aria-labelledby="growth-review">
          <h2 id="growth-review" className="text-lg font-semibold">Measure one change</h2>
          <p className="mt-3">{review.question}</p>
          <details className="mt-3">
            <summary className="flex min-h-11 cursor-pointer items-center font-semibold underline underline-offset-4">Plan a fair comparison</summary>
            <ol className="mt-4 list-decimal space-y-4 pl-5 text-sm text-ink-soft">
              <li><h3 className="font-semibold text-ink">Record your starting point</h3><p className="mt-1">{review.baseline}</p></li>
              <li><h3 className="font-semibold text-ink">Choose one change</h3><p className="mt-1">{review.change}</p></li>
              <li><h3 className="font-semibold text-ink">Review the evidence</h3><p className="mt-1">{review.review}</p></li>
            </ol>
            <p className="mt-4 text-sm text-ink-soft">Write down your question and review date before making the change. If records are missing or groups differ, the result is inconclusive. This guide does not run a test, calculate a result or verify profit.</p>
          </details>
        </section> : null}
        {campaigns.length ? <section className="mt-8" aria-labelledby="growth-campaigns">
          <h2 id="growth-campaigns" className="t-h3">Campaigns for this goal</h2>
          <p className="mt-3 max-w-2xl text-ink-soft">Compare the journey and what you need before choosing a starting structure for your own offer.</p>
          <ul className="mt-5 grid items-start gap-4 sm:grid-cols-2">
            {campaigns.map(campaign => <li key={campaign.id} className="card min-w-0 p-5">
              <h3 className="font-semibold">{campaign.label}</h3>
              <p className="mt-2 text-sm text-ink-soft">{campaign.hint}</p>
              <p className="mt-3 text-sm text-ink-mute">{campaign.steps.length} steps · {campaign.pages} pages · {campaign.forms} {campaign.forms === 1 ? "form" : "forms"}</p>
              <details className="mt-3">
                <summary className="flex min-h-11 cursor-pointer items-center font-semibold underline underline-offset-4">Preview {campaign.label}</summary>
                <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-ink-soft">{campaign.steps.map((step,index) => <li key={index}>{step.title} — {step.kind === "product" ? "your product" : "page"}</li>)}</ol>
                <h4 className="mt-4 font-semibold">What you need</h4>
                {campaign.products.length ? <ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-ink-soft">{campaign.products.map((product,index) => <li key={index}>{product.label} ({product.wants})</li>)}</ul> : <p className="mt-2 text-sm text-ink-soft">No product needed. The application or sign-up form is included.</p>}
              </details>
            </li>)}
          </ul>
          <Link prefetch={false} className="btn btn-secondary mt-5" href={studioPath(store,"campaignGoal=" + campaignGoal,"funnels") + "#campaign-starters"}>Explore matching campaigns</Link>
          <p className="mt-3 text-sm text-ink-soft">These outlines come from the campaign templates. Review product choices, available room, consent and delivery in the setup preview before creating anything.</p>
        </section> : null}
        <TemplateLibrary
          cards={templateLibraryCards({fromName:store.mail?.fromName || store.name,storeLink:storeBase(store),ordersLink:storeBase(store)+"/orders",product:null,paidCount:0})}
          sid={store.sid}
          products={(store.catalog.inline ?? store.catalog.head).map(product => ({id:product.id,title:product.title,free:isFree(product),course:Boolean(product.course)}))}
          canPage={can(role,"products") && can(role,"page")}
          canCourse={can(role,"products")}
          canEmail={can(role,"draft")}
          canSequence={can(role,"send")}
        />
      </main>
    </StudioStorePin>
  </div>;
}
