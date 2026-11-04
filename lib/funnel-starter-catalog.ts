import type { FunnelStarter } from "@/lib/funnel-starters";

export const STARTER_GOALS = ["leads", "sales", "teaching", "services"] as const;
export type StarterGoal = (typeof STARTER_GOALS)[number];
export const STARTER_GOAL_LABELS: Record<StarterGoal, string> = {
  leads: "Grow your audience",
  sales: "Sell a product",
  teaching: "Teach or build a membership",
  services: "Book calls or find clients",
};

/** Only this small, public outline reaches the browser; no page blocks or store records. */
export type StarterCard = {
  id: string;
  label: string;
  hint: string;
  goal: StarterGoal;
  pages: number;
  forms: number;
  products: { label: string; wants: "free" | "paid" }[];
  steps: { title: string; kind: "page" | "product" }[];
};

const GOALS: Record<string, StarterGoal> = {
  "guide-signup": "leads",
  "launch-waitlist": "leads",
  "coaching-application": "services",
  "paid-call": "services",
  membership: "teaching",
  "course-free-lesson": "teaching",
  "recorded-workshop": "teaching",
  "digital-product": "sales",
  "course-launch": "teaching",
  "physical-product": "sales",
};

/** Derived from the actual bundle so the preview cannot drift from what is created. */
export function starterCard(starter: FunnelStarter): StarterCard {
  const { bundle } = starter;
  return {
    id: starter.id,
    label: starter.label,
    hint: starter.hint,
    goal: GOALS[starter.id] ?? "sales",
    pages: bundle.pages.length,
    forms: bundle.forms.length,
    products: bundle.products.map(({ label, wants }) => ({ label, wants })),
    steps: bundle.steps.map((step) => ({
      kind: step.kind,
      title: (step.kind === "page" ? bundle.pages.find((page) => page.ref === step.ref)?.title : bundle.products.find((product) => product.ref === step.ref)?.label) ?? "Step",
    })),
  };
}

const searchable = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * Who a campaign fits (242 [CF5], unit 1; added 2 November 2026): the same
 * kinds of creator as the site's pages for them (lib/feature-pages.ts,
 * section "for"), each with the campaigns that suit it and one line on how.
 * Nothing new is made: these are the same campaigns, the same pages and the
 * same parts in [brackets]; no result, figure or testimonial is said.
 */
export const STARTER_NICHES = ["coaches", "cooks", "fitness", "designers"] as const;
export type StarterNiche = (typeof STARTER_NICHES)[number];
export const STARTER_NICHE_LABELS: Record<StarterNiche, string> = {
  coaches: "Coaches and teachers",
  cooks: "Cooks and nutritionists",
  fitness: "Fitness creators",
  designers: "Designers and photographers",
};
export const NICHE_FIT: Record<StarterNiche, Record<string, string>> = {
  coaches: {
    "coaching-application": "For clients you choose to work with: they apply, and you read each one and decide.",
    "paid-call": "For a single session people book and pay for.",
    "course-free-lesson": "For one lesson people take free before the full course.",
    "recorded-workshop": "For a recorded class that leads to your program.",
    "course-launch": "For a full course, with what it covers laid out.",
    "guide-signup": "For a free guide that starts your list.",
  },
  cooks: {
    "guide-signup": "For a free recipe guide that starts your list.",
    "digital-product": "For a recipe pack or meal plan people download.",
    membership: "For recipes or plans as a course members open while they pay, which you can add to.",
    "course-free-lesson": "For one cooking lesson people take free before the full course.",
    "launch-waitlist": "For a cookbook or program you are still preparing.",
  },
  fitness: {
    membership: "For workouts or plans as a course members open while they pay, which you can add to.",
    "recorded-workshop": "For a recorded class that leads to your program.",
    "course-launch": "For a full training program, with its modules laid out.",
    "paid-call": "For one-to-one sessions people book and pay for.",
    "guide-signup": "For a free guide that starts your list.",
  },
  designers: {
    "digital-product": "For presets, templates or files people download.",
    "paid-call": "For a review or consultation people book and pay for.",
    "launch-waitlist": "For a collection you are still preparing.",
    "physical-product": "For prints or pieces you make and ship.",
    "guide-signup": "For a free guide that starts your list.",
  },
};

/** All terms must match; with a kind of creator, only the campaigns that fit it. Filtering is local and never spends a preview request. */
export function matchingStarters(cards: readonly StarterCard[], goal: StarterGoal | "all", query: string, niche: StarterNiche | "all" = "all"): StarterCard[] {
  const terms = searchable(query.trim().slice(0, 100)).split(/\s+/).filter(Boolean);
  return cards.filter((card) => {
    if (goal !== "all" && card.goal !== goal) return false;
    if (niche !== "all" && !NICHE_FIT[niche][card.id]) return false;
    // With a kind of creator chosen, its line is on the card, so it is searched too.
    const fit = niche !== "all" ? NICHE_FIT[niche][card.id] : "";
    const words = searchable([card.label, card.hint, fit, STARTER_GOAL_LABELS[card.goal], ...card.products.map((p) => p.label), ...card.steps.map((s) => s.title)].join(" "));
    return terms.every((term) => words.includes(term));
  });
}

/** Unknown values show every kind of creator. */
export function readStarterNiche(raw: unknown): StarterNiche | "all" {
  return typeof raw === "string" && (STARTER_NICHES as readonly string[]).includes(raw) ? (raw as StarterNiche) : "all";
}

/** Unknown and repeated URL values show everything. */
export function readStarterGoal(raw: unknown): StarterGoal | "all" {
  return typeof raw === "string" && (STARTER_GOALS as readonly string[]).includes(raw) ? raw as StarterGoal : "all";
}
