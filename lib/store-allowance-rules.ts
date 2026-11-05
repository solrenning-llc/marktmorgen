/**
 * What each plan covers of the uses that had no monthly figure until 17
 * October 2026, and the words a refusal is told in.
 *
 * Every one of these costs us something each time (a function answering,
 * its database commands, an email, a wait on another service), and each was
 * bounded only per minute, hour or day, or not at all, so no plan's worst
 * month could say what they cost (tests/plan-cost-registry.ts listed them as
 * OPEN). Now each is counted per store in the store's window
 * (lib/allowance-window.ts: its billing month when it pays us, the calendar
 * month otherwise) and refused, with a plain sentence, before the cost is
 * incurred once the figure is used:
 *
 *   studio         every request the studio makes for a store: pages drawn,
 *                  saves, reads, its own refreshing (lib/studio-route.ts).
 *                  Moving to a larger plan, cancelling, signing out and
 *                  downloading the store's own data are never refused.
 *   api            every request to the REST API with one of the store's
 *                  keys (lib/api-guard.ts).
 *   inbox          a conversation in the store's inbox: a visitor's chat, a
 *                  contact form, or one the creator begins with one of their
 *                  affiliates (lib/inbox.ts).
 *   email          the emails a store's own paths send that are neither its
 *                  monthly emails (lib/mail.ts) nor an order's: inbox notices
 *                  and replies, a purchase sent again, contact-form and
 *                  inbound-mail notices, checkout reminders, come-back and
 *                  welcome offers, payment reminders to members, the yearly
 *                  offer (tests/plan-cost-registry.ts, EMAIL_SITES).
 *   transactional  the emails that hand a buyer what they have: a link to
 *                  their purchases, a private podcast's link, a member's
 *                  sign-in to the store.
 *   integration    a call to another service made for the store: a meeting
 *                  started or read, a calendar checked by hand, Discord,
 *                  email platforms, Meta ads, PayPal, a business's site read
 *                  for outreach, video upload doors, the vault.
 *   buyer          (since 18 October 2026) what buyers, and the creator,
 *                  do inside what was bought, outside the pages themselves:
 *                  a community post, comment, like, message, RSVP, picture
 *                  door, event, a lesson comment, a hand-in and its upload
 *                  door, a lesson marked done, a certificate made
 *                  (lib/buyer-actions.ts). A buyer is told the store is
 *                  resting for now; nothing they already have is taken away.
 *   webhook        (since 18 October 2026) each try of a webhook delivery to
 *                  one of the creator's endpoints, the first one, each retry
 *                  and each test (lib/webhooks.ts). A delivery past the
 *                  figure is not tried and is marked failed with the reason.
 *
 * The figures are each plan's own, sized so every plan, paid by the month or
 * by the year, keeps the owner's 60% at every figure used in full
 * (tests/spend-floor.test.ts). Prices never change for them.
 *
 * Nothing here touches the network: the pages that publish these figures
 * read the same ones the counters do.
 */
import type { Tier } from "@/lib/plan";
import { type PlanFields, type Standing, standingOf } from "@/lib/plan-standing";

export const ALLOWANCE_KINDS = ["studio", "api", "inbox", "email", "transactional", "integration", "buyer", "webhook"] as const;
export type AllowanceKind = (typeof ALLOWANCE_KINDS)[number];

/** Each plan's figure for a window, per store. */
export const STORE_ALLOWANCES: Record<Tier, Record<AllowanceKind, number>> = {
  creator: { studio: 2_000, api: 500, inbox: 100, email: 75, transactional: 150, integration: 50, buyer: 200, webhook: 300 },
  pro: { studio: 5_000, api: 2_000, inbox: 300, email: 300, transactional: 400, integration: 200, buyer: 1_000, webhook: 1_000 },
  scale: { studio: 15_000, api: 10_000, inbox: 1_000, email: 800, transactional: 1_000, integration: 500, buyer: 3_000, webhook: 3_000 },
};

/**
 * What a store that pays nothing has (a free trial, no plan, a plan that
 * ended): small, and bounded besides by the shared ceiling on how many such
 * stores may use anything that costs in a month (lib/free-pool-rules.ts).
 * A store with no plan or an ended one keeps the studio to set up, close or
 * take its data away, and answers what its buyers need.
 */
export const NON_PAYING_ALLOWANCES: Record<Exclude<Standing, "paid">, Record<AllowanceKind, number>> = {
  trial: { studio: 1_000, api: 100, inbox: 30, email: 30, transactional: 40, integration: 20, buyer: 50, webhook: 50 },
  none: { studio: 300, api: 0, inbox: 20, email: 25, transactional: 20, integration: 5, buyer: 20, webhook: 0 },
  ended: { studio: 100, api: 0, inbox: 0, email: 0, transactional: 20, integration: 0, buyer: 20, webhook: 0 },
};

/** The figure this store has for one kind in its window. */
export function allowanceFor(store: PlanFields & { tier?: Tier }, kind: AllowanceKind, nowSeconds = Date.now() / 1000): number {
  const standing = standingOf(store, nowSeconds);
  if (standing === "paid") return (STORE_ALLOWANCES[store.tier ?? "creator"] ?? STORE_ALLOWANCES.creator)[kind];
  return NON_PAYING_ALLOWANCES[standing][kind];
}

/**
 * The share of a store's access emails ("transactional") that confirmations
 * to an address nobody has shown is anybody's may take, in hundredths of a
 * percent (18 October 2026, docs/security-audit-2026-10-18.md, MM-SA-05).
 *
 * The sign-up box, a waitlist and the affiliate form email whatever address a
 * visitor types, and each was paid from the same figure as the links buyers
 * are sent to what they bought. Limited only by the hour, per connection and
 * per address, a script from many connections could spend the month's figure
 * on made-up addresses, and every buyer who asked for their link afterward
 * was sent nothing. Those confirmations now stop at this share of the figure,
 * and the rest is kept for buyers: the figure itself, and what it costs, is
 * unchanged.
 */
export const ASKED_SHARE_BPS = 5_000;

/** Where confirmations to typed addresses stop, for a figure of `limit`. */
export function askedCeiling(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) return 0;
  return Math.floor((limit * ASKED_SHARE_BPS) / 10_000);
}

/** A contact added or a product given through the API is this many of the window's API requests, the request included (lib/api-write.ts). */
export const API_WRITE_UNITS = 5;
/**
 * A page of sales read through the API (GET /api/v1/sales, lib/api-sales.ts) is this many of the window's API
 * requests, the request included: it may wait on the creator's Stripe account for its whole ceiling while a
 * hundred checkouts come back (tests/plan-cost-registry.ts, API_SALES_READ).
 */
export const API_SALES_UNITS = 10;

/** How each kind is named in a sentence: "studio requests", "API requests". */
export const KIND_WORDS: Record<AllowanceKind, { many: string; what: string }> = {
  studio: { many: "studio requests", what: "Your studio's requests" },
  api: { many: "API requests", what: "Your store's API requests" },
  inbox: { many: "inbox messages", what: "Your inbox's messages" },
  email: { many: "store emails", what: "Your store's emails (notices, replies, reminders and offers)" },
  transactional: { many: "access emails", what: "Your buyers' access emails (links to their purchases and podcasts)" },
  integration: { many: "calls to connected services", what: "Your calls to connected services" },
  buyer: { many: "buyer actions", what: "Your buyers' actions (posts, comments, messages, hand-ins)" },
  webhook: { many: "webhook deliveries", what: "Your webhook deliveries" },
};

/** "2,000 studio requests, 500 API requests, ... and 50 calls to connected services": a plan's figures, for the pages that publish them. */
export function allowanceListWords(tier: Tier): string {
  const figures = STORE_ALLOWANCES[tier];
  const parts = ALLOWANCE_KINDS.map((kind) => `${figures[kind].toLocaleString("en-US")} ${KIND_WORDS[kind].many}`);
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "2,000": a figure with its thousands marked. */
const count = (n: number) => Math.max(0, Math.floor(n)).toLocaleString("en-US");

/**
 * The sentence a refusal starts with, for the creator. `reset` says when it
 * opens again (lib/allowance-window.ts, resetWords). `standing` names the
 * window: the whole trial in a trial, the month otherwise. `plansOnSale`
 * (lib/opening.ts, passed in so this file stays browser-safe) decides whether
 * a plan can be started or changed at all; only then is that offered, and a
 * larger plan only to a store that pays and has one above it on sale
 * (`larger`).
 */
export function usedWords(kind: AllowanceKind, limit: number, reset: string, standing: Standing, plansOnSale: boolean, larger: boolean): string {
  const words = KIND_WORDS[kind];
  if (limit <= 0) {
    const where = standing === "trial" ? "in the trial" : standing === "paid" ? "in this plan" : "without a paid plan";
    return `${words.what} are not included ${where}.${plansOnSale ? " Start or move to a plan that includes them." : ""}`;
  }
  const period = standing === "trial" ? "for this trial" : "for this month";
  const move = plansOnSale && standing === "paid" && larger ? " Moving to a larger plan raises the figure at once." : "";
  return `${words.what} ${period} are used: ${count(limit)} ${words.many}. ${reset}${move}`;
}

/** What a visitor or a buyer is told when a store cannot take what they sent: never the store's plan. */
export const VISITOR_REFUSAL = "This store can't take this right now. Please try again later.";
