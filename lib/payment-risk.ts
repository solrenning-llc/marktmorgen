/**
 * 647 [WG7], unit 1: the payment protection of a creator's store, as pure
 * rules. Every sale is a direct charge on the creator's own Stripe account,
 * so Radar and its rules stay the creator's; what Marktmorgen decides is only
 * what it already controls when it opens a checkout session (whether the
 * buyer's bank is asked to verify the payment) and what it already reads from
 * the charge (the risk Stripe gave it, expanded by lib/api-sales.ts).
 *
 * - The risk is read off `charge.outcome.risk_level`: "normal", "elevated" or
 *   "highest" as Stripe says it; anything else ("not_assessed", "unknown",
 *   no outcome, a value Stripe does not send) is "not available", never
 *   "normal" and never "low". A charge in Stripe's manual review (or with an
 *   open review) is "in review", whatever level it carries. No 0-100 score: that is Radar for Fraud Teams,
 *   billed by Stripe to the creator.
 * - A store keeps at most three simple rules, each kind once, read back whole
 *   or not at all: ask for verification above an amount, ask for it on the
 *   first purchase of an address in a product, hold for review the shipping
 *   of a physical order whose charge is "elevated" or "highest".
 * - Asking is the protective side, so a rule that cannot be evaluated (an
 *   unreadable amount, not knowing whether it is the first purchase) asks.
 *   A risk that cannot be read is said as such on a held shipment, never
 *   taken as clean.
 * - The verification asked is 3D Secure "any", the value lib/billing.ts and
 *   lib/assistant-billing.ts already send on Marktmorgen's own plans; not
 *   asked, nothing is sent and Stripe keeps its own judgement.
 *
 * No rule here blocks a refund, an access already paid for or a cancellation,
 * and nothing here changes a price, a limit or the charge itself. No Stripe
 * call: the field goes on the session the checkout already creates, and the
 * risk comes from the read lib/api-sales.ts already makes.
 */

export type RiskLevel = "normal" | "elevated" | "highest" | "in_review" | "not_available";

const STRIPE_LEVELS: ReadonlySet<string> = new Set(["normal", "elevated", "highest"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The risk Stripe gave a charge, or "not_available" when it cannot be read. */
export function riskLevelOf(charge: unknown): RiskLevel {
  const c = record(charge);
  if (!c || c.object !== "charge" || typeof c.id !== "string" || !c.id) return "not_available";
  const outcome = record(c.outcome);
  // A charge Stripe put in manual review (a Radar rule of the creator's) often
  // still says "normal": the open review, not the level, is what decides.
  if (outcome?.type === "manual_review" || (c.review !== null && c.review !== undefined)) return "in_review";
  const level = outcome?.risk_level;
  return typeof level === "string" && STRIPE_LEVELS.has(level) ? (level as RiskLevel) : "not_available";
}

/** The words on the sales list and the order. */
export const RISK_WORDS: Record<RiskLevel, string> = {
  normal: "Risk: normal",
  elevated: "Risk: elevated",
  highest: "Risk: highest",
  in_review: "Risk: in review by Stripe",
  not_available: "Risk: not available",
};

/** The option on a product and on a payment request, off by default. */
export const VERIFY_LABEL = "Ask the buyer's bank to verify this payment";
export const VERIFY_HINT = "Verification can reduce fraud and disputes, and some buyers may not finish paying.";

/** Stripe's largest single charge in cents (US$999,999.99): no threshold above it means anything. */
export const STRIPE_MAX_CENTS = 99_999_999;
export const MAX_RULES = 3;

export type PaymentRule =
  | { kind: "verify_over"; cents: number }
  | { kind: "verify_first_purchase" }
  | { kind: "hold_risky_shipping" };

function ruleOf(raw: unknown): PaymentRule | null {
  const r = record(raw);
  if (!r) return null;
  if (r.kind === "verify_over") {
    const cents = r.cents;
    return typeof cents === "number" && Number.isSafeInteger(cents) && cents > 0 && cents <= STRIPE_MAX_CENTS ? { kind: "verify_over", cents } : null;
  }
  if (r.kind === "verify_first_purchase" || r.kind === "hold_risky_shipping") return { kind: r.kind };
  return null;
}

/** A store's rules read back whole, or null when anything in them is not ours. */
export function parsePaymentRules(raw: unknown): PaymentRule[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_RULES) return null;
  const rules: PaymentRule[] = [];
  const kinds = new Set<string>();
  for (const item of raw) {
    const rule = ruleOf(item);
    if (!rule || kinds.has(rule.kind)) return null;
    kinds.add(rule.kind);
    rules.push(rule);
  }
  return rules;
}

/**
 * The rules kept for a store, from the stored value: no value stored (the key
 * does not exist) is no rules, a real answer; anything stored that does not
 * read back whole is unknown (null), never an empty list. A read that failed
 * must not reach here as null: it throws in lib/redis.ts.
 */
export function storedPaymentRules(stored: string | null): PaymentRule[] | null {
  if (stored === null) return [];
  if (typeof stored !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return null;
  }
  return parsePaymentRules(raw);
}

/**
 * Whether the buyer's bank is asked to verify this payment: the product's own
 * option, or a store rule that applies. A rule that cannot be evaluated asks.
 */
export function asksVerification(input: {
  productAsks: boolean;
  rules: readonly PaymentRule[] | null;
  amountCents: number | null;
  firstPurchase: boolean | null;
}): boolean {
  if (input.productAsks === true) return true;
  // Rules we could not read may hold one that asks: asking is the protective side.
  if (input.rules === null) return true;
  for (const rule of input.rules) {
    if (rule.kind === "verify_over") {
      const amount = input.amountCents;
      if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) return true;
      if (amount > rule.cents) return true;
    } else if (rule.kind === "verify_first_purchase") {
      if (input.firstPurchase !== false) return true;
    }
  }
  return false;
}

/** The one field put on the checkout session when verification is asked; nothing otherwise. */
export function threeDSecureFields(asks: boolean): Record<string, string> {
  return asks ? { "payment_method_options[card][request_three_d_secure]": "any" } : {};
}

export type ShippingDecision = "ship" | "hold" | "risk_not_available" | "rules_not_available";

/** Whether a physical order's shipping is held for the creator's review under the store's rule. */
export function shippingDecision(input: { rules: readonly PaymentRule[] | null; physical: boolean; risk: RiskLevel }): ShippingDecision {
  if (input.physical !== true) return "ship";
  // Rules we could not read may hold the shipping rule: said as such, never shipped clean.
  if (input.rules === null) return "rules_not_available";
  if (!input.rules.some((r) => r.kind === "hold_risky_shipping")) return "ship";
  if (input.risk === "elevated" || input.risk === "highest" || input.risk === "in_review") return "hold";
  if (input.risk === "normal") return "ship";
  return "risk_not_available";
}
