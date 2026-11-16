/**
 * The store coach (added 9 October 2026): once a store is set up, what it
 * already does to sell, what it does not do yet, and a score out of 100.
 *
 * The "Getting your store ready" steps (components/studio-start.tsx) end
 * when a store can take money; Stan, Kajabi, Hotmart and the rest stop
 * there too. This goes on: each check is something stores that sell well
 * have — a picture and a line on every product, a sales page, a way to
 * stay in touch, answers before buying, reviews asked for, a blog — weighed
 * by how much a buyer misses it, each with the one place to fix it.
 *
 * Read only from the store's own record and the listings it already
 * carries (the first page's), so the studio asks nothing more to show it.
 * Pure, so it can be tested.
 */
import { KIND } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { kitShown } from "@/lib/store-kit";

export type StoreCheck = {
  id: string;
  label: string;
  why: string;
  done: boolean;
  weight: 1 | 2 | 3;
  /** Where it is fixed: a place on the studio's page ("#…") or another of its pages. */
  href: string;
};

export type StoreCoachInput = {
  /** The studio's address for one of its pages, for this store (lib/studio-route.ts, studioPath). */
  path: (page: string) => string;
};

/** The checks for a store with something on it; none for an empty one, which has its first steps first. */
export function storeChecks(store: Store, input: StoreCoachInput): StoreCheck[] {
  const listed = store.catalog.items.filter((item) => (item.kind & KIND.hidden) === 0);
  if (listed.length === 0) return [];
  const head = store.catalog.head.filter((p) => !p.hidden);
  const some = head.length > 0;
  const kinds = (bit: number) => listed.some((item) => (item.kind & bit) !== 0);
  const checks: StoreCheck[] = [
    {
      id: "pictures",
      label: "A picture on every product",
      why: "A card with a picture is the one a visitor looks at first.",
      done: some && head.every((p) => p.image !== null),
      weight: 3,
      href: "#products",
    },
    {
      id: "summaries",
      label: "A one-line summary on every product",
      why: "The line under the title says what the buyer gets before they open the page.",
      done: some && head.every((p) => p.summary.trim().length > 0),
      weight: 2,
      href: "#products",
    },
    {
      id: "page",
      label: "A sales page for what you sell",
      why: "Blocks with what is inside, who it is for, the questions buyers ask and your refund promise.",
      done: head.some((p) => p.page),
      weight: 3,
      href: input.path("pages"),
    },
    {
      id: "answers",
      label: "Answers before buying, by AI",
      why: "Visitors ask their question on the page and get an answer in seconds; with three products, they are helped to choose.",
      done: store.answers.on,
      weight: 2,
      href: "#answers",
    },
    {
      id: "reviews",
      label: "Buyers asked for a review",
      why: "One email a few days after buying; verified reviews are what a new visitor trusts.",
      done: store.reviewAsk.days > 0,
      weight: 2,
      href: input.path("reviews"),
    },
    {
      id: "list",
      label: "A way to stay in touch",
      why: "The sign-up box, or something free for an email, so a visitor who is not ready yet can hear from you later.",
      done: store.join.on || kinds(KIND.free),
      weight: 2,
      href: "#signup",
    },
    {
      id: "faq",
      label: "Questions answered on your store page",
      why: "How files arrive, how to pay, how to reach you: answered before a visitor has to ask. AI can draft them.",
      done: store.faq.length > 0,
      weight: 1,
      href: "#faq",
    },
    {
      id: "contact",
      label: "A way to write to you",
      why: "The contact form: questions before buying, collaborations and bookings reach your inbox.",
      done: store.contact.on,
      weight: 1,
      href: "#contact",
    },
    {
      id: "intro",
      label: "A welcome video",
      why: "A minute of you saying who you are and what the store is for: a face makes a stranger trust a store.",
      done: store.intro !== null,
      weight: 1,
      href: "#details",
    },
    {
      id: "socials",
      label: "Your profiles under your name",
      why: "Visitors check who you are before they buy from you.",
      done: store.socials.length > 0,
      weight: 1,
      href: "#details",
    },
    {
      id: "blog",
      label: "A post on your blog",
      why: "Posts on your store's address are found by search engines, and each can end on a product.",
      done: store.posts > 0,
      weight: 1,
      href: input.path("blog"),
    },
    {
      id: "tips",
      label: "A way for fans to support you",
      why: "Support my work: three amounts a fan can give with nothing bought, paid straight into your Stripe.",
      done: store.tips.on,
      weight: 1,
      href: "#support",
    },
    {
      id: "kit",
      label: "A media kit for brands",
      why: "Your audience, your rates and the brands you worked with on one page a brand can save as a PDF.",
      done: kitShown(store.kit),
      weight: 1,
      href: "#media-kit",
    },
  ];
  if (listed.length >= 3) {
    checks.push({
      id: "bundle",
      label: "A bundle of your products",
      why: "Several of your products for one price: a reason to buy more than one.",
      done: kinds(KIND.bundle),
      weight: 1,
      href: input.path("bundles"),
    });
  }
  if (listed.length >= 6) {
    checks.push({
      id: "sections",
      label: "Your products in sections",
      why: "A long store is easier to read cut into a few groups with a heading each.",
      done: store.sections.length > 0,
      weight: 1,
      href: "#products",
    });
  }
  return checks;
}

/** The score out of 100: the weight done, over the weight there is. */
export function storeScore(checks: StoreCheck[]): number {
  const total = checks.reduce((sum, check) => sum + check.weight, 0);
  if (!total) return 0;
  const done = checks.reduce((sum, check) => sum + (check.done ? check.weight : 0), 0);
  return Math.round((done / total) * 100);
}

/** What to do next: what is not done, the weightiest first, in the order above when equal. */
export function nextChecks(checks: StoreCheck[], limit = 4): StoreCheck[] {
  return checks
    .map((check, index) => ({ check, index }))
    .filter(({ check }) => !check.done)
    .sort((a, b) => b.check.weight - a.check.weight || a.index - b.index)
    .slice(0, limit)
    .map(({ check }) => check);
}
