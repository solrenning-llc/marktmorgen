/**
 * 648 [WG8]: what a checkout that came back without a payment can honestly be
 * called, read only from the Checkout Session the thanks page already fetched
 * (lib/store-checkout.ts, readOrder, which expands payment_intent with its
 * latest_charge, and subscription). No new call to Stripe.
 *
 *   - "none": provably nothing was charged. The session is open or expired
 *     and unpaid, no subscription was made, and its PaymentIntent is absent,
 *     waiting for a payment method or canceled, with no charge or only a
 *     failed one.
 *   - "declined": the bank or card refused it. The PaymentIntent waits for
 *     another payment method after an error, with no charge or only a failed
 *     one: nothing was charged either, and the buyer is told what to do.
 *   - "checking": anything else, an answer in another shape included. The page
 *     never says "not charged" on it (lib/call-series-billing.ts keeps the same
 *     rule): it asks the buyer not to pay again while it is checked.
 */
export type UnpaidProof = "none" | "declined" | "checking";

type Plain = Record<string, unknown>;

function plain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** A field the object holds itself, as plain data; undefined when it is missing or comes from elsewhere. */
function own(object: Plain, name: string): { value: unknown } | undefined {
  const slot = Object.getOwnPropertyDescriptor(object, name);
  return slot && Object.hasOwn(slot, "value") ? { value: slot.value } : undefined;
}

/** No money moved by this charge: none at all, or one Stripe marks failed and unpaid. */
function noMoneyCharge(charge: { value: unknown } | undefined): boolean {
  if (!charge) return false;
  if (charge.value === null) return true;
  if (!plain(charge.value)) return false;
  return own(charge.value, "status")?.value === "failed" && own(charge.value, "paid")?.value === false;
}

export function unpaidProof(session: unknown): UnpaidProof {
  if (!plain(session)) return "checking";
  const status = own(session, "status")?.value;
  if ((status !== "open" && status !== "expired") || own(session, "payment_status")?.value !== "unpaid") return "checking";
  // A subscription made by this checkout may have charged its first invoice: never "not charged" then.
  const subscription = own(session, "subscription");
  if (!subscription || subscription.value !== null) return "checking";
  const intent = own(session, "payment_intent");
  if (!intent) return "checking";
  if (intent.value === null) return "none";
  // Not expanded, or in another shape: not known.
  if (!plain(intent.value)) return "checking";
  if (!noMoneyCharge(own(intent.value, "latest_charge"))) return "checking";
  const state = own(intent.value, "status")?.value;
  if (state === "canceled") return "none";
  if (state !== "requires_payment_method") return "checking";
  const error = own(intent.value, "last_payment_error");
  if (!error) return "checking";
  if (error.value === null) return "none";
  return plain(error.value) ? "declined" : "checking";
}

/** The thanks page's notice for an unpaid checkout, by what can be proved about it. */
export function unpaidNotice(proof: UnpaidProof): "unpaid" | "declined" | "checking" {
  return proof === "none" ? "unpaid" : proof;
}
