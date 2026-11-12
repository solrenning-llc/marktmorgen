/**
 * "Where should I start?" (562 [QZ1], unit 1; added 12 November 2026): three short questions for a visitor of
 * marktmorgen.com, and an answer that points at what already exists here: the page for their kind of creator, the
 * page of the feature they need, the funnel template to start from in the studio, the plan that has it, with its
 * published price, and the importer's guide when they sell somewhere else today.
 *
 * It runs in the browser: the answers are never sent or kept, no email is asked for, nothing is tracked. The
 * result promises no sale, income or result. Every option is something Marktmorgen does today, and every page and
 * template it names is checked to exist (tests/start-quiz.test.ts). Browser-safe: plain data and a pure function.
 */

export type SellKind = "files" | "course" | "membership" | "calls" | "physical";
export type Audience = "starting" | "following";

export type QuizChoice = { id: string; label: string };
export type QuizQuestion = { id: "sell" | "audience" | "from"; ask: string; choices: QuizChoice[] };

export const SELL_CHOICES: readonly { id: SellKind; label: string }[] = [
  { id: "files", label: "Downloads, like guides, templates or presets" },
  { id: "course", label: "Online courses or lessons" },
  { id: "membership", label: "A membership or a community" },
  { id: "calls", label: "Calls, coaching or consulting" },
  { id: "physical", label: "Things I ship, like books, clothes or food" },
];

export const AUDIENCE_CHOICES: readonly { id: Audience; label: string }[] = [
  { id: "starting", label: "Not yet: I am starting out" },
  { id: "following", label: "Yes: people already read, watch or follow me" },
];

/**
 * What each answer to the first question leads to: the feature's page (/platform/<slug>), the page for that kind
 * of creator when there is one (/for/<slug>), and the funnel template (lib/funnel-starters.ts) for someone starting
 * out and for someone with a following. Starting out, a template that gathers people comes first; with a
 * following, one that sells.
 */
export const SELL_PATHS: Readonly<Record<SellKind, { feature: string; featureLink: string; forPage: string | null; forLink: string | null; starter: Record<Audience, string> }>> = {
  files: { feature: "instant-delivery", featureLink: "How downloads are delivered", forPage: null, forLink: null, starter: { starting: "guide-signup", following: "digital-product" } },
  course: { feature: "courses", featureLink: "How courses work", forPage: "course-creators", forLink: "Marktmorgen for course creators", starter: { starting: "course-free-lesson", following: "course-launch" } },
  membership: { feature: "memberships", featureLink: "How memberships work", forPage: "community-builders", forLink: "Marktmorgen for community builders", starter: { starting: "launch-waitlist", following: "membership" } },
  calls: { feature: "calls", featureLink: "How booked calls work", forPage: "consultants-and-mentors", forLink: "Marktmorgen for consultants and mentors", starter: { starting: "coaching-application", following: "paid-call" } },
  physical: { feature: "checkout", featureLink: "How checkout and shipping work", forPage: null, forLink: null, starter: { starting: "launch-waitlist", following: "physical-product" } },
};

/** The questions, the third built from the importer's guides that exist (lib/migration-guides.ts). */
export function quizQuestions(guides: readonly { slug: string; platform: string }[]): QuizQuestion[] {
  return [
    { id: "sell", ask: "What do you sell, or want to sell?", choices: [...SELL_CHOICES] },
    { id: "audience", ask: "Do people already follow your work?", choices: [...AUDIENCE_CHOICES] },
    {
      id: "from",
      ask: "Do you sell on another platform today?",
      choices: [{ id: "no", label: "No" }, ...guides.map((g) => ({ id: g.slug, label: `Yes, on ${g.platform}` })), { id: "other", label: "Yes, somewhere else" }],
    },
  ];
}

/** What the server hands the quiz: the templates' names, the guides and the plan, all read from the code. */
export type QuizFacts = {
  /** Each template's name and line, and whether it gathers email addresses (a sign-up form or a free product). */
  starters: Readonly<Record<string, { label: string; hint: string; gathers: boolean }>>;
  /** The studio's own name for the templates' gallery (lib/funnel-niche-feature.ts). */
  gallery: string;
  /** The plan that writes to a list, with its published monthly price: said beside a template that gathers addresses. */
  listPlan: { name: string; monthly: string };
  guides: readonly { slug: string; platform: string }[];
  /** The plan every option above is on, with its published prices; `onSale` false says plans are not sold yet. */
  plan: { tier: string; name: string; monthly: string; yearly: string; onSale: boolean };
};

export type QuizLink = { href: string; text: string };
export type QuizResult = {
  links: QuizLink[];
  starter: { label: string; hint: string; gathers: boolean };
  gallery: string;
  listPlan: QuizFacts["listPlan"];
  plan: QuizFacts["plan"];
  /** Where to start: sign-up with the plan chosen, the way the pricing page's cards go. */
  start: QuizLink;
  /** The guide for the platform they named, the general one for another, or null when they sell nowhere else. */
  moving: QuizLink | null;
};

/** The answer, or null until the three questions are answered with choices that exist. */
export function quizResult(facts: QuizFacts, answers: Partial<Record<QuizQuestion["id"], string>>): QuizResult | null {
  const sell = SELL_CHOICES.find((c) => c.id === answers.sell)?.id;
  const audience = AUDIENCE_CHOICES.find((c) => c.id === answers.audience)?.id;
  const from = answers.from;
  if (!sell || !audience || !from) return null;
  const known = from === "no" || from === "other" || facts.guides.some((g) => g.slug === from);
  if (!known) return null;
  const path = SELL_PATHS[sell];
  const starter = facts.starters[path.starter[audience]];
  if (!starter) return null;
  const links: QuizLink[] = [];
  if (path.forPage && path.forLink) links.push({ href: `/for/${path.forPage}`, text: path.forLink });
  links.push({ href: `/platform/${path.feature}`, text: path.featureLink });
  const guide = facts.guides.find((g) => g.slug === from);
  const moving = guide
    ? { href: `/platform/${guide.slug}`, text: `Moving from ${guide.platform}: what comes across, step by step` }
    : from === "other"
      ? { href: "/platform/switching-to-marktmorgen", text: "Moving from another platform: what comes across, step by step" }
      : null;
  return { links, starter, gallery: facts.gallery, listPlan: facts.listPlan, plan: facts.plan, start: { href: `/signin?plan=${facts.plan.tier}&billing=month`, text: "Start your store" }, moving };
}
