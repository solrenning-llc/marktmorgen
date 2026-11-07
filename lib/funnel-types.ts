/**
 * Funnels to start from, by kind (added 13 October 2026).
 *
 * ClickFunnels opens its builder on a choice of funnel types — lead magnet,
 * webinar, challenge, product launch, book, tripwire, application — and a
 * creator coming from it expects to pick one and be handed the shape. A
 * funnel here is already the store's own pages and its products' pages in
 * an order (lib/page-funnel.ts); a type is that order written down once:
 * which products it walks through, in which roles, and which of the store's
 * own pages it needs, with the blocks those pages start with.
 *
 * What a type never does is write a sentence. The pages it makes are empty
 * blocks under the page's title, kept back from visitors until the creator
 * fills them in and lets them out (a funnel passes over a page that is kept
 * back, so a half-made funnel never shows an empty page); the products are
 * the creator's own, chosen from their store. Nothing is priced, promised or
 * counted down for the creator. That is also why there is no "webinar" that
 * pretends to be live: a recorded training is called one.
 *
 * Pure and browser-safe: the studio lists these, and the route that builds a
 * funnel from one (app/api/store/page-funnels) reads the same list.
 */
import type { BlockKind } from "@/lib/sales-page";

/** A product the funnel walks through, chosen from the store. */
export type ProductSlot = {
  kind: "product";
  key: string;
  label: string;
  /** What it has to be: free (it asks for an email), paid, or either. */
  wants: "free" | "paid" | "any";
};

/** One of the store's own pages, made for the funnel, empty and kept back until the creator lets it out. */
export type PageSlot = {
  kind: "page";
  key: string;
  title: string;
  slug: string;
  blocks: BlockKind[];
  /**
   * Where its buttons lead when the page is opened on its own: a call, or a
   * product chosen for the funnel. Inside the funnel they lead to its next
   * step (app/[handle]/[slug]/page.tsx).
   */
  target?: string;
  /**
   * A form the page asks, made with it (lib/forms.ts): questions anyone asks
   * at that step, none of them a claim, and the form block among the page's
   * blocks points at it.
   */
  form?: { name: string; fields: { type: "short" | "long" | "email"; label: string; required: boolean }[] };
};

/** A product the funnel's page leads to without it being a step: a call, booked on a page of its own. */
export type TargetSlot = { kind: "target"; key: string; label: string; wants: "call" };

export type FunnelSlot = ProductSlot | PageSlot | TargetSlot;

export type FunnelType = { id: string; label: string; hint: string; slots: FunnelSlot[] };

const thanks: PageSlot = { kind: "page", key: "thanks", title: "You're all set", slug: "all-set", blocks: ["hero", "steps", "cta"] };

export const FUNNEL_TYPES: FunnelType[] = [
  {
    id: "lead-magnet",
    label: "Lead magnet",
    hint: "A free download for an email, then a first paid product, then a page that says what happens next.",
    slots: [
      { kind: "product", key: "freebie", label: "The free download they sign up for", wants: "free" },
      { kind: "product", key: "offer", label: "What you offer them next", wants: "paid" },
      thanks,
    ],
  },
  {
    id: "training",
    label: "Video training",
    hint: "A page with a recorded training, then the product it leads to, then a page that says what happens next. Recorded, and called recorded.",
    slots: [
      { kind: "page", key: "training", title: "Free training", slug: "free-training", blocks: ["hero", "video", "bio", "cta"] },
      { kind: "product", key: "offer", label: "The product the training leads to", wants: "paid" },
      thanks,
    ],
  },
  {
    id: "challenge",
    label: "Challenge",
    hint: "A free course whose lessons open a day at a time, a page about what comes after it, then your paid product.",
    slots: [
      { kind: "product", key: "challenge", label: "The free challenge: a free course whose lessons open one day at a time", wants: "free" },
      { kind: "page", key: "next", title: "What's next", slug: "whats-next", blocks: ["hero", "steps", "cta"] },
      { kind: "product", key: "offer", label: "Your paid product", wants: "paid" },
      thanks,
    ],
  },
  {
    id: "launch",
    label: "Product launch",
    hint: "Three video pages, each leading to the next, then the sales page of what you are launching.",
    slots: [
      { kind: "page", key: "video-1", title: "Video 1", slug: "video-1", blocks: ["hero", "video", "text", "cta"] },
      { kind: "page", key: "video-2", title: "Video 2", slug: "video-2", blocks: ["hero", "video", "text", "cta"] },
      { kind: "page", key: "video-3", title: "Video 3", slug: "video-3", blocks: ["hero", "video", "text", "cta"] },
      { kind: "product", key: "offer", label: "What you are launching", wants: "paid" },
    ],
  },
  {
    id: "book",
    label: "Book",
    hint: "Your book's page and the offers it already has after paying, then a page that says what happens next.",
    slots: [{ kind: "product", key: "book", label: "Your book: printed and shipped by you, or a download", wants: "any" }, thanks],
  },
  {
    id: "first-purchase",
    label: "Small first purchase",
    hint: "A low-priced first product, then your main product, then a page that says what happens next.",
    slots: [
      { kind: "product", key: "starter", label: "A low-priced first product", wants: "paid" },
      { kind: "product", key: "main", label: "Your main product", wants: "paid" },
      thanks,
    ],
  },
  {
    // 530 [FT3]. One page between a post or an ad and one of the creator's
    // products: a title, a short video in the players the store already has,
    // and one button. The button leads to the product's page, where its
    // checkout is: as the funnel's next step, and through the page's own
    // target when someone opens the page on its own. It asks nothing, so it
    // has no form. Listed after the first five kinds, which the site's
    // picture of funnels shows (components/feature-visuals.tsx).
    id: "bridge",
    label: "Bridge page",
    hint: "One page between a post or an ad and one of your products: a title, a short video of you and one button to that product's page, where its checkout is. No form.",
    slots: [
      { kind: "page", key: "bridge", title: "A word from me", slug: "a-word-from-me", blocks: ["hero", "video", "cta"], target: "product" },
      { kind: "product", key: "product", label: "The product the page leads to", wants: "any" },
    ],
  },
  {
    id: "application",
    label: "Application",
    hint: "A page that says who you work with and how, with an application form. You read each one, and answer the people you want to work with.",
    slots: [
      {
        kind: "page",
        key: "apply",
        title: "Work with me",
        slug: "work-with-me",
        blocks: ["hero", "fit", "steps", "form", "faq"],
        form: {
          name: "Application",
          fields: [
            { type: "short", label: "Your name", required: true },
            { type: "email", label: "Your email", required: true },
            { type: "long", label: "What would you like help with?", required: true },
            { type: "long", label: "What have you tried so far?", required: false },
          ],
        },
      },
    ],
  },
  {
    id: "quiz",
    label: "Quiz",
    hint: "A page with a quiz whose results each suggest one of your products, then a page that says what happens next. You write the questions and the results.",
    slots: [
      {
        kind: "page",
        key: "quiz",
        title: "Find what fits you",
        slug: "quiz",
        blocks: ["hero", "form"],
        form: { name: "Quiz", fields: [{ type: "email", label: "Your email", required: false }] },
      },
      thanks,
    ],
  },
];

export function funnelType(id: unknown): FunnelType | null {
  return FUNNEL_TYPES.find((type) => type.id === id) ?? null;
}

/** The pages a type makes: what has to fit in the store's pages before it can be built. */
export function pagesOf(type: FunnelType): PageSlot[] {
  return type.slots.filter((slot): slot is PageSlot => slot.kind === "page");
}

/** The products a creator chooses for a type: its steps and the call its page leads to. */
export function choicesOf(type: FunnelType): (ProductSlot | TargetSlot)[] {
  return type.slots.filter((slot): slot is ProductSlot | TargetSlot => slot.kind !== "page");
}

/** What a product has to be for a slot, as the catalog knows it. */
export type ProductFacts = { free: boolean; call: boolean };

/** Why a product cannot fill a slot, or null when it can. */
export function slotProblem(slot: ProductSlot | TargetSlot, product: ProductFacts | null): "missing" | "free" | "paid" | "call" | null {
  if (!product) return "missing";
  if (slot.wants === "call") return product.call ? null : "call";
  // A call is booked on a page of its own, so it is never a step (lib/page-funnel.ts).
  if (product.call) return "call";
  if (slot.wants === "free" && !product.free) return "free";
  if (slot.wants === "paid" && product.free) return "paid";
  return null;
}

/** An address under the store not yet taken by its pages, numbered when the plain one is. */
export function freeSlug(wanted: string, taken: ReadonlySet<string>): string {
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; n < 100; n += 1) {
    const slug = `${wanted.slice(0, 36)}-${n}`;
    if (!taken.has(slug)) return slug;
  }
  return `${wanted.slice(0, 30)}-${Date.now().toString(36).slice(-6)}`;
}
