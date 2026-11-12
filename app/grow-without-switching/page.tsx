import type { Metadata } from "next";
import Link from "next/link";
import "../home.css";
import { MorningHeader } from "@/components/morning-header";
import { MORNING_FONTS } from "@/components/morning-fonts";
import { SiteFooter } from "@/components/site-footer";
import { growthSteps } from "@/lib/plan-growth";
import { PRICING_PLANS } from "@/lib/pricing-page-data";
import { PLANS_ON_SALE } from "@/lib/opening";
import { isDomainsConfigured } from "@/lib/domains";
import { paypalSalesConfigured } from "@/lib/paypal-sales";

export const metadata: Metadata = {
  title: "Grow without switching — Marktmorgen",
  description: "Start on Store and move to Studio or Scale in the same place: what each plan adds, from the published prices and limits, and what stays yours.",
  alternates: { canonical: "/grow-without-switching" },
};

/**
 * "Grow without switching" (245 [SP2], unit 1): the three plans, what each adds to the one below it (lib/plan-growth.ts,
 * from the pricing page's own rows), that the creator changes plan themselves, and what stays theirs. No promise of
 * earnings; no price, limit, name or number of plans is set here.
 */
export default function GrowWithoutSwitchingPage() {
  const steps = growthSteps(isDomainsConfigured());
  return (
    <div className={`${MORNING_FONTS} hm hm-page`}>
      <MorningHeader />
      <main id="content" tabIndex={-1} className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-8">
        <header className="max-w-3xl">
          <h1 className="t-h1">Grow without switching</h1>
          <p className="mt-3 text-lg">Start on Store. When your store needs more, move it to Studio or Scale. Your address, products, pages, buyers and their purchases stay exactly where they are: only your plan&apos;s allowances and features change.</p>
          {PLANS_ON_SALE ? null : <p className="mt-3 font-semibold">Paid plans and paid selling are not open yet. You can prepare your store now.</p>}
        </header>

        <section aria-labelledby="plans-title" className="mt-12">
          <h2 id="plans-title" className="t-h2">The three plans</h2>
          <ul className="mt-4 space-y-2 text-lg">
            {PRICING_PLANS.map((plan) => (
              <li key={plan.tier}>{`${plan.title}: ${plan.monthly}, or ${plan.annual}.`}</li>
            ))}
          </ul>
          <p className="mt-3"><Link href="/pricing#limits-heading" className="inline-flex min-h-11 items-center underline">See every limit of every plan on the pricing page</Link></p>
        </section>

        {steps.map((step) => (
          <section key={step.to} aria-labelledby={`adds-${step.to}`} className="mt-12 max-w-3xl">
            <h2 id={`adds-${step.to}`} className="t-h2">{`What ${step.toTitle} adds to ${step.fromTitle}`}</h2>
            <p className="mt-3">{`${step.toTitle} is ${step.toPrice.monthly}, or ${step.toPrice.annual}. Everything on ${step.fromTitle} stays; ${step.toTitle} adds to it.`}</p>
            {step.features.length ? (
              <ul className="mt-4 space-y-2">
                {step.features.map((feature) => <li key={feature}>{feature}</li>)}
              </ul>
            ) : null}
            {/* In the pricing page's own groups, each with its heading (2.4.10). */}
            {[...new Set(step.lines.map((line) => line.group))].map((group) => (
              <div key={group} className="mt-6">
                <h3 className="t-h3">{group}</h3>
                {step.periods[group] ? <p className="mt-1 text-sm">{step.periods[group]}</p> : null}
                <ul className="mt-3 space-y-2">
                  {step.lines.filter((line) => line.group === group).map((line) => (
                    <li key={line.label}>
                      <span className="font-semibold">{line.label}</span>
                      {`: ${line.from} on ${step.fromTitle}, ${line.to} on ${step.toTitle}.`}
                      {line.note ? <span className="mt-1 block text-sm">{line.note}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))}

        {/* Only while a plan can be bought: the switch refuses otherwise (app/api/billing/switch). */}
        {PLANS_ON_SALE ? (
          <section aria-labelledby="change-title" className="mt-12 max-w-3xl">
            <h2 id="change-title" className="t-h2">You change your plan yourself</h2>
            <p className="mt-3">The store&apos;s owner changes the plan from the plan card in the studio, with no call or message to anyone. Moving up keeps your store as it is and opens the larger plan&apos;s allowances.</p>
          </section>
        ) : null}

        <section aria-labelledby="yours-title" className="mt-12 max-w-3xl">
          <h2 id="yours-title" className="t-h2">What stays yours</h2>
          <ul className="mt-4 space-y-3">
            <li>{`Your buyers pay on your own Stripe account${paypalSalesConfigured() ? ", or your own PayPal account where you connect it" : ""}, so their payments and records are in your account, whatever plan you are on.`}</li>
            <li>While your plan runs, the store&apos;s owner or an Admin can download its main data as one file from the studio: your products and their pages, courses, forms and their answers, contacts and a summary of your orders. Files and videos download from their own pages.</li>
          </ul>
        </section>

        <p className="mt-12">
          <Link href="/signin?plan=creator&billing=month" className="btn btn-primary inline-flex min-h-12 items-center">Start your store</Link>
        </p>
      </main>
      <div className="hm-foot"><SiteFooter morning /></div>
    </div>
  );
}
