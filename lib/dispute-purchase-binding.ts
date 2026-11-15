/**
 * Bind records fetched on the creator's connected Stripe account.
 * Pure validation only: no network call, submission, delivery reopening or retention.
 * Server callers must supply the actual account used for all three Stripe reads,
 * and the store's saleHandles; none of those values may come from a buyer payload.
 */
type Row = Record<string, unknown>;
function row(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}
function id(value: unknown, prefix: string): string | null {
  const raw = typeof value === "string" ? value : row(value)?.id;
  return typeof raw === "string" && new RegExp("^" + prefix + "_[A-Za-z0-9]{1,128}$").test(raw) ? raw : null;
}
/**
 * A Checkout Session ID as Stripe issues it: cs_test_... or cs_live_... (and the bare cs_... the fixtures use).
 * Shared by the binding and the retained pre-order read so both steps accept the same IDs (#4713).
 */
export const CHECKOUT_SESSION_ID = /^cs_(?:(?:test|live)_)?[A-Za-z0-9]{1,128}$/;
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export type StripePurchaseBinding = {
  account: string; dispute: string; purchase: string; charge: string; paymentIntent: string;
  buyerEmail: string; product: string; title: string | null;
  checkoutCreatedAt: number; chargeCreatedAt: number; amount: number; disputedAmount: number; currency: string;
};
/**
 * This initial adapter supports fully captured Checkout payments with an expanded charge.
 * Missing/mismatched records, subscription invoices and other payment rails return
 * null; callers must show unavailable evidence rather than guess a relationship.
 */
export function bindStripeDisputePurchase(input: {
  account: string;
  saleHandles: ReadonlySet<string>;
  dispute: unknown;
  session: unknown;
}): StripePurchaseBinding | null {
  const dispute = row(input.dispute);
  const session = row(input.session);
  if (!dispute || !session || !id(input.account, "acct") ||
      dispute.object !== "dispute" || session.object !== "checkout.session" ||
      !id(dispute.id, "du") || typeof session.id !== "string" || !CHECKOUT_SESSION_ID.test(session.id) ||
      session.mode !== "payment" || session.status !== "complete" || session.payment_status !== "paid") return null;
  const metadata = row(session.metadata);
  if (!metadata || typeof metadata.store !== "string" || !input.saleHandles.has(metadata.store) ||
      typeof metadata.product !== "string" || !/^[a-f0-9]{32}$/.test(metadata.product)) return null;
  const intent = row(session.payment_intent);
  const charge = row(intent?.latest_charge);
  const paymentIntent = id(intent, "pi");
  const chargeId = id(charge, "ch");
  if (!intent || !charge || intent.object !== "payment_intent" || charge.object !== "charge" ||
      !paymentIntent || !chargeId || intent.status !== "succeeded" || charge.paid !== true || charge.captured !== true ||
      id(dispute.charge, "ch") !== chargeId ||
      id(dispute.payment_intent, "pi") !== paymentIntent ||
      id(charge.payment_intent, "pi") !== paymentIntent) return null;
  if (!integer(session.amount_total) || !integer(charge.amount) || !integer(charge.amount_captured) || !integer(dispute.amount) ||
      session.amount_total <= 0 || charge.amount !== session.amount_total || charge.amount_captured !== charge.amount ||
      dispute.amount <= 0 || dispute.amount > charge.amount ||
      !integer(session.created) || !integer(charge.created) || charge.created < session.created ||
      typeof session.currency !== "string" || !/^[a-z]{3}$/.test(session.currency) ||
      charge.currency !== session.currency || dispute.currency !== session.currency) return null;
  const details = row(session.customer_details);
  const email = details?.email;
  if (typeof email !== "string" || email.length > 254 || email !== email.trim() ||
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  return {
    account: input.account, dispute: dispute.id as string, purchase: session.id as string,
    charge: chargeId, paymentIntent, buyerEmail: email,
    product: metadata.product,
    title: typeof metadata.title === "string" && metadata.title.length <= 480 ? metadata.title : null,
    checkoutCreatedAt: session.created, chargeCreatedAt: charge.created, amount: charge.amount, disputedAmount: dispute.amount, currency: session.currency,
  };
}
