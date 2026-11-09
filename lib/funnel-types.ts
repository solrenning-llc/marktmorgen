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
  /**
   * What it has to be: free (it asks for an email), paid, either, or a
   * bundle (lib/bundle-rules.ts: one product that hands over two or more of
   * the store's others).
   */
  wants: "free" | "paid" | "any" | "bundle";
};

/** One of the store's own pages, made for the funnel, empty and kept back until the creator lets it out. */
export type PageSlot = {
  kind: "page";
  key: string;
  title: string;
  slug: string;
  blocks: BlockKind[];
  /** Where its buttons lead, when that is a product chosen for the funnel rather than its next step. */
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
  {
    // 576 [FT8]. The bundle's own page already lists what is inside, says what
    // those products cost on their own only when that is more than the bundle
    // (worthWords), takes the payment and hands over what it holds, each product
    // as if it was bought alone: all of them, or only the ones the buyer chose
    // when the bundle lets them choose (lib/bundle-rules.ts picks, chosenItems).
    // So the hint promises what the bundle hands over, never "each product in it".
    // The type adds no sales page of its own.
    id: "bundle",
    label: "Product bundle",
    hint: "Your bundle's page, which shows what is in it and its price, then a page that says what happens next. Buyers get what the bundle hands over, each product as if they bought it on its own.",
    slots: [{ kind: "product", key: "bundle", label: "Your bundle: one product that holds two or more of your products", wants: "bundle" }, thanks],
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

/**
 * What a product has to be for a slot, as the catalog knows it. A caller that
 * does not say whether it is a bundle never has it taken for one.
 */
export type ProductFacts = { free: boolean; call: boolean; bundle?: boolean };

/** Why a product cannot fill a slot, or null when it can. */
export function slotProblem(slot: ProductSlot | TargetSlot, product: ProductFacts | null): "missing" | "free" | "paid" | "call" | "bundle" | null {
  if (!product) return "missing";
  if (slot.wants === "call") return product.call ? null : "call";
  if (slot.wants === "bundle") return product.bundle === true ? null : "bundle";
  // A call is booked on a page of its own, so it is never a step (lib/page-funnel.ts).
  if (product.call) return "call";
  if (slot.wants === "free" && !product.free) return "free";
  if (slot.wants === "paid" && product.free) return "paid";
  return null;
}

/**
 * What the studio says when no product of the store fits a slot, and where
 * the creator makes one: a bundle on the Bundles page, anything else under
 * Products.
 */
export function noneYet(slot: ProductSlot | TargetSlot): { text: string; where: "products" | "bundles" } {
  if (slot.wants === "bundle") return { text: "You have no bundle yet. A bundle is one product that holds two or more of your products. Make one under Bundles, then come back.", where: "bundles" };
  if (slot.wants === "free") return { text: "You have no free product yet. Add one under Products, then come back.", where: "products" };
  if (slot.wants === "call") return { text: "You have no call yet. Add one under Products, then come back.", where: "products" };
  return { text: "You have no paid product yet. Add one under Products, then come back.", where: "products" };
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
