/**
 * How much a contact has shown interest in a store, scored only from what
 * they did with it (268 [KT2], unit 1; added 1 November 2026, corrected the
 * same day after an independent review).
 *
 * Every point comes from something the contact did with this store and the
 * store already keeps: buying (the buyers' ledger, lib/segments.ts, which
 * counts checkouts), joining the list themselves (the contact record's
 * source, lib/contacts.ts: a free product, the store's sign-up box or a
 * waitlist), being seen in the store's community (lib/community.ts,
 * lastSeenIn, in seconds). Never an email opened: no open is recorded
 * anywhere (there is no pixel), and Apple Mail Privacy Protection preloads
 * remote content anyway. Never anything bought or looked up elsewhere.
 *
 * Not the links a reader used in sequence emails (lib/mail-clicks.ts):
 * the privacy policy says that is used only to choose a reader's next email
 * and that "the creator does not get a list of what you did", so it is not
 * shown to the creator as points.
 *
 * The creator sees the score beside its reasons, each with the points it
 * gave. It is a count of what happened, not a prediction; it decides no
 * price, discount, access, refund or block.
 *
 * Browser-safe: plain data and pure functions. Before it is shown (unit 2):
 * the privacy policy, the right to object to it, telling existing contacts,
 * and its record in lib/person-data.ts if anything is kept.
 */

const DAY_MS = 86_400_000;
const DAY_S = 86_400;

/** What the store knows a contact did, each from its own record. */
export type InterestSignals = {
  /** Checkouts paid, from the buyers' ledger. */
  orders: number;
  /** When they last bought, in milliseconds (the ledger's); 0 when never. */
  lastBought: number;
  /** They joined the list themselves (contact source "free"), not as a buyer or by an import. */
  joinedThemselves: boolean;
  /** When they were last seen in the community, in seconds (lastSeenIn's); 0 when never. */
  lastSeenInCommunitySeconds: number;
};

export type InterestReason = { points: number; words: string };

/** The rules, each with its points and its cap, said as the creator reads them. */
export const INTEREST_RULES = {
  perOrder: { points: 3, most: 5, words: "3 points for each purchase, up to 5 purchases" },
  recentOrder: { points: 2, days: 90, words: "2 points for a purchase in the last 90 days" },
  joined: { points: 2, words: "2 points for joining your list themselves" },
  community: { points: 2, days: 30, words: "2 points for being in your community in the last 30 days" },
} as const;

/** The score and the reasons it is made of, from the contact's own signals. */
export function interestScore(signals: InterestSignals, now = Date.now()): { score: number; reasons: InterestReason[] } {
  const r = INTEREST_RULES;
  const reasons: InterestReason[] = [];
  const counted = Number.isFinite(signals.orders) ? Math.max(0, Math.floor(signals.orders)) : 0;
  const orders = Math.min(counted, r.perOrder.most);
  if (orders > 0) reasons.push({ points: orders * r.perOrder.points, words: `Bought ${orders === 1 ? "once" : `${orders} times`}${counted > r.perOrder.most ? " or more" : ""}` });
  // A date in the future, or a purchase without a counted order, gives nothing.
  const bought = signals.lastBought;
  if (orders > 0 && Number.isFinite(bought) && bought > 0 && bought <= now && now - bought <= r.recentOrder.days * DAY_MS) reasons.push({ points: r.recentOrder.points, words: `Bought in the last ${r.recentOrder.days} days` });
  if (signals.joinedThemselves) reasons.push({ points: r.joined.points, words: "Joined your list themselves" });
  const seen = signals.lastSeenInCommunitySeconds;
  const nowS = Math.floor(now / 1000);
  if (Number.isFinite(seen) && seen > 0 && seen <= nowS && nowS - seen <= r.community.days * DAY_S) reasons.push({ points: r.community.points, words: `In your community in the last ${r.community.days} days` });
  return { score: reasons.reduce((sum, reason) => sum + reason.points, 0), reasons };
}

/**
 * The highest score anybody can have. A store without a community cannot
 * give its 2 points: unit 2 says "of" the store's own most, never this one.
 */
export const INTEREST_MOST = INTEREST_RULES.perOrder.points * INTEREST_RULES.perOrder.most + INTEREST_RULES.recentOrder.points + INTEREST_RULES.joined.points + INTEREST_RULES.community.points;
