import { StudioScreens } from "@/components/studio-screens";
import { HomeReasonsDetail } from "@/components/home-reasons-detail";
import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { FeatureCatalogue } from "@/components/feature-catalogue";
import { RevealOnScroll } from "@/components/home-parts";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { PAGES, type TopicPage } from "@/lib/site-pages";
import { PUBLISHED_PLAN_PRICES as PLAN_PRICES, TRIAL_DAYS } from "@/lib/plan";
import { CREATOR_JOURNEY } from "@/lib/creator-journey";
import { HOME_MODULES } from "@/lib/home-modules";
import { PLANS_ON_SALE, startWords } from "@/lib/opening";

export const metadata: Metadata = {
  title: "How it works — from your first offer to your next step | Marktmorgen",
  description:
    "Create, charge, deliver, sell more, automate and grow: follow the creator journey through existing Marktmorgen tools, their requirements and plan limits. Paid selling remains subject to availability.",
};

const GROUPS: { key: NonNullable<TopicPage["group"]>; title: string; line: string }[] = [
  { key: "sell", title: "Sell", line: "Files, courses, memberships, calls, and a community with live events, from one page, with a sales page for each." },
  { key: "paid", title: "Get paid", line: "Your connected Stripe account handles checkout when paid selling is available." },
  { key: "deliver", title: "Deliver", line: "Access follows the recorded payment and the product's terms." },
  { key: "grow", title: "Grow", line: "Your list, your reviews, your numbers, your affiliates, your team, your other tools, your own domain, and the way in from another platform." },
];

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** Every feature page, grouped the way a creator thinks about a store. */
export default function PlatformIndex() {
  const features = PAGES.filter((p) => p.section === "platform" && p.menu && p.group);
  const creators = PAGES.filter((p) => p.section === "for");

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <RevealOnScroll />
      <SiteNav />
      <main id="content" className="flex-1">
        <section className="surface-dawn border-b border-line">
          <div className="container-page py-14 sm:py-20">
            <p className="eyebrow nb-fade-up">How it works</p>
            <h1 className="t-h1 balance nb-fade-up nb-delay-1 mt-4 max-w-3xl">
              From your first offer to <span className="serif font-normal text-violet-deep">what comes next</span>
            </h1>
            <p className="t-lead nb-fade-up nb-delay-2 mt-5 max-w-2xl text-ink-soft">
              {`Follow the work in six stages: Create, Charge, Deliver, Sell more, Automate and Grow. Each link explains an existing tool, its requirements and the plan it comes with. Store starts at ${dollars(PLAN_PRICES.creator.month)} a month when paid selling is available.`}
            </p>
            {!PLANS_ON_SALE ? <p className="notice mt-6 max-w-2xl" data-journey-closed>Paid selling is not open yet. You can prepare your store and explore the demo; payment and selling features remain subject to the opening requirements.</p> : null}
            <div className="nb-fade-up nb-delay-3 mt-8 flex flex-wrap items-center gap-3">
              <Link href="/signin" className="btn btn-primary btn-lg">
                {startWords(TRIAL_DAYS)}
                <Icon name="arrow-right" size={18} />
              </Link>
              <Link href="/mission" className="btn btn-secondary btn-lg">
                What is not built yet
                <Icon name="arrow-right" size={18} />
              </Link>
            </div>
          </div>
        </section>

        <HomeReasonsDetail />
        <StudioScreens />

        <div className="container-page space-y-16 py-14 sm:py-18">
        <section className="section" aria-labelledby="home-modules-heading">
          <div className="container-page">
            <h2 id="home-modules-heading" className="t-h2 balance scroll-mt-32" tabIndex={-1}>Everything in one place</h2>
            <p className="mt-5 max-w-3xl text-ink-soft">Choose the tools your work needs, with the limits and conditions shown before you commit. {PLANS_ON_SALE ? "The live demo shows the buyer experience." : "Paid selling remains closed; the live demo shows the buyer experience."}</p>
            <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {HOME_MODULES.map(capability=><li key={capability.name} className="rounded-2xl border border-line bg-white p-6">
                <h3 className="text-xl font-semibold"><Link href={capability.href} prefetch={false} className="underline decoration-line underline-offset-4">{capability.name}</Link></h3>
                <p className="mt-3 text-ink-soft">{capability.body}</p>
              </li>)}
            </ul>
            <div className="mt-8 rounded-2xl bg-lilac p-6">
              <h3 className="text-xl font-semibold">Compare your current tools and their costs</h3>
              <p className="mt-3 text-ink-soft">Use published subscription prices, your sales volume and your applicable fee quotes. Unknown costs stay unconfirmed; the calculator makes no promise of earnings or identical features.</p>
              <Link href="/pricing#calculator-heading" prefetch={false} className="link mt-4 inline-block">Open the browser-only cost calculator</Link>
            </div>
          </div>
        </section>

          <section aria-labelledby="creator-journey-title" data-creator-journey>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div><h2 id="creator-journey-title" className="t-h2 balance">Your creator journey</h2><p className="mt-4 max-w-2xl text-ink-soft">Start with the stage you need. Add the rest when it serves your work; every tool keeps its existing limits and permissions.</p></div>
              <a href="#catalogue-title" className="link inline-flex min-h-11 items-center">Browse every feature</a>
            </div>
            <ol className="mt-8 grid gap-5 md:grid-cols-2">
              {CREATOR_JOURNEY.map((stage,index)=><li key={stage.id} id={`journey-${stage.id}`} className="rounded-2xl border border-line bg-white p-6 sm:p-8">
                <p className="text-sm font-semibold text-violet-deep">{`Step ${index+1}`}</p>
                <h3 className="mt-2 text-2xl font-semibold tracking-tight">{stage.title}</h3>
                <p className="mt-4 text-ink-soft">{stage.body}</p>
                <ul className="mt-5 space-y-3">{stage.features.map(feature=><li key={feature.slug}><Link href={`/platform/${feature.slug}`} prefetch={false} className="inline-flex min-h-11 scroll-mt-32 items-center gap-2 font-semibold text-violet-deep underline underline-offset-4">{feature.label}<Icon name="arrow-right" size={16}/></Link></li>)}</ul>
              </li>)}
            </ol>
          </section>

          <section className="reveal" aria-labelledby="catalogue-title">
            <h2 id="catalogue-title" className="t-h2 mb-8 scroll-mt-32" tabIndex={-1}>
              The feature catalog
            </h2>
            <FeatureCatalogue
              groups={GROUPS.map((g) => ({ key: g.key, title: g.title, line: g.line }))}
              items={features.map((p) => ({
                slug: p.slug,
                label: p.menu!.label,
                description: p.menu!.description,
                icon: p.menu!.icon,
                group: p.group!,
                status: p.badge.tone,
                statusLabel: p.badge.label,
                plan:
                  p.plan === "pro"
                    ? `Studio, ${dollars(PLAN_PRICES.pro.month)} a month`
                    : `${dollars(PLAN_PRICES.creator.month)} Store plan, and Studio`,
              }))}
            />
          </section>

          <section className="reveal" aria-labelledby="group-creators">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <h2 id="group-creators" className="t-h2">By kind of creator</h2>
              <p className="text-ink-soft">The same features, put together for what you sell.</p>
            </div>
            <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {creators.map((p) => (
                <li key={p.slug}>
                  <Link href={`/for/${p.slug}`} className="flex h-full items-center justify-between gap-3 rounded-[var(--r-md)] border border-line bg-white px-5 py-4 font-semibold text-ink transition-colors hover:bg-sand">
                    {p.eyebrow.replace(/^For /, "").replace(/^./, (c) => c.toUpperCase())}
                    <Icon name="arrow-right" size={16} className="text-violet-deep" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
