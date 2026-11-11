/**
 * Help for the studio screen a creator is on (766 [STN13], unit 3): a few
 * answers of the help center (lib/help-content.ts) chosen for each screen,
 * read in a new tab so nothing typed on the screen is lost. Drawn by
 * components/screen-help.tsx under the studio's top bar, in the same place
 * on every studio screen (WCAG 3.2.6).
 *
 * Pure and browser-safe: the questions are written here, word for word, and
 * tests/stn13-screen-help.test.ts holds each one to a question the help
 * center has today, and each screen to a folder of app/studio, so a renamed
 * question or a new screen fails the test before a link can lead nowhere.
 * Nothing is read, sent or kept: no video, no model, no database.
 */

/** One answer of the help center, by its question and its anchor on /help. */
export type ScreenAnswer = { q: string; id: string };

/** The most answers one screen lists; the rest of the help center is a search away. */
export const MOST_SCREEN_ANSWERS = 3;

/** The help center's own search field (components/help-search.tsx). */
export const HELP_CENTER_SEARCH = "/help#help-search";

/**
 * The answers for each studio screen, by its folder under app/studio
 * ("" is the studio home). An empty list says the help center has no answer
 * just for that screen yet; the panel then offers the search and a person.
 * The two screens that do not draw the studio's top bar (new, paused) have
 * no entry, since the panel is never shown there.
 */
export const SCREEN_HELP: Readonly<Record<string, readonly string[]>> = {
  "": ["What is Marktmorgen today?", "Can I see how my store is doing?", "When am I paid?"],
  add: ["What can I sell?", "Can I put my own products on my store?"],
  affiliates: ["Can I run an affiliate program?"],
  agent: ["Can I connect Zapier, Make or my own server?"],
  agreements: ["How do I send a proposal or an agreement to sign?"],
  blog: ["Can my store have a blog?", "Will search engines find my store?"],
  bundles: ["Can I sell a bundle of products?"],
  calendar: ["Can I sell paid calls?", "Can I sell a package of sessions, like 5 calls booked one at a time?"],
  card: ["Can my store have pages besides its products, like an About page?"],
  checkup: ["Whose account is the buyer charged on?", "Can I use my own domain?", "Does a buyer who leaves the checkout get a reminder?"],
  "closing-refunds": ["What happens when my plan ends?"],
  community: ["Can I run a community or a webinar?", "How do live events in the community work?"],
  copy: ["Can I copy a whole store into another of my stores?"],
  course: ["Can I sell a course?"],
  deals: ["Can I keep my own details about people, and track deals?"],
  discord: [],
  disputes: ["Who handles refunds and disputes?"],
  email: ["Can I email the people on my list?", "Can I bring my email sequences from another service?", "Can I publish an email I sent on my store?"],
  forms: ["Can I add a form, a survey or a quiz?"],
  funnels: [
    "Can I offer something extra, before or after they pay, or sell a limited number?",
    "Can I copy a funnel, or share one with another creator?",
    "Can I give a countdown offer to people who download my freebie?",
  ],
  growth: ["How do I know if my numbers are good?", "Can I make a short link for a post?"],
  import: ["Can I move my store from Stan, Gumroad or another platform?", "Can I move from ClickFunnels?"],
  inbox: ["Can visitors chat with me, and where do I answer them?", "Can an AI answer my buyers' questions at any hour?"],
  integrations: ["Can I send my list to Mailchimp, Kit, beehiiv or MailerLite?", "Can I connect Zapier, Make or my own server?"],
  invite: ["Are creator invitations available?"],
  invoices: ["What will it cost?", "Can I switch between monthly and yearly, or between the plans?", "What about refunds on the Marktmorgen subscription itself?"],
  labels: ["Can I keep my own details about people, and track deals?"],
  meetings: ["Can I sell paid calls?", "Can I run a community or a webinar?"],
  memberships: ["Can I sell a membership?"],
  outreach: ["Can my store help me find sponsors and partners?", "Who can I write to, and what are the rules?"],
  pages: ["Can I build a sales page or a landing page?", "Can I reuse a section on several pages?"],
  path: [],
  people: ["Can I see everything one buyer has bought from me?", "Someone asked me to delete their data. What do I do?"],
  phone: ["Does it work on a phone?"],
  podcast: ["Can I sell a private podcast?"],
  refund: ["What about refunds on the Marktmorgen subscription itself?", "What happens when my plan ends?"],
  requests: ["How do I ask one person to pay me a custom amount?"],
  reviews: ["Can buyers leave reviews?"],
  site: ["Can my store have pages besides its products, like an About page?", "Can I use my own domain?"],
  tax: ["Is sales tax or VAT added?"],
  team: ["Can I run more than one store, or have someone help me?"],
  totals: ["Can I run more than one store, or have someone help me?"],
};

/** The anchor the help center gives a question: the same rule as answerId in lib/help-content.ts, which the test compares for every question. */
export function helpAnchor(q: string): string {
  return q.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The studio screen a path is ("" for the studio home), or null outside the studio or for a screen with no entry. */
export function screenOf(pathname: string | null): string | null {
  if (!pathname) return null;
  // The studio and its screens only: "/studiox" is not the studio home.
  const match = pathname.match(/^\/studio(?:\/([^/?#]*))?(?=[/?#]|$)/);
  if (!match) return null;
  const screen = match[1] ?? "";
  return Object.hasOwn(SCREEN_HELP, screen) ? screen : null;
}

/** The answers for the screen a path is, with their anchors; none outside the studio. */
export function screenAnswers(pathname: string | null): ScreenAnswer[] {
  const screen = screenOf(pathname);
  if (screen === null) return [];
  return SCREEN_HELP[screen].slice(0, MOST_SCREEN_ANSWERS).map((q) => ({ q, id: helpAnchor(q) }));
}

/** Whether a path is in the studio at all, where the panel is drawn. */
export function inStudio(pathname: string | null): boolean {
  return typeof pathname === "string" && /^\/studio(?:\/|$)/.test(pathname);
}
