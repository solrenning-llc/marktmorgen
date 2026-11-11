/**
 * The studio's modules, for the gallery "Add to your store" (653 [WG13],
 * app/studio/add): what each one is called, one plain sentence of what it
 * does, which studio screen opens it, and what has to be true for it to be
 * shown. Pure data and pure helpers: the page reads the store, the role and
 * the deployment, and hands the answers in.
 *
 * Titles, sentences, permissions and conditions follow the studio home's own
 * grid (app/studio/page.tsx, StudioTools): a card is shown here exactly when
 * the home would show its tile. Each permission is also the one the module's
 * own screen asks studioView for, so a card never opens a screen that would
 * send the person away (tests/wg13-add-gallery.test.ts reads both).
 *
 * Every folder of app/studio with a page is either a card below or in
 * NOT_MODULES with the reason it is not one.
 */
import type { IconName } from "@/components/icons";
import { MAX_FUNNEL_STEPS } from "@/lib/funnel";
import { PLAN_TITLES } from "@/lib/plan";
import type { Permission } from "@/lib/team-roles";

export type Category = "sell" | "teach" | "community" | "grow" | "connect";

/** The five groups, in the order the page shows them. */
export const CATEGORIES: readonly { id: Category; title: string }[] = [
  { id: "sell", title: "Sell" },
  { id: "teach", title: "Teach" },
  { id: "community", title: "Community" },
  { id: "grow", title: "Grow" },
  { id: "connect", title: "Connect" },
];

/**
 * What else must be true for a card to be shown, besides the role, read by
 * the page the way the studio home reads it:
 * - discord: the deployment has Discord's keys (lib/discord.ts, isDiscordConfigured);
 * - meet: the deployment has Google's or Zoom's keys and offers one to this store (lib/meet-providers.ts);
 * - memberships: the store sells something recurring (lib/membership-manage.ts, sellsMemberships);
 * - calls: the store sells calls, so its team hosts them (lib/host-calendar.ts);
 * - proOnSale: the Studio plan can be bought (lib/plan.ts, PRO_ON_SALE).
 */
export type Condition = "discord" | "meet" | "memberships" | "calls" | "proOnSale";

export type StudioModule = {
  id: string;
  category: Category;
  title: string;
  /** One plain sentence, US English. */
  text: string;
  /** The studio route segment: app/studio/<segment>/page.tsx. */
  segment: string;
  /** What the role needs, as the studio home's may(...) and the screen's studioView(...): "member" is anyone on the store. */
  permission: Permission | "member";
  /** A condition of the deployment or the store, when there is one. */
  when?: Condition;
  /** The plan that includes it, when not every plan does: "pro" is the plan titled Studio (lib/plan.ts, PLAN_TITLES). */
  plan?: "pro";
  icon: IconName;
};

export const STUDIO_MODULES: readonly StudioModule[] = [
  // Sell
  { id: "pages", category: "sell", title: "Sales pages", text: "Build each product's page from blocks, or a landing page for something free.", segment: "pages", permission: "products", icon: "layout" },
  { id: "site", category: "sell", title: "Your pages", text: "Add pages like About, Start here and Work with me, linked from the top of your store.", segment: "site", permission: "page", icon: "layout" },
  { id: "funnels", category: "sell", title: "Funnels", text: `Offer up to ${MAX_FUNNEL_STEPS} more things with one click right after someone pays.`, segment: "funnels", permission: "products", icon: "ladder" },
  { id: "bundles", category: "sell", title: "Bundles", text: "Sell several of your products together for one price.", segment: "bundles", permission: "products", icon: "gift" },
  { id: "requests", category: "sell", title: "Payment requests", text: "Ask one person to pay a custom amount by email, with a due date and a receipt.", segment: "requests", permission: "orders", icon: "receipt" },
  { id: "agreements", category: "sell", title: "Agreements", text: "Send one person a proposal or agreement to read and sign, with each version kept.", segment: "agreements", permission: "orders", icon: "receipt" },
  { id: "deals", category: "sell", title: "Deals and fields", text: "Follow the sales you are talking through in stages, and keep your own fields about each person.", segment: "deals", permission: "orders", icon: "chart" },
  // Teach
  { id: "blog", category: "teach", title: "Blog", text: "Write posts on your store's address that search engines can find, each able to end on a product.", segment: "blog", permission: "page", icon: "notebook" },
  { id: "forms", category: "teach", title: "Forms", text: "Make applications, surveys and quizzes on your own pages, and keep every answer.", segment: "forms", permission: "page", icon: "list" },
  { id: "meetings", category: "teach", title: "Video calls", text: "Get a video call link made for each booking and live event.", segment: "meetings", permission: "settings", when: "meet", icon: "video" },
  // Community
  { id: "community", category: "community", title: "Community", text: "Give your buyers a members-only space of their own.", segment: "community", permission: "community", icon: "users" },
  { id: "discord", category: "community", title: "Discord", text: "Let buyers into your own Discord server, and take their roles back when access ends.", segment: "discord", permission: "settings", when: "discord", icon: "chat" },
  { id: "reviews", category: "community", title: "Reviews", text: "Collect verified reviews from your buyers and answer them.", segment: "reviews", permission: "reviews", icon: "star" },
  { id: "inbox", category: "community", title: "Inbox", text: "Answer the chat on your store and your contact form in one place, with saved replies.", segment: "inbox", permission: "orders", icon: "mail" },
  { id: "people", category: "community", title: "Buyers", text: "See one page per buyer with what they paid, their courses and your team's notes.", segment: "people", permission: "orders", icon: "user" },
  // Grow
  { id: "growth", category: "grow", title: "Growth", text: "Choose a goal and connect the tools for your next action.", segment: "growth", permission: "member", icon: "chart" },
  { id: "email", category: "grow", title: "Email", text: "Send one-off emails and automatic sequences to the people on your list.", segment: "email", permission: "draft", when: "proOnSale", plan: "pro", icon: "mail" },
  { id: "outreach", category: "grow", title: "Outreach", text: "Write a short pitch to a sponsor, a partner or a business, for you to send yourself.", segment: "outreach", permission: "draft", icon: "target" },
  { id: "affiliates", category: "grow", title: "Affiliates", text: "Let people share your store for a share of each sale that you set.", segment: "affiliates", permission: "settings", icon: "handshake" },
  { id: "memberships", category: "grow", title: "Membership numbers", text: "See your monthly membership income, members who left, and trials that turned into paying members.", segment: "memberships", permission: "stats", when: "memberships", icon: "chart" },
  // Connect
  { id: "integrations", category: "connect", title: "Email platforms", text: "Keep Mailchimp, Kit, beehiiv or MailerLite fed with the people who join your list.", segment: "integrations", permission: "settings", icon: "plug" },
  { id: "import", category: "connect", title: "Moving from another platform", text: "Bring over your list, your products and your past buyers.", segment: "import", permission: "import", icon: "door" },
  { id: "phone", category: "connect", title: "Phone notifications", text: "Get a buzz on your own devices for sales, bookings and other news from your store.", segment: "phone", permission: "member", icon: "phone" },
  { id: "calendar", category: "connect", title: "Your calendar", text: "Connect your own calendar so your busy times stay out of the team calls you host.", segment: "calendar", permission: "member", when: "calls", icon: "calendar" },
];

/**
 * Studio screens that are not something to add to a store, each with why.
 * A new screen under app/studio fails the test until it is a card above or
 * a line here.
 */
export const NOT_MODULES: Readonly<Record<string, string>> = {
  new: "Makes another store in the account, so it adds nothing to this one.",
  copy: "Copies this store into another store of the account, an account action rather than a part of the store.",
  checkup: "A health check of payments, the domain, email and checkout, opened from the studio home.",
  totals: "Figures for the stores of the account, a report rather than a part of the store.",
  paused: "Shown only when the studio's requests for the period are used up.",
  "closing-refunds": "The review before members get unused time back when a store closes.",
  refund: "The review before a refund of the store's own Marktmorgen plan.",
  disputes: "The review of one disputed purchase, opened from Payment requests.",
  invite: "Credits on the store's own Marktmorgen plan for inviting other creators, not a part of the store.",
  team: "Who helps run the store and with which role, the store's administration opened from the studio home.",
  path: "Your Path, a guide of next steps for the owner, opened from the reminder on the studio home.",
  labels: "A tool for labels on many contacts at once, opened from Moving from another platform.",
  agent: "The changes an AI assistant prepared through the store's API, waiting for the owner to confirm; not a part of the store.",
  card: "The business card, one address with a Save contact button, opened from Your pages.",
  tax: "The tax registrations active on the store's Stripe account, read from Stripe: a report for the owner, not a part of the store.",
  appeals: "Asking us to look again at a decision that took something down from this store, opened from the notice on the studio home; not a part of the store.",
};

/** What the page knows about the person, the store and the deployment. */
export type GalleryContext = {
  /** The studio home's may(...): can(role, permission). */
  may: (permission: Permission) => boolean;
  has: Record<Condition, boolean>;
  /** Whether the store's plan includes the Studio plan's modules: paid up, on Studio or Scale. */
  pro: boolean;
  /** The plan page (the studio home's #billing), or null where it is not drawn for this person. */
  planHref: string | null;
  /** Whether this person may change the store's plan. */
  billing: boolean;
  /** Whether paid plans are on sale at all (lib/opening.ts, PLANS_ON_SALE). */
  onSale: boolean;
};

type CardBase = { id: string; title: string; text: string; icon: IconName };
export type GalleryCard =
  | (CardBase & { state: "open"; href: string })
  | (CardBase & { state: "plan"; plan: string; href: string | null; note: string | null });
export type GallerySection = { id: Category; title: string; cards: GalleryCard[] };

/** Whether a module is shown at all: the same role and conditions as the studio home. */
export function shows(entry: StudioModule, ctx: GalleryContext): boolean {
  if (entry.permission !== "member" && !ctx.may(entry.permission)) return false;
  return entry.when ? ctx.has[entry.when] : true;
}

/** One card: its editor, or, when the store's plan does not include it, the way to the plan. */
export function cardFor(entry: StudioModule, ctx: GalleryContext, href: (segment: string) => string): GalleryCard {
  const base = { id: entry.id, title: entry.title, text: entry.text, icon: entry.icon };
  if (entry.plan === "pro" && !ctx.pro) {
    // Why there is no link, said truly: who chooses the plan, plans not on sale yet, or billing not set up here.
    const note = ctx.planHref
      ? null
      : !ctx.billing
        ? "The store's owner chooses its plan."
        : !ctx.onSale
          ? "Paid plans are not on sale yet."
          : "The plan can't be changed from here right now.";
    return { ...base, state: "plan", plan: PLAN_TITLES.pro, href: ctx.planHref, note };
  }
  return { ...base, state: "open", href: href(entry.segment) };
}

/** The gallery for one person and store: the five groups, each with its cards, a group with none left out. */
export function galleryFor(ctx: GalleryContext, href: (segment: string) => string): GallerySection[] {
  return CATEGORIES.map((category) => ({
    id: category.id,
    title: category.title,
    cards: STUDIO_MODULES.filter((entry) => entry.category === category.id && shows(entry, ctx)).map((entry) => cardFor(entry, ctx, href)),
  })).filter((section) => section.cards.length > 0);
}
