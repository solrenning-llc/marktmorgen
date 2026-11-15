/**
 * 753 [IR1], unit 3a: where a creator may need to register to collect tax.
 *
 * Stripe Tax already watches this on the creator's own account: it compares the sales Stripe processed there (minus
 * refunds) with each place's registration limit, in the time window each place uses, lists the places that may need a
 * registration under "Needs attention" on the Locations tab, and emails the account owner when a limit is passed
 * (https://docs.stripe.com/tax/monitoring, read 15 November 2026). Its results are not in Stripe's public API (the MCP
 * page lists "Retrieve tax threshold monitoring results" as a private preview, https://docs.stripe.com/mcp, same day),
 * so Marktmorgen neither recounts them nor shows a figure of its own: the studio says what Stripe counts and opens that
 * tab. Nothing is read, written or charged here.
 */
export const NOT_TAX_ADVICE = "This is information from your sales, not tax advice.";

const LOCATIONS = /^https:\/\/dashboard\.stripe\.com\/(?:test\/)?tax\/locations$/;

/** The "Needs attention" tab of the creator's own Stripe Tax Locations page; null for anything else. */
export function needsAttentionPage(locations: string): string | null {
  return typeof locations === "string" && LOCATIONS.test(locations) ? `${locations}?primary_tab=needs_attention` : null;
}
