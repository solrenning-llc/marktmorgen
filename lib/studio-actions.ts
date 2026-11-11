/**
 * The studio's search of actions, "What do you want to do?" (486 [IT3]): the
 * creator types what they want to do ("refund", "send email", "change price",
 * "discount") and is taken to the screen that does it. Pure data and pure
 * helpers, with no model, no network and no cost per search: the list of
 * actions and the words people use for each are kept here, in the code.
 *
 * What a search reads:
 *   - the words typed, at most MAX_QUERY_CHARS, never kept anywhere;
 *   - the person's role and the store's conditions, the same GalleryContext
 *     the gallery "Add to your store" reads (lib/studio-modules.ts), so a
 *     result never opens a screen the person's role would be sent away from;
 *   - the ids of the actions this person opened last, on their own device
 *     (rememberAction, readRecent), only to order the results.
 *
 * How the words match, so a typo, a plural or another word for the same
 * thing still finds it: every word typed must match a word of the action's
 * title or of its other words, exactly, as the start of one ("refu"), or
 * within one or two letters of one ("refnd", "afiliate"), after plurals are
 * folded ("emails" is "email", "categories" is "category"). Small words
 * ("how", "do", "i", "the") are left out of the search.
 *
 * Every folder of app/studio with a page is an action below or a line in
 * NOT_ACTIONS with the reason it is not one, and each action asks for the
 * permission its own screen asks studioView for
 * (tests/it3-studio-actions.test.ts reads both). An action on the studio
 * home names the section it scrolls to, and that section is drawn for every
 * role with the action's permission, under that permission alone.
 */
import { STUDIO_MODULES, cardFor, shows, type GalleryContext } from "@/lib/studio-modules";
import type { Permission } from "@/lib/team-roles";

/** The most a search reads of what was typed; the rest is ignored. */
export const MAX_QUERY_CHARS = 80;
/** The most results shown for one search. */
export const MAX_RESULTS = 8;
/** How many recently opened actions a device remembers, to order the results. */
export const MAX_RECENT = 5;
/** The key a device keeps its recent actions under (localStorage), a preference only. */
export const RECENT_KEY = "mm:studio-actions";

export type StudioAction = {
  id: string;
  /** What the person wants to do, as the result says it: plain US English, a verb first. */
  title: string;
  /** The studio route segment, app/studio/<segment>/page.tsx, or "" for the studio home. */
  segment: string;
  /** On the studio home: the id of the section it scrolls to. */
  anchor?: string;
  /** What the role needs: the screen's own studioView(...) permission; "member" is anyone on the store. */
  permission: Permission | "member";
  /** Other words people type for it. */
  words: readonly string[];
};

export const STUDIO_ACTIONS: readonly StudioAction[] = [
  // On the studio home.
  { id: "products", title: "Change a product's price, files or details", segment: "", anchor: "products", permission: "products", words: ["price", "pricing", "change price", "product", "edit product", "add product", "new product", "files", "download", "sell"] },
  { id: "look", title: "Change how your store looks", segment: "", anchor: "look", permission: "page", words: ["look", "theme", "colors", "colours", "font", "design", "logo", "photo", "picture", "name", "handle", "style"] },
  { id: "links", title: "Edit the links on your store page", segment: "", anchor: "links", permission: "page", words: ["link", "link in bio", "social", "instagram", "youtube", "tiktok"] },
  { id: "stripe", title: "Connect or check your Stripe account", segment: "", anchor: "stripe", permission: "payments", words: ["stripe", "payout", "bank", "get paid", "money", "balance", "connect payments"] },
  { id: "ways-to-pay", title: "Choose the ways buyers can pay", segment: "", anchor: "ways-to-pay", permission: "settings", words: ["payment methods", "apple pay", "google pay", "card", "wallet", "ways to pay", "checkout"] },
  { id: "sale", title: "Put the whole store on sale", segment: "", anchor: "sale-title", permission: "settings", words: ["sale", "discount", "promotion", "promo", "percent off", "markdown", "black friday"] },
  { id: "account", title: "Change how you sign in", segment: "", anchor: "account", permission: "member", words: ["sign in", "login", "log in", "passkey", "two step", "security", "password", "email address", "account"] },
  // Screens of their own.
  { id: "add", title: "Add a tool to your store", segment: "add", permission: "member", words: ["add", "modules", "features", "apps", "tools", "gallery"] },
  { id: "pages", title: "Build a sales page", segment: "pages", permission: "products", words: ["sales page", "landing page", "page builder", "blocks", "template", "layout"] },
  { id: "site", title: "Add pages like About or Work with me", segment: "site", permission: "page", words: ["about", "about page", "start here", "work with me", "website", "menu", "navigation"] },
  { id: "funnels", title: "Offer more right after someone pays", segment: "funnels", permission: "products", words: ["funnel", "upsell", "one click", "offer", "after purchase", "thank you page"] },
  { id: "bundles", title: "Sell products together as a bundle", segment: "bundles", permission: "products", words: ["bundle", "package", "pack", "combo", "together"] },
  { id: "requests", title: "Ask someone to pay a custom amount", segment: "requests", permission: "orders", words: ["invoice", "payment request", "bill", "charge", "custom amount", "payment link", "request money"] },
  { id: "agreements", title: "Send an agreement to sign", segment: "agreements", permission: "orders", words: ["contract", "proposal", "sign", "signature", "agreement", "terms"] },
  { id: "deals", title: "Follow the sales you are talking through", segment: "deals", permission: "orders", words: ["deal", "pipeline", "crm", "lead", "stage", "custom field", "prospect"] },
  { id: "blog", title: "Write a blog post", segment: "blog", permission: "page", words: ["blog", "post", "article", "seo", "write", "search engine"] },
  { id: "forms", title: "Make a form, a survey or a quiz", segment: "forms", permission: "page", words: ["form", "survey", "quiz", "application", "questionnaire", "questions"] },
  { id: "meetings", title: "Get a video call link for each booking", segment: "meetings", permission: "settings", words: ["zoom", "google meet", "video call", "meeting", "call link", "webinar"] },
  { id: "community", title: "Run your members' community", segment: "community", permission: "community", words: ["community", "members", "forum", "group", "space", "posts"] },
  { id: "discord", title: "Let buyers into your Discord server", segment: "discord", permission: "settings", words: ["discord", "server", "roles"] },
  { id: "reviews", title: "Collect and answer reviews", segment: "reviews", permission: "reviews", words: ["review", "rating", "testimonial", "stars", "feedback"] },
  { id: "inbox", title: "Answer messages from buyers", segment: "inbox", permission: "orders", words: ["inbox", "message", "chat", "contact form", "support", "reply", "question", "saved replies"] },
  { id: "people", title: "Look up a buyer and what they paid", segment: "people", permission: "orders", words: ["buyer", "customer", "people", "contact", "order", "purchase", "refund", "refunded", "notes"] },
  { id: "growth", title: "Choose a goal to grow your store", segment: "growth", permission: "member", words: ["grow", "growth", "goal", "more sales", "marketing", "traffic"] },
  { id: "email", title: "Send an email to your list", segment: "email", permission: "draft", words: ["email", "send email", "newsletter", "broadcast", "sequence", "mail", "campaign", "automation", "list"] },
  { id: "outreach", title: "Write a pitch to a sponsor or a partner", segment: "outreach", permission: "draft", words: ["sponsor", "pitch", "partnership", "brand deal", "outreach", "collaboration"] },
  { id: "affiliates", title: "Let affiliates share your store", segment: "affiliates", permission: "settings", words: ["affiliate", "referral", "partner program", "share of sale", "ambassador"] },
  { id: "memberships", title: "See your membership numbers", segment: "memberships", permission: "stats", words: ["mrr", "churn", "subscription", "recurring", "trial", "members who left", "monthly income"] },
  { id: "integrations", title: "Connect Mailchimp, Kit, beehiiv or MailerLite", segment: "integrations", permission: "settings", words: ["mailchimp", "kit", "convertkit", "beehiiv", "mailerlite", "integration", "connect", "sync list"] },
  { id: "import", title: "Move from another platform", segment: "import", permission: "import", words: ["import", "migrate", "move", "transfer", "gumroad", "kajabi", "teachable", "thinkific", "csv", "upload list"] },
  { id: "phone", title: "Get notifications on your phone", segment: "phone", permission: "member", words: ["notification", "push", "phone", "alert", "buzz", "mobile app"] },
  { id: "calendar", title: "Connect your calendar", segment: "calendar", permission: "member", words: ["calendar", "busy times", "google calendar", "outlook", "availability", "schedule"] },
  { id: "labels", title: "Label many contacts at once", segment: "labels", permission: "send", words: ["label", "tag", "tag contacts", "segment", "bulk"] },
  { id: "card", title: "Edit your business card", segment: "card", permission: "page", words: ["business card", "vcard", "contact card", "save contact"] },
  { id: "checkup", title: "Find out why something is not working", segment: "checkup", permission: "settings", words: ["broken", "not working", "problem", "health check", "fix", "error", "issue", "trouble", "help"] },
  { id: "path", title: "See your next steps", segment: "path", permission: "settings", words: ["path", "next step", "guide", "checklist", "getting started", "setup", "onboarding"] },
  { id: "tax", title: "See where you collect tax", segment: "tax", permission: "payments", words: ["tax", "vat", "sales tax", "gst", "registration"] },
  { id: "team", title: "Invite someone to help run your store", segment: "team", permission: "team", words: ["team", "staff", "helper", "role", "permission", "admin", "assistant", "activity log"] },
  { id: "invite", title: "Invite other creators for plan credit", segment: "invite", permission: "billing", words: ["invite", "refer", "referral", "credit", "invite creator"] },
  { id: "refund", title: "Ask for a refund of your Marktmorgen plan", segment: "refund", permission: "billing", words: ["refund", "money back", "plan refund", "refund plan"] },
  { id: "copy", title: "Copy this store into another of your stores", segment: "copy", permission: "page", words: ["copy", "duplicate", "clone"] },
  { id: "agent", title: "Review what the AI proposes", segment: "agent", permission: "settings", words: ["ai", "agent", "proposed changes", "api", "confirm changes"] },
];

/**
 * Studio screens that are not an action of their own, each with why. A new
 * screen under app/studio fails the test until it is an action above or a
 * line here.
 */
export const NOT_ACTIONS: Readonly<Record<string, string>> = {
  new: "Makes another store in the account, opened from the store switcher rather than from inside a store.",
  totals: "Figures for all the stores of the account, opened from the store switcher rather than from inside a store.",
  paused: "Shown only when the studio's requests for the period are used up, never something to open.",
  disputes: "The review of one disputed purchase, which opens only from that purchase in Payment requests.",
  "closing-refunds": "The review before members get unused time back, which opens only while the store is closing.",
  invoices: "The invoices of the store's own plan, which open from the plan card (What you pay us), shown only for a store with a plan subscription.",
};

/** A result: what it does, where it goes, and the plan it needs when the store's plan does not include it. */
export type ActionResult = { id: string; title: string; href: string; plan: string | null };

/** Words that say nothing about what to do, left out of a search. */
const SMALL_WORDS = new Set(["a", "an", "the", "to", "i", "my", "me", "want", "how", "do", "can", "of", "for", "on", "in", "and", "or", "is", "it", "your", "you", "with", "please", "where", "what"]);

/** Lower case, no accents, letters and digits only, one space between words. */
export function normalized(text: string): string {
  return text
    .slice(0, MAX_QUERY_CHARS)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A plural folded to its singular: "emails" → "email", "categories" → "category", "boxes" → "box"; "class" stays. */
export function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** The words of a text that a search compares, plurals folded. */
export function termsOf(text: string): string[] {
  return normalized(text)
    .split(" ")
    .filter((word) => word.length > 0 && !SMALL_WORDS.has(word))
    .map(singular);
}

/** Letters changed, added, dropped or swapped next to each other between two words (optimal string alignment). */
export function editDistance(a: string, b: string): number {
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[a.length][b.length];
}

/** How many letters a typed word may be off by: none below four letters, one up to seven, two from eight. */
export function typosAllowed(word: string): number {
  return word.length < 4 ? 0 : word.length < 8 ? 1 : 2;
}

/** How well one typed word fits one word of an action: 3 the same, 2 its start, 1 a near miss, 0 not at all. */
export function fit(typed: string, term: string): number {
  if (typed === term) return 3;
  if (typed.length >= 2 && term.startsWith(typed)) return 2;
  const allowed = typosAllowed(typed);
  if (allowed > 0 && Math.abs(typed.length - term.length) <= allowed && editDistance(typed, term) <= allowed) return 1;
  return 0;
}

type Terms = { title: readonly string[]; words: readonly string[] };
const termsFor = (action: StudioAction): Terms => ({ title: [...new Set(termsOf(action.title))], words: [...new Set(action.words.flatMap(termsOf))] });
const TERMS = new Map<string, Terms>(STUDIO_ACTIONS.map((action) => [action.id, termsFor(action)]));

/**
 * How well a search fits an action: every typed word must fit one of its
 * words, or the search does not fit at all (0). A word of the title counts a
 * little more than one of the other words, so "emails" is Email before the
 * sign-in that also lists "email address".
 */
export function score(typed: readonly string[], action: StudioAction): number {
  const terms = TERMS.get(action.id) ?? termsFor(action);
  let total = 0;
  for (const word of typed) {
    let best = 0;
    for (const term of terms.title) best = Math.max(best, fit(word, term) * 2 + (fit(word, term) > 0 ? 1 : 0));
    for (const term of terms.words) best = Math.max(best, fit(word, term) * 2);
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

/** Whether an action is shown to this person on this store: its card's role and conditions in the gallery, or the action's permission. */
export function available(action: StudioAction, ctx: GalleryContext): boolean {
  const screen = action.segment ? STUDIO_MODULES.find((entry) => entry.segment === action.segment) : undefined;
  if (screen) return shows(screen, ctx);
  return action.permission === "member" || ctx.may(action.permission);
}

/**
 * Where an action goes: its screen, or its section of the studio home; for a
 * module the store's plan does not include, the way to the plan, as the
 * gallery says it (cardFor); null when there is no way from here.
 */
export function resultFor(action: StudioAction, ctx: GalleryContext, href: (segment: string) => string): ActionResult | null {
  const screen = action.segment ? STUDIO_MODULES.find((entry) => entry.segment === action.segment) : undefined;
  if (screen) {
    const card = cardFor(screen, ctx, href);
    if (card.state === "plan") return card.href ? { id: action.id, title: action.title, href: card.href, plan: card.plan } : null;
    return { id: action.id, title: action.title, href: card.href, plan: null };
  }
  const base = href(action.segment);
  return { id: action.id, title: action.title, href: action.anchor ? `${base}#${action.anchor}` : base, plan: null };
}

/** The ids of recently opened actions, as a device kept them: known ids only, at most MAX_RECENT; anything else reads as none. */
export function readRecent(raw: unknown): string[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const known = new Set(STUDIO_ACTIONS.map((action) => action.id));
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id === "string" && known.has(id) && !ids.includes(id)) ids.push(id);
    if (ids.length === MAX_RECENT) break;
  }
  return ids;
}

/** The recent list after an action is opened: that one first, no repeats, at most MAX_RECENT. */
export function rememberAction(recent: readonly string[], id: string): string[] {
  if (!STUDIO_ACTIONS.some((action) => action.id === id)) return readRecent(recent);
  return [id, ...readRecent(recent).filter((other) => other !== id)].slice(0, MAX_RECENT);
}

/**
 * The results of one search, best first: how well the words fit, then the
 * actions this person opened most recently, then the order above. With no
 * words to search, the recently opened actions, most recent first.
 */
export function searchActions(query: string, ctx: GalleryContext, href: (segment: string) => string, recent: readonly string[] = []): ActionResult[] {
  const typed = termsOf(query);
  const order = readRecent(recent);
  const rank = (id: string) => {
    const at = order.indexOf(id);
    return at === -1 ? MAX_RECENT : at;
  };
  const candidates = typed.length === 0
    ? STUDIO_ACTIONS.filter((action) => order.includes(action.id)).map((action) => ({ action, fits: 0 }))
    : STUDIO_ACTIONS.map((action) => ({ action, fits: score(typed, action) })).filter((entry) => entry.fits > 0);
  const results: ActionResult[] = [];
  for (const { action } of candidates
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => b.fits - a.fits || rank(a.action.id) - rank(b.action.id) || a.index - b.index)) {
    if (!available(action, ctx)) continue;
    const result = resultFor(action, ctx, href);
    if (result) results.push(result);
    if (results.length === MAX_RESULTS) break;
  }
  return results;
}
