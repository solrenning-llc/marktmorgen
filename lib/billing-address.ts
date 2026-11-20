/**
 * 790 [IV2] (owner, 20 November 2026; AGENTS.md, EU VAT rule (i)): every checkout that charges the buyer asks Stripe
 * for the buyer's full billing address, in every country, with Stripe's own autofill. It is one of the two pieces of
 * location evidence for EU and UK VAT (Implementing Regulation 282/2011, arts. 24b and 24f), the buyer's place for US
 * sales tax, and lets every buyer take a one-click offer. Only the billing address: no phone, no other field, never
 * used for marketing. A checkout that charges nothing (a session from a package already paid for, a card update)
 * does not call this.
 *
 * Stripe API reference, POST /v1/checkout/sessions, billing_address_collection (read 20 November 2026): "required:
 * Checkout will always collect the customer's billing address." The default, auto, collects it only when necessary,
 * and with Stripe Tax only the fields the tax needs (for the United States, the country and the ZIP code).
 */
export function askBillingAddress(body: URLSearchParams): void {
  body.set("billing_address_collection", "required");
}
