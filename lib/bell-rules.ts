/**
 * The studio's bell (766 [STN13], unit 4): what needs the creator, kept apart
 * from news, under the studio's top bar on every studio screen
 * (components/studio-bell.tsx).
 *
 * Built only from the store record that every studio page already holds
 * (lib/studio-route.ts, studioView), so the bell reads nothing more: no
 * database, no Stripe, no model. Each item is said the way the studio home
 * says it, and leads to the place that deals with it:
 *
 *   Needs you
 *     renewal        the plan's renewal payment did not go through: the
 *                    home's notice #renewal-unpaid (which tells a role that
 *                    may not pay to ask the owner);
 *     plan-disputed  a plan payment disputed with the bank, by the home's
 *                    own test (paid up, and planDisputed): its notice
 *                    #plan-disputed;
 *     suspended      the store switched off after notices about its content:
 *                    how to answer, and the policy;
 *     stripe         a Stripe account that may not take payments yet: the
 *                    store check, only for a role that may open it
 *                    ("settings"); a store with no account yet is left to its
 *                    first steps.
 *   News
 *     taken-down     each piece taken down after a notice, with its date,
 *                    newest first, at most MOST_NEWS, then how many more.
 *
 * Nothing else is invented to fill it: with nothing to say, the panel says
 * "Nothing needs you right now."
 */
import { type PlanDispute, planDisputed } from "@/lib/plan-dispute-rules";
import type { Store } from "@/lib/store";
import { type Role, can } from "@/lib/team-roles";

/** What the bell reads of the store record; a page that hands over less gets a quiet bell. */
export type BellFacts = Partial<Pick<Store, "subscriptionActive" | "suspended" | "strikes" | "stripeAccountId" | "stripeChargesEnabled">> & {
  renewalUnpaidSince?: number;
  planDisputes?: PlanDispute[];
};

export type BellItem = { id: string; words: string; link: { href: string; label: string } | null };
export type BellView = { needs: BellItem[]; news: BellItem[] };

/** The most pieces taken down that the bell lists; the rest are counted, each in its own email already. */
export const MOST_NEWS = 5;

/** A place on the studio home, for this store. */
function home(sid: string, anchor: string): string {
  return `${sid ? `/studio?store=${encodeURIComponent(sid)}` : "/studio"}#${anchor}`;
}

/** "November 3, 2026", in UTC like every date the studio shows; null when the time cannot be read. */
function dayWords(at: string): string | null {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function bellView(store: { sid: string } & BellFacts, role: Role, nowMs: number): BellView {
  const needs: BellItem[] = [];
  if ((store.renewalUnpaidSince ?? 0) > 0) {
    needs.push({ id: "renewal", words: "Your plan's renewal payment did not go through.", link: { href: home(store.sid, "renewal-unpaid"), label: "See what to do about your plan's payment" } });
  }
  if (store.subscriptionActive === true && planDisputed(store, nowMs / 1000)) {
    needs.push({ id: "plan-disputed", words: "A payment for your plan is disputed with your bank.", link: { href: home(store.sid, "plan-disputed"), label: "Read what a disputed plan payment pauses" } });
  }
  if (store.suspended) {
    needs.push({
      id: "suspended",
      words: "Your store's pages and sales are switched off after notices about its content. To send a counter-notice, reply to the email we sent you about it.",
      link: { href: "/copyright", label: "Read our policy on content notices" },
    });
  }
  if (store.stripeAccountId && store.stripeChargesEnabled === false && can(role, "settings")) {
    needs.push({ id: "stripe", words: "Stripe has not let your store take payments yet.", link: { href: `/studio/checkup?store=${encodeURIComponent(store.sid)}`, label: "Check what Stripe still needs" } });
  }

  const strikes = store.strikes ?? [];
  const news: BellItem[] = strikes.slice(0, MOST_NEWS).map((strike, i) => {
    const day = dayWords(strike.at);
    return { id: `taken-down-${i}`, words: `Taken down${day ? ` on ${day}` : ""}: ${strike.what}.`, link: null };
  });
  if (strikes.length > MOST_NEWS) {
    news.push({ id: "taken-down-more", words: `And ${strikes.length - MOST_NEWS} earlier, each in the email we sent you about it.`, link: null });
  }
  return { needs, news };
}
