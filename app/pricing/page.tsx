import { TrustChecks } from "@/components/trust-checks";
import { PricingValue } from "@/components/pricing-value";
import type { Metadata } from "next";
import Link from "next/link";
import { Pricing } from "@/components/home-parts";
import { isDomainsConfigured } from "@/lib/domains";
import { feeWords } from "@/lib/fee-words";
import "../home.css";
import { MorningHeader } from "@/components/morning-header";
import { MORNING_FONTS } from "@/components/morning-fonts";
import { ToolsCalculator } from "@/components/tools-calculator";
import { SiteFooter } from "@/components/site-footer";
import { PRICING_PLANS, PRICING_GROUPS, PRICING_ADDONS, PRICING_QUESTIONS, PRICING_OPEN } from "@/lib/pricing-page-data";

export const metadata: Metadata = {
 title: "Pricing — Marktmorgen",
 description: "Compare Store, Studio and Scale: monthly and annual prices, usage allowances, optional add-ons and cancellation terms.",
 alternates: { canonical: "/pricing" },
};

const DOMAINS = isDomainsConfigured();

export default function PricingPage() {
 /* VS1 (queue item 571, unit 2): the home page's morning look and its menu
    (app/home.css .hm-page, components/morning-header.tsx); every price,
    allowance, term and link below is unchanged. */
 return <div className={`${MORNING_FONTS} hm hm-page`}><MorningHeader current="/pricing" /><main id="content" tabIndex={-1}>
  {/* 243 [CF6], owner's complement of 31/10/2026 23h14: the three plans, with price and limits, start on the
      first screen, right under the title; the tools and the comparison follow them. Whether paid plans are open is
      said once, here, beside the plans (the top banner of the site says it too). */}
  <div className="hm-page-hero"><div aria-hidden="true" className="hm-sky-layer"><div className="hm-blob hm-sun-page" /></div><div className="relative mx-auto max-w-6xl px-4 pb-4 pt-6 sm:px-8 sm:pt-6">
  <header className="max-w-3xl">
   <h1 className="t-h1">A clear price. Published limits.</h1>
   <p className="mt-3 text-lg">{feeWords().feesRow} All prices below are in USD.{PRICING_OPEN ? <> <Link className="underline [color:inherit]" href="/demo">See the live demo</Link>.</> : null}</p>
   {!PRICING_OPEN && <p className="mt-3 font-semibold">Paid plans and paid selling are not open yet. You can prepare your store and explore the <Link className="underline [color:inherit]" href="/demo">live demo</Link>.</p>}
  </header>
  </div></div>
  <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-8">
  {/*
    VS1: the three plan cards with the monthly/yearly switch, moved here from
    the old home page unchanged (components/home-parts.tsx Pricing). Each
    "Start on" link carries the plan and the billing rhythm into sign-up
    (/signin?plan=…&billing=…); prices come from lib/plan.ts. The home
    page's "Compare Store, Studio and Scale" link points at #plans.
  */}
  <section id="plans" data-plan-prices aria-labelledby="plans-heading" className="mt-2 scroll-mt-24">
   <h2 id="plans-heading" className="sr-only">Plan prices</h2>
   {/* No Suspense here: React streams a large boundary after the rest of the page even when it is ready,
       so the plans arrived after the first paint and pushed everything under them down (layout shift 0.38
       on a slow phone, 1 November 2026). The cards have none either; only each card's small perks disclosure keeps its own
       boundary, for hydrating apart (components/home-parts.tsx). Do not wrap the cards again. */}
   <Pricing domains={DOMAINS} />
  </section>
  <div className="mt-20"><PricingValue place="plans" /></div>
  <section aria-labelledby="limits-heading" className="mt-20">
   <h2 id="limits-heading" className="t-h2">What each plan includes</h2>
   <p className="mt-4 max-w-3xl">Each store has its own allowances. Count ceilings and storage limits apply together; a store can reach one before another. Annual billing does not turn a monthly allowance into a yearly pool.</p>
   {PRICING_GROUPS.map(group=><section key={group.id} aria-labelledby={group.id} className="mt-12">
    <h3 id={group.id} className="t-section">{group.title}</h3><p className="mt-3">{group.period}</p>
    <div className="mt-5 hidden md:block"><table className="w-full table-fixed text-left">
     <caption className="sr-only">{group.title} by plan</caption>
     <thead><tr><th scope="col" className="w-2/5 border-b border-line-strong p-3">Allowance</th>{PRICING_PLANS.map(p=><th key={p.tier} scope="col" className="border-b border-line-strong p-3">{p.title}</th>)}</tr></thead>
     <tbody>{group.rows.map(row=><tr key={row.key}><th scope="row" className="border-b border-line p-3 font-medium">{row.label}{row.note&&<span className="mt-2 block text-sm font-normal">{row.note}</span>}</th>{PRICING_PLANS.map(p=><td key={p.tier} className="border-b border-line p-3 align-top break-words">{row.values[p.tier]}</td>)}</tr>)}</tbody>
    </table></div>
    <dl className="mt-5 divide-y divide-line md:hidden">{group.rows.map(row=><div key={row.key} className="py-5"><dt className="font-semibold">{row.label}</dt><dd className="mt-3"><ul className="space-y-2">{PRICING_PLANS.map(p=><li key={p.tier}><span className="font-medium">{p.title}: </span>{row.values[p.tier]}</li>)}</ul>{row.note&&<p className="mt-3 text-sm">{row.note}</p>}</dd></div>)}</dl>
   </section>)}
   <p className="mt-6">Permissions, consent, funding checks and feature availability still apply. <Link className="underline" href="/terms">Read the Terms</Link> and <Link className="underline" href="/platform">explore each feature</Link> for its operating rules.</p>
  </section>
  <section aria-labelledby="addons-heading" className="mt-20"><h2 id="addons-heading" className="t-h2">Optional add-ons, priced separately</h2><div className="mt-6 grid gap-6 md:grid-cols-2">{PRICING_ADDONS.map((addon,i)=><article key={addon.key} className={`hm-addon p-6 ${i%2?"hm-bg-green":"hm-bg-rose"}`}><h3 className="t-h3">{addon.title}</h3><p className="mt-3 font-medium">{addon.price}</p><p className="mt-3">{addon.body}</p><Link className="mt-4 inline-flex min-h-11 items-center underline" href={addon.href}>Read {addon.title} details</Link></article>)}</div></section>
  <div className="mt-20"><TrustChecks place="pricing" /></div>
  <ToolsCalculator />
  <section aria-labelledby="compare-heading" className="mt-20 max-w-3xl"><h2 id="compare-heading" className="t-h2">Compare the tools you actually need</h2><p className="mt-4">A subscription price alone does not include every processing fee, extra or usage limit. Our comparisons show source dates, conditions and where the other platform goes further.</p><Link className="mt-5 inline-flex min-h-11 items-center underline" href="/proof/comparisons">See the platform comparisons</Link></section>
  <section aria-labelledby="faq-heading" className="mt-20 max-w-3xl [&_a]:inline-flex [&_a]:min-h-12 [&_a]:items-center [&_a]:px-1"><h2 id="faq-heading" className="t-h2">Questions about pricing</h2><div className="hm-faq-card mt-6 divide-y divide-line">{PRICING_QUESTIONS.map(question=><details key={question.q} className="group py-5"><summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 text-lg font-medium [&::-webkit-details-marker]:hidden"><span className="min-w-0">{question.q}</span><span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center"><span className="group-open:hidden">+</span><span className="hidden group-open:block">−</span></span></summary><p className="mt-4 leading-relaxed">{question.a}</p>{question.links?.length ? <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-3">{question.links.map(link=><li key={link.href}><Link href={link.href} prefetch={false} className="underline">{link.label}</Link></li>)}</ul> : null}</details>)}</div><p className="mt-6 flex flex-wrap gap-x-5 gap-y-3"><Link href="/terms" className="underline">Terms</Link><Link href="/refunds" className="underline">Refund Policy</Link><Link href="/help" className="underline">Help and support</Link></p></section>
 </div></main><div className="hm-foot"><SiteFooter morning /></div></div>;
}
