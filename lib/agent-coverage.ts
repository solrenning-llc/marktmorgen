/**
 * Every action of the studio, and how an AI agent reaches it: 631 [AA1],
 * step (a), unit 1 (owner, 2 November 2026, 02h15 Fortaleza: "a loja inteira
 * controlada por um agente de IA").
 *
 * The goal of the item is that anything a creator does in the studio can be
 * done by an agent: the assistant inside the studio, the creator's own Claude
 * or ChatGPT through the MCP server (app/api/mcp/route.ts), and a command line,
 * all on the same API, under the same role permissions (lib/team-roles.ts) and
 * the same plan limits. This table is the measure of that goal. Each studio
 * route — a route under app/api that passes one of the studio's own guards
 * (lib/store-request.ts, lib/studio-route.ts) — is listed once per method with
 * one of:
 *
 *   - "tool": an MCP tool already does it today, named here;
 *   - "read", "draft" or "execute": not built yet, and the kind of agent key
 *     it will need (631 (c): keys for reading, for preparing changes and for
 *     carrying them out). "draft" is a change the agent prepares as a preview
 *     the creator confirms; "execute" reaches people outside the studio or
 *     cannot be taken back (an email sent, a buyer answered, an import), so it
 *     is confirmed one at a time;
 *   - "never": the agent will not do it, and why. Money is never moved by the
 *     agent (631 (c)); who is let into the store, secrets and files of buyers'
 *     addresses never pass through an assistant's conversation, which is kept
 *     by whoever runs the assistant (app/api/mcp/route.ts); and a page another
 *     service sends the creator's browser back to has nothing to call.
 *
 * tests/agent-coverage.test.ts reads every route file and fails when a studio
 * route or method is missing here, when a row names a route that is gone,
 * when a tool named here is not served by the MCP server, or when a money
 * route is not "never". So a new studio action cannot be added without saying
 * how the agent reaches it.
 *
 * Nothing here is a tool, a permission or a promise to a customer: it is the
 * inventory the next units build from, and the public page of 631 (e) waits
 * until the rows are tools that work (rule VR).
 */

/** The parts of the studio the owner named in 631 (a), plus the ones the routes add. */
export type AgentArea =
  | "products"
  | "pages"
  | "courses"
  | "calls"
  | "files"
  | "email"
  | "community"
  | "podcast"
  | "affiliates"
  | "offers"
  | "numbers"
  | "buyers"
  | "settings"
  | "connections"
  | "access"
  | "money";

/** The kind of agent key a planned tool will need (631 (c)). */
export type AgentScope = "read" | "draft" | "execute";

export type AgentReach =
  | { kind: "tool"; tools: readonly string[] }
  | { kind: AgentScope }
  | { kind: "never"; why: string };

export type AgentAction = { area: AgentArea; reach: AgentReach; note?: string };

const MONEY = "Money: the agent never moves money, starts or changes a payment, or touches the account money goes into (631 (c)); only the creator, in the studio.";
const ACCESS = "Who is let in: making keys, inviting, removing or changing the role of a person, or deleting or leaving a store stays with the creator in the studio.";
const SECRET = "A secret (a signing secret, a token, a host link or a chat address that lets its holder in) would land in the assistant's conversation; the creator sets it in the studio.";
const PEOPLE_FILE = "A file of buyers', members' or affiliates' addresses: never put into an assistant's conversation (app/api/mcp/route.ts); the creator downloads it in the studio.";
const CONNECT = "Connecting another service's account needs the creator's own sign-in on that service's page.";
const WORDS = "People's own words (a student's hand-in, what customers wrote, a buyer's dispute) never pass through an assistant's conversation (app/api/mcp/route.ts); the creator reads them in the studio.";
const BROWSER = "A page another service sends the creator's browser back to, or a setting about the creator's own browser or phone: there is nothing for an agent to call.";

const tool = (...tools: string[]): AgentReach => ({ kind: "tool", tools });
const read: AgentReach = { kind: "read" };
const draft: AgentReach = { kind: "draft" };
const execute: AgentReach = { kind: "execute" };
const never = (why: string): AgentReach => ({ kind: "never", why });
const row = (area: AgentArea, reach: AgentReach, note?: string): AgentAction => (note ? { area, reach, note } : { area, reach });

/** "METHOD path", the path under app/api without its route.ts. */
export const AGENT_COVERAGE: Readonly<Record<string, AgentAction>> = {
  "POST billing/assistant": row("money", never(MONEY)),
  "GET billing/assistant": row("money", never(MONEY)),
  "POST billing/cancel": row("money", never(MONEY)),
  "POST billing/checkout": row("money", never(MONEY)),
  "POST billing/pause": row("money", never(MONEY)),
  "POST billing/refund": row("money", never(MONEY)),
  "POST billing/withdraw": row("money", never(MONEY)),
  "GET billing/return": row("money", never(BROWSER)),
  "POST billing/switch": row("money", never(MONEY)),
  "GET discord/callback": row("connections", never(BROWSER)),
  "POST integrations/meetings": row("connections", never(CONNECT)),
  "GET integrations/zoom/host": row("calls", never(SECRET)),
  "GET store/ab": row("pages", tool("get_page_test")),
  "POST store/ads-server": row("connections", never(SECRET)),
  "POST store/agent": row("settings", never("Confirming, declining or undoing what an agent proposed is the creator's own decision (631 (c)); an agent never confirms its own work.")),
  "POST store/affiliates": row("affiliates", draft),
  "GET store/affiliates/export": row("affiliates", never(PEOPLE_FILE)),
  "GET store/affiliates/payout-batch": row("money", never(PEOPLE_FILE)),
  "POST store/affiliates/payout-batch": row("money", never(MONEY)),
  "POST store/affiliates/paypal": row("money", never(MONEY)),
  "POST store/agreements": row("buyers", execute),
  "POST store/ai": row("pages", draft, "The writing help: its text comes back to the creator, nothing is saved by it."),
  "POST store/announcement": row("pages", draft),
  "POST store/answers": row("pages", draft),
  "POST store/api-keys": row("access", never(ACCESS)),
  "GET store/assistant-memory": row("settings", read),
  "POST store/assistant-memory": row("settings", draft, "The creator's own notes for their assistant: the agent may propose one, which the creator confirms; it never keeps one by itself."),
  "POST store/assistant-settings": row("settings", draft),
  "POST store/attribution": row("numbers", draft),
  "GET store/audience": row("buyers", never(PEOPLE_FILE)),
  "POST store/blog": row("pages", draft),
  "GET store/bundle": row("products", read),
  "POST store/bundle": row("products", draft),
  "POST store/calendar": row("connections", never(CONNECT)),
  "POST store/call": row("calls", draft),
  "POST store/call-package": row("calls", draft),
  "GET store/call-team": row("calls", read),
  "POST store/call-team": row("calls", draft),
  "POST store/cart-deal": row("offers", draft),
  "POST store/chat-summary": row("connections", never(SECRET)),
  "POST store/closing-refunds": row("money", never(MONEY)),
  "POST store/collections": row("pages", draft),
  "POST store/come-back": row("offers", draft),
  "POST store/community/events": row("community", execute, "Scheduling, moving and canceling a live event tells the people coming."),
  "POST store/community/manage": row("community", execute, "Muting or taking a member out reaches that member."),
  "POST store/contact-box": row("pages", draft),
  "POST store/contact-labels": row("buyers", draft),
  "GET store/course": row("courses", tool("get_course_outline", "get_lesson")),
  "POST store/course": row("courses", draft),
  "GET store/course/task": row("courses", never(WORDS)),
  "POST store/course/task": row("courses", execute, "An answer to a student's hand-in reaches the student."),
  "GET store/creator-card": row("pages", read),
  "POST store/creator-card": row("pages", draft),
  "POST store/crm": row("buyers", draft),
  "POST store/currency": row("settings", draft),
  "GET store/depth": row("numbers", tool("get_page_reading")),
  "POST store/details": row("pages", draft),
  "POST store/discord": row("community", draft),
  "POST store/discord/connect": row("connections", never(CONNECT)),
  "POST store/discount": row("offers", draft, "Discount codes follow 569 [NC1]."),
  "POST store/member-discount": row("offers", draft, "A code on one member's membership changes what they pay: proposed, then confirmed by the creator (631 (c))."),
  "POST store/disputes": row("buyers", never(WORDS)),
  "POST store/domain": row("settings", draft),
  "POST store/dunning": row("email", draft),
  "POST store/email-sync": row("connections", never(CONNECT)),
  "POST store/embed-sites": row("settings", draft),
  "POST store/exit-offer": row("offers", draft),
  "GET store/export": row("buyers", never(PEOPLE_FILE)),
  "POST store/extras": row("products", draft),
  "POST store/fair": row("products", draft),
  "POST store/faq": row("pages", draft),
  "POST store/fields": row("products", draft),
  "POST store/file": row("files", draft),
  "POST store/file/attach": row("files", draft),
  "GET store/file/download": row("files", read),
  "POST store/form-opportunity": row("buyers", draft),
  "POST store/forms": row("pages", draft),
  "GET store/forms/export": row("buyers", never(PEOPLE_FILE)),
  "GET store/forms/response-pdf": row("buyers", never(PEOPLE_FILE)),
  "POST store/funnel": row("offers", draft),
  "GET store/funnel-share": row("pages", read),
  "POST store/funnel-share": row("pages", draft),
  "POST store/goal": row("numbers", draft),
  "POST store/heard-ask": row("settings", draft),
  "POST store/help": row("settings", read, "The studio's help assistant: a question, an answer."),
  "POST store/host-calendar": row("connections", never(CONNECT)),
  "POST store/image": row("products", draft),
  "POST store/image/upload": row("files", draft),
  "GET store/import": row("settings", read),
  "POST store/import": row("settings", execute, "An import writes a great deal at once and says who may be emailed."),
  "POST store/import/funnel": row("pages", draft),
  "POST store/inbox": row("buyers", execute, "An answer in the inbox reaches the buyer."),
  "POST store/intro": row("pages", draft),
  "GET store/keys": row("products", never(SECRET), "License keys are what buyers paid for: secrets."),
  "POST store/keys": row("products", draft),
  "POST store/kit": row("pages", draft),
  "POST store/language": row("settings", draft),
  "GET store/leads": row("email", never(PEOPLE_FILE)),
  "POST store/leaving": row("settings", draft),
  "POST store/letters": row("email", draft),
  "POST store/link-image": row("pages", draft),
  "POST store/links": row("pages", draft),
  "GET store/live": row("numbers", read),
  "POST store/look": row("pages", draft),
  "POST store/mail": row("email", execute, "Drafts are prepared; sending, scheduling and imports to the list are confirmed one at a time."),
  "POST store/mail/picture": row("email", draft),
  "POST store/meta-ads": row("numbers", draft, "Which connected Meta ad account the numbers read; the ads themselves are 632 [AA2]."),
  "POST store/next-actions/draft": row("email", draft, "Writes one email for the creator to change and send themselves; nothing is saved or sent."),
  "POST store/next-offer": row("offers", draft),
  "POST store/no-count": row("numbers", never(BROWSER)),
  "POST store/notes": row("numbers", draft),
  "POST store/nudge": row("email", draft),
  "POST store/numbers-links": row("numbers", draft),
  "POST store/numbers/ask": row("numbers", read),
  "POST store/option": row("products", draft),
  "POST store/order": row("pages", draft),
  "POST store/outreach": row("email", draft),
  "GET store/page": row("pages", tool("get_sales_page")),
  "POST store/page": row("pages", draft),
  "GET store/person-tasks": row("buyers", read),
  "POST store/person-tasks": row("buyers", draft),
  "POST store/page-funnels": row("pages", draft),
  "GET store/page-versions": row("pages", tool("get_page_versions")),
  "POST store/pairs": row("products", draft),
  "GET store/path": row("settings", read),
  "POST store/path": row("settings", draft),
  "POST store/pause": row("settings", draft),
  "POST store/payment-requests": row("buyers", execute, "A request for payment reaches the buyer; the money goes through the creator's own Stripe checkout, never the agent."),
  "POST store/paypal/connect": row("money", never(MONEY)),
  "POST store/paypal/disconnect": row("money", never(MONEY)),
  "GET store/paypal/onboarded": row("money", never(BROWSER)),
  "POST store/person": row("buyers", execute, "Erasing a person cannot be undone: confirmed one person at a time, never in a batch."),
  "POST store/phone": row("settings", never(BROWSER)),
  "POST store/photo": row("pages", draft),
  "POST store/pixels": row("settings", draft),
  "POST store/podcast": row("podcast", draft),
  "POST store/preorder": row("products", draft),
  "GET store/preview": row("files", read),
  "POST store/preview": row("files", draft),
  "GET store/product": row("products", tool("get_product_description")),
  "POST store/product": row("products", draft),
  "POST store/product-update": row("email", execute, "Tells a product's buyers by email."),
  "POST store/recent-sales": row("pages", draft),
  "POST store/recovery": row("email", draft),
  "POST store/release": row("settings", execute, "Lets go of an old address for good."),
  "POST store/rename": row("settings", execute, "Moves the store's public address, which links elsewhere point to."),
  "POST store/resend": row("buyers", execute, "Sends a buyer their purchase email again."),
  "POST store/review-summary": row("community", read),
  "POST store/reviews": row("community", draft),
  "POST store/sale": row("offers", draft),
  "POST store/save-offer": row("offers", draft),
  "GET store/saved-blocks": row("pages", tool("list_saved_blocks")),
  "POST store/saved-blocks": row("pages", draft),
  "POST store/sections": row("pages", draft),
  "POST store/setup": row("pages", draft),
  "GET store/shipped": row("buyers", read),
  "POST store/shipped": row("buyers", execute, "Emails the buyer that the order was sent."),
  "POST store/shipping": row("products", draft),
  "POST store/short-links": row("pages", draft),
  "POST store/signup-box": row("pages", draft),
  "POST store/site-page": row("pages", draft),
  "POST store/socials": row("pages", draft),
  "POST store/visit-us": row("pages", draft),
  "POST store/spend": row("numbers", draft),
  "GET store/stamp": row("files", read),
  "POST store/stamp": row("files", draft),
  "GET store/stats": row("numbers", tool("get_numbers")),
  "GET store/stats/range": row("numbers", read),
  "POST store/store-copy": row("settings", execute, "Copies the whole store into another one."),
  "POST store/stores": row("access", never(ACCESS)),
  "POST store/stream": row("files", draft),
  "POST store/stream/captions": row("courses", draft, "Captions typed or uploaded by the creator; the paid automatic captions (action \"auto\") are never: money."),
  "POST store/tax": row("settings", draft),
  "POST store/team": row("access", never(ACCESS)),
  "POST store/thanks-note": row("products", draft),
  "POST store/tiers": row("products", draft),
  "POST store/tips": row("pages", draft),
  "POST store/vault": row("files", draft),
  "POST store/voice": row("numbers", never(WORDS)),
  "POST store/waitlist": row("products", draft),
  "POST store/webhooks": row("connections", never(SECRET)),
  "POST store/weekly-ai": row("email", draft),
  "POST store/weekly-team": row("email", draft),
  "POST store/welcome-offer": row("offers", draft),
  "POST store/why-not-ask": row("pages", draft),
  "POST store/yearly-ask": row("email", draft),
  "POST stripe/check": row("money", never(MONEY)),
  "POST stripe/connect": row("money", never(MONEY)),
  "POST stripe/disconnect": row("money", never(MONEY)),
  "GET stripe/refresh": row("money", never(BROWSER)),
  "GET stripe/return": row("money", never(BROWSER)),
};

/** Route prefixes where every action is money, so every row under them must be "never". */
export const MONEY_PREFIXES = ["billing/", "stripe/", "store/paypal/", "store/closing-refunds", "store/affiliates/paypal", "store/affiliates/payout-batch"] as const;

/** How many studio actions each kind of reach has: the measure of 631 (a). */
export function coverageCounts(table: Readonly<Record<string, AgentAction>> = AGENT_COVERAGE): Record<AgentReach["kind"], number> {
  const counts: Record<AgentReach["kind"], number> = { tool: 0, read: 0, draft: 0, execute: 0, never: 0 };
  for (const action of Object.values(table)) counts[action.reach.kind] += 1;
  return counts;
}
