/**
 * 649 [WG9], unit 1: the rules of a refund the creator gives from the buyer's
 * record in the studio, pure. The refund itself goes later on the creator's
 * own Stripe account (lib/stripe-account.ts), the access closes by
 * the one rule of lib/refunds.ts, and the buyer is told in their language;
 * none of that is here. What is here decides, before any call:
 *
 * - who may refund: only a role with the team's "payments" permission
 *   (lib/team-roles.ts), which today is the owner alone;
 * - what can still be refunded, read off the charge Stripe returns: the
 *   amount charged less what was refunded already. Anything unreadable (an
 *   amount that is not whole, more refunded than charged, no currency, a paid
 *   or disputed flag that is not a boolean or says otherwise) is "unreadable":
 *   never zero, never the whole charge. A disputed charge is defended or lost
 *   in the dispute, never refunded here; a pending or failed one is not paid;
 *   one refunded in full has nothing left;
 * - the amount: all that is left, or a typed part read the way a price is
 *   read (lib/money.ts readMoney: no sign, no separator, no extra decimals),
 *   never above what is left and never cut down to fit. A currency Marktmorgen
 *   does not price in is refunded only in full, so a typed figure is never
 *   read in the wrong unit;
 * - the reason: one of the three Stripe takes, or none;
 * - one idempotency key per action, made from the store, the charge and the
 *   token of the form that was drawn, so two clicks of the same form give
 *   back once and a new form is a new refund;
 * - Stripe's answer: "done" only when it is a refund of this charge, for this
 *   amount, that succeeded. Pending is not done, failed is failed, and
 *   anything else is unknown, which is never recorded as done.
 */
import { ROLE_PERMISSIONS, can, type Role } from "@/lib/team-roles";
import { isCurrency, readMoney } from "@/lib/money";

/** Whether this role may give a refund from the buyer's record; a role we do not have may not. */
export function canRefund(role: Role): boolean {
  if (typeof role !== "string" || !Object.hasOwn(ROLE_PERMISSIONS, role)) return false;
  return can(role, "payments");
}

export type Refundable =
  | { ok: true; chargeId: string; currency: string; amountCents: number; refundedCents: number; refundableCents: number }
  | { ok: false; reason: "unreadable" | "not_paid" | "disputed" | "fully_refunded" };

const UNREADABLE = { ok: false, reason: "unreadable" } as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function whole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** What can still be refunded on a charge as Stripe returned it. */
export function refundableOf(charge: unknown): Refundable {
  const c = record(charge);
  if (!c || c.object !== "charge" || typeof c.id !== "string" || !c.id) return UNREADABLE;
  const { amount, amount_refunded: refunded, currency, disputed, paid, status } = c;
  if (!whole(amount) || !whole(refunded) || refunded > amount) return UNREADABLE;
  if (typeof currency !== "string" || !/^[a-z]{3}$/.test(currency)) return UNREADABLE;
  if (typeof disputed !== "boolean" || typeof paid !== "boolean") return UNREADABLE;
  if (status === "pending" || status === "failed") return { ok: false, reason: "not_paid" };
  if (status !== "succeeded" || paid !== true) return UNREADABLE;
  if (disputed) return { ok: false, reason: "disputed" };
  if (refunded === amount) return { ok: false, reason: "fully_refunded" };
  return { ok: true, chargeId: c.id, currency, amountCents: amount, refundedCents: refunded, refundableCents: amount - refunded };
}

export type RefundAmount =
  | { ok: true; cents: number }
  | { ok: false; reason: "empty" | "zero" | "not_an_amount" | "over_refundable" | "currency_not_listed" };

/** The amount to give back: all that is left, or the typed part of it. */
export function refundAmount(input: { full: boolean; typed: string }, refundable: Extract<Refundable, { ok: true }>): RefundAmount {
  if (input.full === true) return { ok: true, cents: refundable.refundableCents };
  if (!isCurrency(refundable.currency)) return { ok: false, reason: "currency_not_listed" };
  const text = typeof input.typed === "string" ? input.typed.trim() : "";
  if (!text) return { ok: false, reason: "empty" };
  const cents = readMoney(text, refundable.currency);
  if (cents === null) return { ok: false, reason: "not_an_amount" };
  if (cents === 0) return { ok: false, reason: "zero" };
  if (cents > refundable.refundableCents) return { ok: false, reason: "over_refundable" };
  return { ok: true, cents };
}

/** The reasons Stripe takes on a refund. */
export const REFUND_REASONS = ["requested_by_customer", "duplicate", "fraudulent"] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export function parseRefundReason(raw: unknown): RefundReason | null {
  return typeof raw === "string" && (REFUND_REASONS as readonly string[]).includes(raw) ? (raw as RefundReason) : null;
}

/**
 * The idempotency key of one refund action: the store, the charge and the
 * random token of the form drawn for it (32 hex characters). Null when any
 * part is not one we make, so nothing is sent without a key.
 */
export function refundIdempotencyKey(storeId: string, chargeId: string, actionToken: string): string | null {
  if (typeof storeId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(storeId)) return null;
  if (typeof chargeId !== "string" || !/^(ch|py)_[A-Za-z0-9]{1,80}$/.test(chargeId)) return null;
  if (typeof actionToken !== "string" || !/^[a-f0-9]{32}$/.test(actionToken)) return null;
  return `mm:refund:${storeId}:${chargeId}:${actionToken}`;
}

export type RefundOutcome = "done" | "pending" | "failed" | "unknown";

/** What Stripe's answer to a refund says, measured against what was asked. */
export function refundOutcome(reply: unknown, asked: { chargeId: string; cents: number }): RefundOutcome {
  const r = record(reply);
  if (!r || r.object !== "refund" || typeof r.id !== "string" || !r.id) return "unknown";
  const charge = typeof r.charge === "string" ? r.charge : record(r.charge)?.id;
  if (charge !== asked.chargeId || r.amount !== asked.cents) return "unknown";
  if (r.status === "succeeded") return "done";
  if (r.status === "pending" || r.status === "requires_action") return "pending";
  if (r.status === "failed" || r.status === "canceled") return "failed";
  return "unknown";
}
