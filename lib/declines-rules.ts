/**
 * Payments that did not go through, by why (630 [HN6](28)): each declined
 * charge on the creator's own Stripe account is put in a group by the reason
 * Stripe gives (the charge's `outcome.reason`, else its `failure_code`), and
 * each group says, in plain words, what usually helps. Counted, never
 * guessed: a reason Stripe did not give is "other", with Stripe's own word.
 * Pure: lib/declines.ts reads the charges.
 */

export type DeclineGroup = "funds" | "expired" | "typo" | "confirm" | "bank" | "fraud" | "network" | "unsupported" | "other";

/**
 * Stripe's reasons, as they are grouped here. Anything not listed is "other".
 * A Map, so a reason is only ever one of these keys, never a name every
 * object inherits ("constructor", "__proto__").
 */
const REASONS: ReadonlyMap<string, DeclineGroup> = new Map(Object.entries({
  insufficient_funds: "funds",
  card_velocity_exceeded: "funds",
  withdrawal_count_limit_exceeded: "funds",
  expired_card: "expired",
  incorrect_cvc: "typo",
  invalid_cvc: "typo",
  incorrect_number: "typo",
  invalid_number: "typo",
  incorrect_zip: "typo",
  invalid_expiry_month: "typo",
  invalid_expiry_year: "typo",
  authentication_required: "confirm",
  card_declined: "bank",
  generic_decline: "bank",
  do_not_honor: "bank",
  do_not_try_again: "bank",
  call_issuer: "bank",
  issuer_not_available: "network",
  processing_error: "network",
  try_again_later: "network",
  reenter_transaction: "network",
  fraudulent: "fraud",
  stolen_card: "fraud",
  lost_card: "fraud",
  pickup_card: "fraud",
  merchant_blacklist: "fraud",
  highest_risk_level: "fraud",
  elevated_risk_level: "fraud",
  rule: "fraud",
  currency_not_supported: "unsupported",
  card_not_supported: "unsupported",
  transaction_not_allowed: "unsupported",
  not_permitted: "unsupported",
} satisfies Record<string, DeclineGroup>));

/** What each group is called and what usually helps, in plain words. */
export const DECLINE_WORDS: Record<DeclineGroup, { title: string; help: string }> = {
  funds: { title: "Not enough money on the card", help: "Nothing to fix in your store. A buyer may try again later; a payment plan, if you offer one, can make it easier." },
  expired: { title: "The card had expired", help: "The buyer needs another card. Trying again with the same one will not work." },
  typo: { title: "A card detail was typed wrong", help: "The number, date, security code or postal code did not match. Buyers usually fix it and pay right away." },
  confirm: { title: "The bank asked the buyer to confirm", help: "The buyer did not finish their bank's check (often in its app). Trying again and approving it there usually works." },
  bank: { title: "The bank said no, without a reason", help: "Only the buyer's bank knows why. The buyer can call the bank or use another card." },
  fraud: { title: "Blocked as likely fraud", help: "The bank or Stripe's own checks stopped it. Do not ask for the same card again; Stripe's dashboard shows why each was blocked." },
  network: { title: "A problem at the bank or card network", help: "Not about the buyer or your store. Trying again a little later usually works." },
  unsupported: { title: "This card cannot pay for this", help: "The card does not allow this currency or kind of purchase. Another card or payment method is needed." },
  other: { title: "Other reasons", help: "Stripe gave another reason, shown with each. Its dashboard explains them." },
};

/**
 * One declined charge. `cents` and `currency` are null together when Stripe
 * did not give both readably: unknown, never 0 and never a guessed currency.
 */
export type DeclineRow = { reason: string; cents: number | null; currency: string | null; created: number };

/** The group a reason belongs to. */
export function declineGroup(reason: string): DeclineGroup {
  return REASONS.get(reason) ?? "other";
}

/** The reason a declined charge gives, as Stripe writes it; "" when it gives none. */
export function reasonOf(charge: { outcome?: unknown; failure_code?: unknown }): string {
  const outcome = charge.outcome && typeof charge.outcome === "object" ? (charge.outcome as { reason?: unknown }).reason : undefined;
  const raw = typeof outcome === "string" && outcome ? outcome : typeof charge.failure_code === "string" ? charge.failure_code : "";
  return /^[a-z_]{1,60}$/.test(raw) ? raw : "";
}

/** Per group: how many, the amounts per currency, how many had no readable amount (`unknown`), and Stripe's reasons. */
export type DeclineSummary = { group: DeclineGroup; count: number; amounts: { currency: string; cents: number }[]; unknown: number; reasons: string[] }[];

/** The declines by group, most first; each with its amounts per currency (never added across currencies, an unknown amount never added as 0) and Stripe's reasons in it. */
export function declineSummary(rows: readonly DeclineRow[]): DeclineSummary {
  const by = new Map<DeclineGroup, { count: number; amounts: Map<string, number>; unknown: number; reasons: Set<string> }>();
  for (const row of rows) {
    const group = declineGroup(row.reason);
    const entry = by.get(group) ?? { count: 0, amounts: new Map(), unknown: 0, reasons: new Set() };
    entry.count += 1;
    if (row.cents === null || row.currency === null) entry.unknown += 1;
    else entry.amounts.set(row.currency, (entry.amounts.get(row.currency) ?? 0) + row.cents);
    if (row.reason) entry.reasons.add(row.reason);
    by.set(group, entry);
  }
  return [...by.entries()]
    .map(([group, e]) => ({ group, count: e.count, amounts: [...e.amounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, cents]) => ({ currency, cents })), unknown: e.unknown, reasons: [...e.reasons].sort() }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
}
