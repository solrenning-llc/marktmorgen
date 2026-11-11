/**
 * Every place that opens a new charge to a buyer on a creator's account.
 *
 * A deemed-supplier record that says "refuse-consumers" (lib/deemed-supplier.ts)
 * is only true when every one of these refuses that jurisdiction's consumers
 * before it asks Stripe for anything (lib/jurisdiction-refusal-rules.ts,
 * checkoutLocationDecision). Wiring the refusal into some of them and missing
 * another would sell where the record says nobody can buy, so the list is
 * kept here and tests/sale-openings.test.ts checks it against the real
 * sources: a file that opens a checkout session or a payment intent through
 * onAccount (lib/stripe-account.ts, also as a default provider), or a PayPal
 * order on the creator's PayPal account, and is not listed fails the test.
 *
 * None of these calls the refusal yet, and nothing is recorded: with no
 * record, openingsWithoutRefusal has nothing to check. A "refuse-consumers"
 * record added later fails the test until it names every file here and each
 * of them calls checkoutLocationDecision.
 *
 * Out of this list on purpose: changes to a subscription the buyer already
 * has (tier and yearly switches, renewals) and Marktmorgen's own plans on
 * the platform account (lib/billing.ts). Those are not a new purchase from a
 * store; whether a refusal applies to them is a later reading.
 *
 * Imports nothing, so a page drawn in the browser can read it.
 */

export type SaleOpening = {
  /** The file, from the repository root. */
  file: string;
  /** The endpoint it posts to on the creator's account: Stripe's, or PayPal's for an order (#3682 reviews). */
  opens: "/checkout/sessions" | "/payment_intents" | "/v2/checkout/orders";
  /** What the buyer is buying there. */
  what: string;
};

export const SALE_OPENINGS: readonly SaleOpening[] = Object.freeze([
  { file: "lib/store-checkout.ts", opens: "/checkout/sessions", what: "a product, a bundle, a plan in instalments, a gift, a group or a pre-order" },
  { file: "lib/cart-checkout.ts", opens: "/checkout/sessions", what: "a cart of several products" },
  { file: "lib/calls.ts", opens: "/checkout/sessions", what: "a paid call at a time" },
  { file: "lib/call-packages.ts", opens: "/checkout/sessions", what: "a package of calls" },
  { file: "lib/payment-requests.ts", opens: "/checkout/sessions", what: "a payment request the creator sent" },
  { file: "lib/store-tip-checkout.ts", opens: "/checkout/sessions", what: "a tip (\"Support my work\")" },
  { file: "lib/upsell.ts", opens: "/payment_intents", what: "a one-click offer after paying, on the card just used" },
  { file: "lib/paypal-sales.ts", opens: "/v2/checkout/orders", what: "a product through PayPal, on the creator's PayPal account" },
].map((entry) => Object.freeze(entry as SaleOpening)));

/** Files that open a checkout session that charges nothing. */
export const NOT_A_SALE: readonly (Omit<SaleOpening, "what"> & { why: string })[] = Object.freeze([
  Object.freeze({ file: "lib/card-update.ts", opens: "/checkout/sessions" as const, why: "setup mode: a member saves a new card for a membership they already have" }),
]);

/**
 * Files that open a session only on behalf of a listed sale opening, so the
 * refusal there covers them: each is reached only from `by`, which refuses
 * before it is called. Named so the scan still sees every opening.
 */
export const COVERED_OPENINGS: readonly (Omit<SaleOpening, "what"> & { by: string; why: string })[] = Object.freeze([
  Object.freeze({
    file: "lib/order-confirmation-outbox.ts",
    opens: "/checkout/sessions" as const,
    by: "lib/store-checkout.ts",
    why: "the original paid confirmation's session, created only from inside createCheckout",
  }),
]);

/** A source with its comments taken out, so a name in a comment never reads as code. */
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

/**
 * The openings in a source text: each POST through onAccount (called by name,
 * or as the default of a provider chosen at run time, `(… ?? onAccount)(`)
 * whose path is exactly "/checkout/sessions" or "/payment_intents", and each
 * PayPal `call("POST", "/v2/checkout/orders"`. A path that goes on
 * ("/checkout/sessions/" + id + "/expire", an order's "/capture") acts on one
 * that exists. Comments are left out.
 */
export function openingCalls(text: string): SaleOpening["opens"][] {
  const source = withoutComments(text);
  const found: SaleOpening["opens"][] = [];
  const stripe = /\bonAccount\s*\)?\s*\(\s*["'`]POST["'`]\s*,[^,]*,\s*(["'`])(\/checkout\/sessions|\/payment_intents)\1/g;
  for (let match = stripe.exec(source); match; match = stripe.exec(source)) {
    found.push(match[2] as SaleOpening["opens"]);
  }
  const paypal = /\bcall\s*\(\s*["'`]POST["'`]\s*,\s*(["'`])(\/v2\/checkout\/orders)\1/g;
  for (let match = paypal.exec(source); match; match = paypal.exec(source)) {
    found.push(match[2] as SaleOpening["opens"]);
  }
  return found;
}


const named = (implementedIn: unknown) =>
  new Set(
    typeof implementedIn === "string"
      ? implementedIn
          .split(/[\s,;]+/)
          .map((word) => word.replace(/^[(`"']+|[)`"'.:]+$/g, ""))
          .filter(Boolean)
      : [],
  );

/**
 * For each "refuse-consumers" record, every sale opening it does not name in
 * implementedIn, or whose source does not call checkoutLocationDecision.
 * Empty when nothing refuses, or when every refusal covers every opening.
 */
export function openingsWithoutRefusal(
  records: readonly { jurisdiction: string; treatment: string; implementedIn: string }[],
  sourceOf: (file: string) => string,
): string[] {
  const gaps: string[] = [];
  for (const record of records) {
    if (record.treatment !== "refuse-consumers") continue;
    const files = named(record.implementedIn);
    for (const opening of SALE_OPENINGS) {
      if (!files.has(opening.file)) gaps.push(`${record.jurisdiction}: ${opening.file} is not named in implementedIn`);
      // A call, outside comments: an import or a mention alone is not a refusal (Claude 3 on #3682).
      else if (!/\bcheckoutLocationDecision\s*\(/.test(withoutComments(sourceOf(opening.file)))) {
        gaps.push(`${record.jurisdiction}: ${opening.file} never calls checkoutLocationDecision`);
      }
    }
  }
  return gaps;
}
