/**
 * Claude 2, second money review of #2990 (head 187dd4e8): a plan invoice whose
 * payment was given back is listed as "Paid" for its whole amount, with no
 * word of the refund.
 *
 * Every refund of a plan payment in this repository is a Refund on the charge
 * (lib/billing.ts refundCharge, lib/plan-refund-write.ts, lib/closing-plan-guard.ts:
 * POST /v1/refunds). Stripe leaves the invoice itself as it was: status "paid",
 * total and amount_paid unchanged (no credit note is made: the repository has no
 * /credit_notes call). The money-back flow (lib/plan-refund-flow.ts) then ends the
 * plan with setSubscription(..., { active: false, period: null }), which keeps
 * subscriptionId, so the studio still links the page and the page still reads that
 * subscription's invoices. The creator who was given $69 back reads "$69 · Paid".
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { planInvoicesOf } from "@/lib/plan-invoices";
import { PlanInvoicesList } from "@/components/plan-invoices-list";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_c2_2990_refunded";
const CUS = "cus_C2Refunded0001";
const SUB = "sub_C2Refunded0001";

// The invoice exactly as Stripe keeps it after its charge was refunded in full: nothing on it changes.
const REFUNDED = {
  id: "in_C2Refunded00001",
  object: "invoice",
  customer: CUS,
  parent: { type: "subscription_details", subscription_details: { subscription: SUB, metadata: {} } },
  status: "paid",
  number: "C2BACK-0001",
  created: 1_790_000_000,
  total: 6900,
  amount_due: 6900,
  amount_paid: 6900,
  amount_remaining: 0,
  post_payment_credit_notes_amount: 0,
  currency: "usd",
  hosted_invoice_url: "https://invoice.stripe.com/i/acct_platform/c2r",
  invoice_pdf: "https://pay.stripe.com/invoice/acct_platform/c2r/pdf",
};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/invoices") return new Response(JSON.stringify({ object: "list", data: [REFUNDED], has_more: false }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main() {
  part("After the money-back refund the store still names its plan subscription");
  {
    const flow = readFileSync("lib/plan-refund-flow.ts", "utf8");
    is("the refund flow ends the plan without clearing subscriptionId", flow.includes("setSubscription(storeRef(fresh), { active: false, period: null })"), true);
    const email = "c2-2990-refunded@example.test";
    await claimHandle(email, "ctworefunded", "Synthetic shop", "");
    await ensureStatsId(email);
    await ensureStoreId(email);
    await setSubscription(email, { customerId: CUS, subscriptionId: SUB, active: true, tier: "creator", period: paidPeriod() });
    await setSubscription(email, { active: false, period: null });
    const store = (await storeForEmail(email))!;
    is("subscriptionId and customer kept, so the studio still links the page", [store.subscriptionId, store.stripeCustomerId, store.subscriptionActive], [SUB, CUS, false]);

    const read = await planInvoicesOf(store, async () => "within");
    const text = renderToStaticMarkup(createElement(PlanInvoicesList, { read }));
    is("the refunded invoice is listed", text.includes("C2BACK-0001"), true);
    is("a payment given back is never said as simply paid", text.includes("$69 · Paid"), false);
    is("the page says, somewhere, that refunds are not reflected or that this one was refunded", /refund/i.test(text), true);
  }
  done();
}

void main();
