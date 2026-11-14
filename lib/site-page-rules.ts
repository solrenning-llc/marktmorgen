/**
 * A store's own pages (added 11 October 2026): an About page, a page for
 * coaching, a "Start here", a page of questions — beside the store page and
 * the products' pages, at the store's address and on its own domain
 * (/@chef/about, chef.com/about), and linked from the top of the store.
 *
 * A store was one page and its products. Kajabi, Podia and Teachable build a
 * whole site; a creator coming from one of them had nowhere to put the pages
 * they had there. Each page here is built from the same blocks as a
 * product's page (lib/sales-page.ts), drawn by the same components, with the
 * same three rules: nothing typed is read as markup, a video is one of three
 * players rebuilt from its id, and no block can state a price.
 *
 * Only the blocks that mean something without a product of its own are
 * offered (SITE_KINDS). A button leads to the store, or to one product the
 * creator picks for the page; a product card shows a product as it is sold.
 *
 * Kept as a short list on the store's record (id, address, title, whether it
 * is in the menu), and each page's blocks in the record a product's page
 * uses, under `site-<id>` (lib/sales-page-store.ts). Browser-safe.
 */
import type { BlockKind } from "@/lib/sales-page";

export type SitePage = {
  id: string;
  /** Its address under the store: /@handle/<slug>. */
  slug: string;
  title: string;
  /** Linked from the top of the store and of every page. */
  nav: boolean;
  /** Where its buttons lead: one of the store's products, or "" for the store itself. */
  target: string;
  /**
   * When visitors may see it, written when its blocks are saved, so the menu
   * on every store page needs no read of each page: -1 not at all (no blocks
   * yet, or kept back with no date), 0 now, or the second it comes out.
   */
  from: number;
};

/** Whether a page is out for visitors at this moment. */
export function pageOut(page: Pick<SitePage, "from">, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return page.from === 0 || (page.from > 0 && nowSeconds >= page.from);
}

/** When a page with these blocks and this setting is out, as `from` keeps it. */
export function outFrom(page: { blocks: unknown[]; hidden: boolean; showFrom: number }): number {
  if (!page.blocks.length) return -1;
  if (!page.hidden) return 0;
  return page.showFrom > 0 ? page.showFrom : -1;
}

export const MAX_SITE_PAGES = 10;
export const MAX_SITE_TITLE = 60;
export const MAX_SLUG = 40;
export const SITE_PAGE_ID = /^[a-z0-9]{10}$/;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Addresses a page cannot take: every page the store already has under its
 * address (app/[handle]), and a few kept so that one can be added later
 * without taking a creator's page away. tests/site-pages.test.ts checks this
 * against the folders that exist.
 */
export const RESERVED_SLUGS = new Set([
  // A store's map and its crawler rules (lib/store-sitemap.ts), served as sitemap.xml and robots.txt.
  "store-sitemap",
  "store-robots",
  // What a person sees after sending a form (lib/forms.ts).
  "form",
  "affiliates",
  "app-icon",
  "blog",
  "book",
  "certificate",
  "community",
  "contact",
  "discord",
  "course",
  "free",
  "go",
  "group",
  "join",
  "left",
  "manage",
  "manifest.webmanifest",
  "media-kit",
  // Emails a store published (app/[handle]/letters).
  "letters",
  "move",
  "orders",
  "p",
  // A payment request's page (app/[handle]/pay/[request]).
  "pay",
  // The store's policies, built from its settings (app/[handle]/policies, 617 [SZ1]).
  "policies",
  "podcast",
  "renew",
  // A proposal or agreement's page to sign (app/[handle]/sign/[agreement]).
  "sign",
  "resting",
  "review",
  "thanks",
  "tip",
  "waitlist",
  // Kept for later, and for what a visitor would not expect to be a creator's page.
  "api",
  "app",
  "cart",
  "checkout",
  "login",
  "page",
  "pages",
  "search",
  "shop",
  "signin",
  "studio",
  "unsubscribe",
]);

/**
 * The site's own top-level pages, which a store's domain still sends to the
 * site rather than reading as one of the store's pages (proxy.ts).
 */
const SITE_TOP = new Set([
  "affiliate-programs",
  "copyright",
  "creators",
  "demo",
  "developers",
  "embed",
  "for",
  "help",
  "invite",
  "mission",
  "outreach",
  "platform",
  "pricing",
  "privacy",
  "products",
  "proof",
  "refunds",
  "report",
  "takedown",
  "terms",
]);

/** Whether a path on a store's own domain names one of its pages: one word or words joined by dashes, nothing the site keeps. */
export function isOwnPagePath(pathname: string): boolean {
  const slug = pathname.replace(/^\/|\/$/g, "");
  return slug.length > 0 && slug.length <= MAX_SLUG && SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.has(slug) && !SITE_TOP.has(slug);
}

/** The blocks a store's own page offers: those that mean something without a product of the page's own. */
export const SITE_KINDS: readonly BlockKind[] = [
  "hero",
  "text",
  "feature",
  "pictures",
  "video",
  "benefits",
  "steps",
  "fit",
  "faq",
  "bio",
  "quotes",
  "product",
  "countdown",
  "cta",
  // A form, survey or quiz (lib/forms.ts): asked on the store's own pages only, where it can lead a funnel on.
  "form",
  // Arrangement only (375 [TB1]): a line and empty room, nothing of the creator's to write, check or pay for.
  "divider",
  "space",
];

/** The key a page's blocks are kept under, beside the products' (lib/sales-page-store.ts). */
export const siteKey = (id: string) => `site-${id}`;
export const isSiteKey = (key: string) => /^site-[a-z0-9]{10}$/.test(key);

const oneLine = (value: unknown, max: number) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

/** An address made from a title: "About me!" becomes "about-me". */
export function slugFrom(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, "");
}

/** Why an address cannot be a page's, or null when it can. */
export function slugProblem(slug: string, others: readonly SitePage[], self = ""): "slug" | "reserved" | "taken" | null {
  if (!slug || slug.length > MAX_SLUG || !SLUG_PATTERN.test(slug)) return "slug";
  if (RESERVED_SLUGS.has(slug)) return "reserved";
  if (others.some((page) => page.slug === slug && page.id !== self)) return "taken";
  return null;
}

/** Pages as stored or sent, made safe to use: each id and address once, ten at most. */
export function parseSitePages(raw: unknown): SitePage[] {
  if (!Array.isArray(raw)) return [];
  const out: SitePage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const id = typeof value.id === "string" && SITE_PAGE_ID.test(value.id) ? value.id : "";
    const slug = typeof value.slug === "string" ? value.slug : "";
    const title = oneLine(value.title, MAX_SITE_TITLE);
    // An address reserved after a page already had it stays the page's: the
    // list only refuses a new page there (slugProblem, in the studio).
    const issue = slugProblem(slug, out);
    if (!id || !title || (issue !== null && issue !== "reserved") || out.some((page) => page.id === id)) continue;
    const target = typeof value.target === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value.target) ? value.target : "";
    const from = typeof value.from === "number" && Number.isInteger(value.from) && value.from >= -1 ? value.from : -1;
    out.push({ id, slug, title, nav: value.nav !== false, target, from });
    if (out.length >= MAX_SITE_PAGES) break;
  }
  return out;
}

/** A page's title, cleaned as it is kept. */
export const siteTitle = (raw: unknown) => oneLine(raw, MAX_SITE_TITLE);

/** A few first pages, with their blocks, for a store that has none (the studio offers them). */
export const SITE_STARTERS: { title: string; slug: string; hint: string; kinds: BlockKind[] }[] = [
  { title: "About", slug: "about", hint: "Who you are, why you make what you make, and where to start.", kinds: ["hero", "bio", "feature", "quotes", "cta"] },
  { title: "Start here", slug: "start-here", hint: "For someone new: the steps to take, and the first product to try.", kinds: ["hero", "steps", "product", "cta"] },
  { title: "Work with me", slug: "work-with-me", hint: "Coaching, a service or a call: who it is for, how it goes, questions.", kinds: ["hero", "fit", "steps", "faq", "cta"] },
  { title: "Questions", slug: "questions", hint: "Everything people ask before they buy, in one place.", kinds: ["hero", "faq", "cta"] },
];
