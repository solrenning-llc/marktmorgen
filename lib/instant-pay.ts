/**
 * Which ways to pay a buyer meets at checkout.
 *
 * No checkout here names its payment methods. Stripe then offers what the
 * creator switched on in their own Stripe dashboard (their payment method
 * settings for this platform), narrowed to what fits the buyer, the
 * currency and the amount: cards, Apple Pay and Google Pay, Link, and — where
 * the creator's account and currency allow them — PayPal, Klarna, Afterpay
 * or Clearpay, Affirm, iDEAL, Bancontact and the rest. A membership or a
 * payment plan is a subscription, and Stripe shows only the methods it can
 * charge again each period. So more ways to pay is the creator's switch,
 * not ours, and the studio links straight to it (lib/payment-methods.ts).
 *
 * Only ways to pay that settle while the buyer is on the page are kept.
 * Every product here is handed over the moment Stripe says it is paid: the
 * file on the thanks page, the course, the booked call. A bank debit, a cash
 * voucher or a crypto transfer says "complete" at checkout and "paid" days
 * later, so a buyer would pay and meet a page saying nothing was paid. Those
 * methods are left out of the checkout rather than apologised for after it.
 */
export const DELAYED_METHODS = [
  "us_bank_account",
  "sepa_debit",
  "bacs_debit",
  "au_becs_debit",
  "acss_debit",
  "boleto",
  "oxxo",
  "konbini",
  "customer_balance",
  "multibanco",
  "crypto",
] as const;

/** Adds the exclusion to a Checkout Session being made. */
export function onlyInstantMethods(body: URLSearchParams): void {
  DELAYED_METHODS.forEach((type, i) => body.set(`excluded_payment_method_types[${i}]`, type));
}

/**
 * The kinds of payment method a one-click offer after paying can be charged
 * to: a card — Apple Pay and Google Pay pay with one too — or Link.
 */
export const REUSABLE_METHODS = new Set(["card", "link"]);

/**
 * Keeps the card for the offers after paying, when offers follow.
 *
 * Asked of cards alone, rather than of the whole checkout: a request to save
 * the method for later made of the whole checkout would hide every way to
 * pay that cannot be saved — Klarna, Afterpay, Affirm, iDEAL and the others —
 * from every buyer of a product with a funnel. This way a buyer may still
 * pay with any of them, and simply meets no one-click offer afterward
 * (reusableMethod). Saved "on_session": for payments made while the buyer
 * is there, never to be charged behind their back. Apple Pay and Google Pay
 * are cards here, so they are kept the same way. Link is not asked: Stripe
 * saves a Link method only for charges made while the buyer is away, which
 * is more than an offer on the thanks page needs.
 */
export function saveCardForOffers(body: URLSearchParams): void {
  body.set("payment_method_options[card][setup_future_usage]", "on_session");
}

/**
 * Whether a paid checkout left a method a one-click offer can charge: one of
 * the reusable kinds, saved to the customer the checkout made. Needs the
 * checkout read with its payment's method expanded
 * (`expand[]=payment_intent.payment_method`). Anything else — a buy now,
 * pay later plan, a bank redirect, a card that was not saved — is false, and
 * the offers are simply not shown.
 */
export function reusableMethod(session: { customer?: unknown; payment_intent?: unknown }): boolean {
  const intent = session.payment_intent;
  const method = intent && typeof intent === "object" ? (intent as { payment_method?: unknown }).payment_method : null;
  if (!method || typeof method !== "object") return false;
  const { type, customer } = method as { type?: unknown; customer?: unknown };
  const owner =
    typeof customer === "string"
      ? customer
      : customer && typeof customer === "object" && typeof (customer as { id?: unknown }).id === "string"
        ? (customer as { id: string }).id
        : null;
  const buyer =
    typeof session.customer === "string"
      ? session.customer
      : session.customer && typeof session.customer === "object" && typeof (session.customer as { id?: unknown }).id === "string"
        ? (session.customer as { id: string }).id
        : null;
  return typeof type === "string" && REUSABLE_METHODS.has(type) && owner !== null && owner === buyer;
}

/** The id of a checkout's payment method, whether or not it was expanded. */
export function methodId(session: { payment_intent?: unknown }): string | null {
  const intent = session.payment_intent;
  const method = intent && typeof intent === "object" ? (intent as { payment_method?: unknown }).payment_method : null;
  if (typeof method === "string") return method;
  if (method && typeof method === "object" && typeof (method as { id?: unknown }).id === "string") return (method as { id: string }).id;
  return null;
}

/**
 * Charges the amount the page showed, in the currency it was written in.
 *
 * Stripe can convert a price into the currency of whoever is looking at it.
 * It reads well until you follow the money: the buyer of a $39 plan meets a
 * total in their own currency, carrying a conversion fee of two to four per
 * cent that Stripe adds to the exchange rate, and the creator never chose
 * either number. Our own page promises that what is charged is what was
 * saved, so the conversion is turned off and the price stands as written.
 */
export function inTheCurrencyShown(body: URLSearchParams): void {
  body.set("adaptive_pricing[enabled]", "false");
}

/**
 * Whether a finished checkout is settled: paid, or brought to nothing by a
 * discount code.
 *
 * A code for 100%, or for more than the price, closes the checkout with
 * nothing to pay, and Stripe then says "no_payment_required" rather than
 * "paid". The buyer still bought the thing and is owed it, so every door that
 * asks "was this paid for?" asks it here, and none of them can forget the
 * second answer.
 */
export function isSettled(session: { status?: unknown; payment_status?: unknown }): boolean {
  return (
    session.status === "complete" &&
    (session.payment_status === "paid" || session.payment_status === "no_payment_required")
  );
}

const DELIVERY_INTENT_ID = /^pi_[A-Za-z0-9]{8,255}$/;

/** An indexed payment ID, an empty string for a confirmed zero total, or null when the receipt does not read. */
export function paymentIntentForDelivery(session: { amount_total?: unknown; payment_intent?: unknown }): string | null {
  const intent = session.payment_intent;
  if (intent === undefined || intent === null) return session.amount_total === 0 ? "" : null;
  const id = typeof intent === "object" ? (intent as { id?: unknown }).id : intent;
  return typeof id === "string" && DELIVERY_INTENT_ID.test(id) ? id : null;
}
