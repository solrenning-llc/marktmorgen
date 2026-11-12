/**
 * What "Where should I start?" (562 [QZ1]; lib/start-quiz.ts) may name, read from the code that makes it real: the
 * studio's funnel templates, the importer's guides and the plan every option is on, with its published prices.
 * Read on the server by each page that shows the quiz (app/start-here, the blog's index and its articles) and handed
 * to the quiz in the browser.
 */
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { MIGRATION_GUIDES } from "@/lib/migration-guides";
import { PLANS_ON_SALE } from "@/lib/opening";
import { PLAN_TITLES, publishedPriceWords } from "@/lib/plan";
import type { QuizFacts } from "@/lib/start-quiz";

export function quizFacts(): QuizFacts {
  return {
    starters: Object.fromEntries(FUNNEL_STARTERS.map((s) => [s.id, { label: s.label, hint: s.hint }])),
    guides: MIGRATION_GUIDES.map((g) => ({ slug: g.slug, platform: g.platform })),
    plan: { tier: "creator", name: PLAN_TITLES.creator, monthly: publishedPriceWords("creator", "month"), yearly: publishedPriceWords("creator", "year"), onSale: PLANS_ON_SALE },
  };
}
