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
 * onAccount (lib/stripe-account.ts) and is not listed fails the test.
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
  /** The Stripe endpoint it posts to on the creator's account. */
  opens: "/checkout/sessions" | "/payment_intents";
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
].map((entry) => Object.freeze(entry as SaleOpening)));

/** Files that open a checkout session that charges nothing. */
export const NOT_A_SALE: readonly (Omit<SaleOpening, "what"> & { why: string })[] = Object.freeze([
  Object.freeze({ file: "lib/card-update.ts", opens: "/checkout/sessions" as const, why: "setup mode: a member saves a new card for a membership they already have" }),
]);

/**
 * The openings in a source text: each POST through onAccount whose path is
 * exactly "/checkout/sessions" or "/payment_intents". A path that
 * goes on ("/checkout/sessions/" + id + "/expire") acts on one that exists.
 */
export function openingCalls(source: string): SaleOpening["opens"][] {
  const found: SaleOpening["opens"][] = [];
  const call = /\bonAccount\s*\(\s*["'`]POST["'`]\s*,[^,]*,\s*(["'`])(\/checkout\/sessions|\/payment_intents)\1/g;
  for (let match = call.exec(source); match; match = call.exec(source)) {
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
      else if (!/\bcheckoutLocationDecision\b/.test(sourceOf(opening.file))) {
        gaps.push(`${record.jurisdiction}: ${opening.file} never calls checkoutLocationDecision`);
      }
    }
  }
  return gaps;
}
