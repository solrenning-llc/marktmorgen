/**
 * The page that pays an unpaid plan renewal (lib/billing.ts,
 * renewalInvoicePage) and the failed-payment email (lib/billing-reminders.ts,
 * failedPlan) both use the subscription's expanded latest invoice. That
 * invoice is used only when it names the same subscription and the same
 * customer: an invoice of another subscription or customer is unknown, so its
 * link and amount never reach the studio or the email (issue #4449, Codex X8,
 * HIGH). The subscription's own invoice is used as before.
 */
import { renewalInvoicePage } from "@/lib/billing";
import { failedPlan } from "@/lib/billing-reminders";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_renewal_invoice_identity";
const SUB_A = "sub_RenewalUnpaidA1";
const NOW = Math.floor(Date.now() / 1000);
let detail: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.pathname === `/v1/subscriptions/${SUB_A}`) return Response.json(detail);
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const invoiceOf = (subscription: string | null, customer: string | null, id: string, parent = true) => ({
  id, status: "open", amount_due: 44900, hosted_invoice_url: `https://invoice.stripe.com/i/acct_x/${id}`, next_payment_attempt: NOW + 3 * 86_400,
  ...(subscription ? { subscription } : {}), ...(customer ? { customer } : {}),
  ...(parent && subscription ? { parent: { type: "subscription_details", subscription_details: { subscription } } } : {}),
});
const subA = (invoice: Record<string, unknown>) => ({
  id: SUB_A, status: "past_due", created: NOW - 90 * 86_400, trial_end: NOW - 76 * 86_400, metadata: { store: "renewalshop" },
  customer: { id: "cus_A000000001", email: "a@example.com" }, cancel_at: null, cancel_at_period_end: false,
  items: { data: [{ current_period_start: NOW - 10 * 86_400, current_period_end: NOW + 20 * 86_400, price: { lookup_key: "nimbus_labs_pro_month", unit_amount: 44900, recurring: { interval: "month" } } }] },
  latest_invoice: invoice,
});

async function main(): Promise<void> {
  part("Control: the subscription's own invoice");
  detail = subA(invoiceOf(SUB_A, "cus_A000000001", "in_InvoiceA0001"));
  is("studio gives its page", await renewalInvoicePage(SUB_A), "https://invoice.stripe.com/i/acct_x/in_InvoiceA0001");
  is("email takes its invoice", failedPlan(detail)?.invoice, "in_InvoiceA0001");
  detail = subA(invoiceOf(SUB_A, "cus_A000000001", "in_InvoiceA0002", false));
  is("named only at the top level (an older API version): still its own", failedPlan(detail)?.invoice, "in_InvoiceA0002");

  part("Another subscription's invoice");
  detail = subA(invoiceOf("sub_OtherSub0001", "cus_B000000001", "in_InvoiceB0001"));
  is("studio refuses", await renewalInvoicePage(SUB_A), null);
  is("email refuses", failedPlan(detail), null);

  part("Its own subscription, another customer");
  detail = subA(invoiceOf(SUB_A, "cus_B000000001", "in_InvoiceB0002"));
  is("studio refuses", await renewalInvoicePage(SUB_A), null);
  is("email refuses", failedPlan(detail), null);

  part("An invoice naming no subscription");
  detail = subA(invoiceOf(null, "cus_A000000001", "in_InvoiceN0001"));
  is("studio refuses", await renewalInvoicePage(SUB_A), null);
  is("email refuses", failedPlan(detail), null);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
