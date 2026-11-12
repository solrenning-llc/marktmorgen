import type { Metadata } from "next";
import Link from "next/link";
import "../home.css";
import { MorningHeader } from "@/components/morning-header";
import { MORNING_FONTS } from "@/components/morning-fonts";
import { SiteFooter } from "@/components/site-footer";
import { StartQuiz } from "@/components/start-quiz";
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { MIGRATION_GUIDES } from "@/lib/migration-guides";
import { PLANS_ON_SALE } from "@/lib/opening";
import { PLAN_TITLES, publishedPriceWords } from "@/lib/plan";
import type { QuizFacts } from "@/lib/start-quiz";

export const metadata: Metadata = {
  title: "Where should I start? — Marktmorgen",
  description: "Three short questions about what you sell, and the pages, the template and the plan to start with. Nothing you choose is sent or kept.",
  alternates: { canonical: "/start-here" },
};

/** What the quiz may name, read from the code that makes it real: the templates, the importer's guides and the plan. */
function quizFacts(): QuizFacts {
  return {
    starters: Object.fromEntries(FUNNEL_STARTERS.map((s) => [s.id, { label: s.label, hint: s.hint }])),
    guides: MIGRATION_GUIDES.map((g) => ({ slug: g.slug, platform: g.platform })),
    plan: { tier: "creator", name: PLAN_TITLES.creator, monthly: publishedPriceWords("creator", "month"), yearly: publishedPriceWords("creator", "year"), onSale: PLANS_ON_SALE },
  };
}

/**
 * "Where should I start?" (562 [QZ1], unit 1): three questions answered in the browser (components/start-quiz.tsx,
 * lib/start-quiz.ts), with the pages, the template and the plan to start from. No email, no cookie, nothing sent.
 */
export default function StartHerePage() {
  return (
    <div className={`${MORNING_FONTS} hm hm-page`}>
      <MorningHeader />
      <main id="content" tabIndex={-1} className="mx-auto max-w-6xl px-4 pb-20 pt-8 sm:px-8">
        <header className="max-w-3xl">
          <h1 className="t-h1">Where should I start?</h1>
          <p className="mt-3 text-lg">Three short questions about what you sell. The answer shows the pages to read, the template to start from and the plan that has it.</p>
          <p className="mt-2">No email needed. Your answers stay in this browser: they are not sent or kept.</p>
        </header>
        <StartQuiz facts={quizFacts()} />
        <noscript>
          <p className="mt-8 max-w-3xl text-lg">This quiz needs JavaScript. Without it, <Link className="underline" href="/platform">see every feature</Link> or <Link className="underline" href="/pricing#plans">compare the plans</Link>.</p>
        </noscript>
      </main>
      <div className="hm-foot"><SiteFooter morning /></div>
    </div>
  );
}
