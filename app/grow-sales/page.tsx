import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";
import { PLANS_ON_SALE } from "@/lib/opening";
import { SITE_URL } from "@/lib/site-url";

export const metadata: Metadata = {
  title: "Use your sales numbers to take the next step — Marktmorgen",
  description: "Connect recorded sales to channels and campaigns, prepare product promotions, and manage affiliate links and commissions in your creator store.",
  alternates: { canonical: SITE_URL + "/grow-sales" },
};

const WORKFLOWS = [
  { number: "01", title: "Find the channels behind recorded sales", body: "Compare visits, paid records, revenue and recorded ad spend. Review first-visit, last-visit and buyer-reported sources when available. Renewals and refunds have their own views.", action: "Choose a channel using the evidence your store actually has.", tone: "bg-lilac" },
  { number: "02", title: "Prepare a promotion inside your numbers", body: "Choose a published product, channel, campaign and optional post or ad variant. Copy the tagged link from Numbers, then return to campaign results to review recorded visits and payments.", action: "Turn a result into a link you can share.", tone: "bg-mint-brand/15" },
  { number: "03", title: "Improve the path to a purchase", body: "Review the store funnel and product results. Rule-based suggestions can open a sales-page editor, checkout-reminder settings or the email composer when the recorded figures support that next step.", action: "Open the relevant tool from the finding.", tone: "bg-cream" },
  { number: "04", title: "Work with affiliates on real terms", body: "Set product commissions, assign coupons and provide promotional materials. Approved affiliates can make campaign links and see the labels available on their commission records. Track refunds, clearing periods and payout status.", action: "Help an affiliate promote a specific product and review what was recorded.", tone: "bg-pink-brand/10" },
];

export default function GrowSalesPage() {
  return <div className="flex min-h-screen flex-col bg-paper text-ink">
    <SiteNav />
    <main id="content" className="flex-1">
      <section className="relative overflow-hidden bg-lilac py-16 sm:py-24">
        <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-mint-brand/25 motion-safe:animate-pulse" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-24 -left-12 h-56 w-56 rotate-12 rounded-[60px] bg-amber-brand/20" />
        <div className="container-page relative grid items-center gap-12 lg:grid-cols-[1.2fr_0.8fr]">
          <div>
            <p className="eyebrow">From evidence to your next action</p>
            <h1 className="t-h1 balance mt-4">Review your recorded sales.<br /><span className="serif font-normal text-violet-deep">Prepare your next promotion.</span></h1>
            <p className="t-lead mt-6 max-w-2xl text-ink-soft">Your store, sales numbers, campaign links and selling tools work together. Start with what your store recorded, choose a useful next step, and review the result.</p>
            <div className="mt-8 flex flex-wrap gap-3"><Link href="/demo" className="btn btn-primary btn-lg">Explore the demo store</Link><Link href="/signin" className="btn btn-secondary btn-lg">Set up your store</Link></div>
            {!PLANS_ON_SALE ? <p className="mt-4 text-sm text-ink-soft">You can set up a store today. Paid plans are not on sale yet.</p> : null}
          </div>
          <div className="rounded-[28px] bg-white/80 p-6 shadow-sm ring-1 ring-violet-brand/15 sm:p-8">
            <p className="text-sm font-semibold text-violet-deep">A workflow, not a promise of results</p>
            <ol className="mt-5 space-y-4">
              {["Read your recorded results", "Choose a product and channel", "Prepare and share your campaign link", "Review the recorded outcome"].map((step,index)=><li key={step} className="flex items-center gap-4"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-brand/10 font-bold text-violet-deep" aria-hidden="true">{index+1}</span><span className="font-semibold">{step}</span></li>)}
            </ol>
            <p className="mt-6 text-sm leading-relaxed text-ink-soft">Your results depend on your product, audience and execution. A suggested action does not guarantee additional sales.</p>
          </div>
        </div>
      </section>

      <section className="container-page py-14 sm:py-20" aria-labelledby="selling-workflows">
        <h2 id="selling-workflows" className="t-h2 balance max-w-3xl">Keep the number and the next step together</h2>
        <div className="mt-9 grid gap-5 md:grid-cols-2">{WORKFLOWS.map(item=><article key={item.number} className={item.tone+" rounded-[24px] p-6 ring-1 ring-line sm:p-8"}>
          <p className="text-sm font-bold text-violet-deep">{item.number}</p><h3 className="mt-3 text-xl font-bold">{item.title}</h3>
          <p className="mt-3 leading-relaxed text-ink-soft">{item.body}</p><p className="mt-5 font-semibold">{item.action}</p>
        </article>)}</div>
      </section>

      <section className="surface-sand py-14 sm:py-20">
        <div className="container-page grid gap-10 lg:grid-cols-2">
          <div><h2 className="t-h2">Understand the money</h2><p className="mt-4 leading-relaxed text-ink-soft">Gross revenue is before refunds, payment fees, tax, affiliate commissions and other costs. A channel with attributed revenue is not proof that advertising caused a sale. Reports distinguish recorded payments, renewals, refunds and ad spend so those figures can be read in context.</p></div>
          <div><h2 className="t-h2">Ask questions and stay informed</h2><p className="mt-4 leading-relaxed text-ink-soft">When AI is enabled, ask sales questions in plain language and check the figures cited in the answer. Configured alerts and summaries can go to email, Slack or Discord. Goals and period comparisons help you review progress; forecasts are labeled as estimates.</p></div>
        </div>
      </section>

      <section className="container-page py-14 sm:py-20">
        <div className="grid gap-8 lg:grid-cols-2">
          <article className="rounded-[24px] bg-mint-brand/10 p-6 sm:p-8"><h2 className="text-xl font-bold">Make the affiliate relationship clear</h2><p className="mt-3 leading-relaxed text-ink-soft">Affiliate posts include a commission disclosure. Tracking cookies ask for permission where required; an assigned coupon can provide another way to credit a purchase. Campaign labels describe the checkout or subscription record available, rather than a complete history of a buyer.</p><p className="mt-3 leading-relaxed text-ink-soft">Creators fund and pay their own affiliates. Payout reminders and configured PayPal automatic payouts follow the program terms and clearing checks; a pending payout is not shown as money received.</p><Link href="/affiliate-programs" className="mt-5 inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4">Explore listed affiliate programs</Link></article>
          <article className="rounded-[24px] bg-violet-brand/5 p-6 sm:p-8"><h2 className="text-xl font-bold">Share and connect your reporting</h2><p className="mt-3 leading-relaxed text-ink-soft">Share a read-only numbers link with a password, expiration and revocation. Download reports or use the API and signed webhooks with your connected tools.</p><p className="mt-3 leading-relaxed text-ink-soft">Features depend on your plan, permissions and connected services. Incomplete financial readings stay unavailable. Untagged or older activity may have no campaign label. Aggregate traffic counts and recorded sales are not an individual buyer journey.</p><Link href="/developers" className="mt-5 inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4">Read the integration documentation</Link></article>
        </div>
        <div className="mt-12 flex flex-wrap justify-center gap-3"><Link href="/demo" className="btn btn-primary btn-lg">Explore the demo store</Link><Link href="/#pricing" className="btn btn-secondary btn-lg">See plans and availability</Link></div>
      </section>
    </main>
    <SiteFooter />
  </div>;
}
