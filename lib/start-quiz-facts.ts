/**
 * What "Where should I start?" (562 [QZ1]; lib/start-quiz.ts) may name, read from the code that makes it real: the
 * studio's funnel templates, the importer's guides and the plan every option is on, with its published prices.
 * Read on the server by each page that shows the quiz (app/start-here, the blog's index and its articles) and handed
 * to the quiz in the browser.
 */
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { starterCard } from "@/lib/funnel-starter-catalog";
import { STARTER_GALLERY_TITLE } from "@/lib/funnel-niche-feature";
import { PAGES } from "@/lib/site-pages";
import { MIGRATION_GUIDES } from "@/lib/migration-guides";
import { PLANS_ON_SALE } from "@/lib/opening";
import { PLAN_TITLES, publishedPriceWords } from "@/lib/plan";
import type { QuizFacts } from "@/lib/start-quiz";

export function quizFacts(): QuizFacts {
  return {
    starters: Object.fromEntries(
      FUNNEL_STARTERS.map((s) => {
        const card = starterCard(s);
        // A sign-up form or a free product gathers addresses; writing to them as a list is not on every plan.
        return [s.id, { label: s.label, hint: s.hint, gathers: card.forms > 0 || card.products.some((p) => p.wants === "free") }];
      }),
    ),
    gallery: STARTER_GALLERY_TITLE,
    listPlan: { name: PLAN_TITLES.pro, monthly: publishedPriceWords("pro", "month") },
    // The importer's guides, and ClickFunnels', whose guide is a feature page of its own (lib/feature-pages.ts).
    guides: [
      ...MIGRATION_GUIDES.map((g) => ({ slug: g.slug, platform: g.platform })),
      ...(PAGES.some((p) => p.section === "platform" && p.slug === "move-from-clickfunnels") ? [{ slug: "move-from-clickfunnels", platform: "ClickFunnels" }] : []),
    ],
    plan: { tier: "creator", name: PLAN_TITLES.creator, monthly: publishedPriceWords("creator", "month"), yearly: publishedPriceWords("creator", "year"), onSale: PLANS_ON_SALE },
  };
}
