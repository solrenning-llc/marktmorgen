/**
 * #2990 (601 [KB22] unit U5), the amounts the creator reads next to an
 * invoice's status, and the reviews of its head 187dd4e8:
 *
 *   - Claude 2, MEDIUM 1 (second money review, CX-116): the line showed the
 *     invoice's `total`, not what was paid or is still owed. Stripe takes a
 *     customer-balance credit (the invite credit of
 *     lib/creator-invite-credit.ts is one) off `amount_due`/`amount_paid`,
 *     never off `total`, so a $69 invoice settled with $20 of credit and $49
 *     by card read "$69 · Paid". Now the line says what was paid or is owed,
 *     and the total and the credit when they differ; a row without those
 *     amounts is not shown with a guessed one; a negative total (a credit to
 *     the balance) is never said as "Paid". The same for "Not collected".
 *   - Claude 2, MEDIUM 2: every plan refund here is a Refund on the charge
 *     (lib/plan-refund-write.ts, lib/closing-plan-guard.ts), which leaves
 *     the invoice as it was ("paid", same amounts), and the money-back flow
 *     keeps subscriptionId, so the page still lists it. Stripe's invoice
 *     cannot say it was refunded, so a paid line never says simply "Paid":
 *     it says a refund or a dispute is not shown there, and the page says
 *     where one is seen.
 *   - rv49, LOW 1: limitKey was put between counterReply's doc comment and
 *     counterReply itself.
 *
 * Claude 2's two proofs (tests/c2-2990-amount-paid.test.ts and
 * tests/c2-2990-refunded-paid.test.ts, posted on the PR) are reused here.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { planInvoicesOf, readPlanInvoicePage } from "@/lib/plan-invoices";
import { PlanInvoicesList } from "@/components/plan-invoices-list";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_invoices_amounts";
const CUS = "cus_PlanAmounts001";
const SUB = "sub_PlanAmounts001";

function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "in_PlanAmounts0001",
    object: "invoice",
    customer: CUS,
    parent: { type: "subscription_details", subscription_details: { subscription: SUB, metadata: {} } },
    status: "paid",
    number: "AMOUNTS-0001",
    created: 1_790_000_000,
    total: 6900,
    amount_due: 6900,
    amount_paid: 6900,
    amount_remaining: 0,
    currency: "usd",
    hosted_invoice_url: "https://invoice.stripe.com/i/acct_platform/amounts",
    invoice_pdf: "https://pay.stripe.com/invoice/acct_platform/amounts/pdf",
    ...over,
  };
}

function shown(invoice: Record<string, unknown>): string {
  const read = readPlanInvoicePage({ object: "list", has_more: false, data: [invoice] }, { customer: CUS, subscription: SUB });
  return renderToStaticMarkup(createElement(PlanInvoicesList, { read: { state: "listed", ...read } }));
}

/** The text of the line under the invoice's heading: day, amounts and status. */
function line(text: string): string {
  const found = /<h2[^>]*>[^<]*<\/h2><p[^>]*>([^<]*)<\/p>/.exec(text)?.[1] ?? "";
  return found.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

// Stripe's own shape, as in the API: a refunded charge leaves its invoice as it was.
const REFUNDED = row({ id: "in_PlanRefunded001", number: "BACK-0001", hosted_invoice_url: "https://invoice.stripe.com/i/acct_platform/back", invoice_pdf: "https://pay.stripe.com/invoice/acct_platform/back/pdf" });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/invoices") return new Response(JSON.stringify({ object: "list", data: [REFUNDED], has_more: false }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main() {
  part("MEDIUM 1 (Claude 2): a paid invoice settled partly with the customer's balance credit");
  {
    // Total 6900, $20 of balance applied, $49 charged to the card.
    const text = shown(row({ status: "paid", starting_balance: -2000, ending_balance: 0, amount_due: 4900, amount_paid: 4900, amount_remaining: 0 }));
    is("it is listed", text.includes("AMOUNTS-0001"), true);
    is("never said as $69 paid when $49 was paid", text.includes("$69 · Paid"), false);
    is("what was paid ($49) is what the line shows", line(text).includes("$49 paid"), true);
    is("the total and the credit that made the difference are said too", [line(text).includes("Total $69"), line(text).includes("$20 from your account's credit")], [true, true]);
  }

  part("MEDIUM 1 (Claude 2): an open invoice that still owes less than its total");
  {
    const text = shown(row({ status: "open", starting_balance: -2000, ending_balance: 0, amount_due: 4900, amount_paid: 0, amount_remaining: 4900 }));
    is("never said as $69 not paid yet when $49 is owed", text.includes("$69 · Not paid yet"), false);
    is("what is still owed ($49) is what the line shows", line(text).includes("$49 still owed"), true);
  }

  part("MEDIUM 1, next door (rule 30): an uncollected invoice says what was not collected");
  {
    const text = shown(row({ status: "uncollectible", amount_due: 6900, amount_paid: 2000, amount_remaining: 4900 }));
    is("never said as $69 not collected when $49 is owed", text.includes("$69 · Not collected"), false);
    is("what was paid and what is owed are both said", [line(text).includes("$20 paid"), line(text).includes("$49 still owed")], [true, true]);
  }

  part("MEDIUM 1 (Claude 2): a negative total is a credit to the balance, never said as paid");
  {
    // A proration credit larger than the charge: Stripe marks it paid with nothing due and adds $20 to the balance.
    const text = shown(row({ status: "paid", total: -2000, amount_due: 0, amount_paid: 0, amount_remaining: 0 }));
    is("it is listed", text.includes("AMOUNTS-0001"), true);
    is("never said as paid, never a negative amount", [/Paid/.test(line(text)), line(text).includes("-$20")], [false, false]);
    is("said as $20 credited to the account's balance", line(text).includes("$20 credited to your account balance"), true);
  }

  part("MEDIUM 1: an invoice without what was paid or is owed is not shown with a guessed amount");
  {
    const read = readPlanInvoicePage(
      {
        object: "list",
        has_more: false,
        data: [
          row({ id: "in_NoAmountPaid01", amount_paid: undefined }),
          row({ id: "in_TextRemaining1", amount_remaining: "0" }),
          row({ id: "in_NegativePaid01", amount_paid: -1 }),
        ].map((r) => JSON.parse(JSON.stringify(r))),
      },
      { customer: CUS, subscription: SUB },
    );
    is("none listed, all counted as unreadable", [read.invoices.length, read.unreadable], [0, 3]);
  }

  part("A plain paid invoice still reads simply, with the amount it was paid");
  {
    const text = shown(row({}));
    is("$69 and Paid on the line", [line(text).includes("(UTC) · $69 · Paid"), line(text).includes("$69 · Paid")], [true, true]);
    is("no total or credit said when nothing differs", [line(text).includes("Total"), line(text).includes("credit")], [false, false]);
  }

  part("MEDIUM 2 (Claude 2): after the money-back refund the page still lists the plan's paid invoice");
  {
    const flow = readFileSync("lib/plan-refund-flow.ts", "utf8");
    is("the refund flow ends the plan without clearing subscriptionId", flow.includes("setSubscription(storeRef(fresh), { active: false, period: null })"), true);
    const email = "plan-invoices-amounts@example.test";
    await claimHandle(email, "planamountsback", "Synthetic shop", "");
    await ensureStatsId(email);
    await ensureStoreId(email);
    await setSubscription(email, { customerId: CUS, subscriptionId: SUB, active: true, tier: "creator", period: paidPeriod() });
    await setSubscription(email, { active: false, period: null });
    const store = (await storeForEmail(email))!;
    is("subscriptionId and customer kept, so the studio still links the page", [store.subscriptionId, store.stripeCustomerId, store.subscriptionActive], [SUB, CUS, false]);

    const read = await planInvoicesOf(store, async () => "within");
    const text = renderToStaticMarkup(createElement(PlanInvoicesList, { read }));
    is("the refunded invoice is listed", text.includes("BACK-0001"), true);
    // Changed from Claude 2's proof: Stripe's invoice cannot tell a refunded payment from a kept one, so the
    // assertion is that the paid line itself never ends at "Paid": it says a refund would not show there.
    is("a payment given back is never said as simply paid", [/· Paid$/.test(line(text)), /Paid \(a refund or dispute is not shown here\)$/.test(line(text))], [false, true]);
    is("the page says where a refund or a dispute is seen", /a refund we made[^<]*card or bank statement/i.test(text), true);
  }

  part("LOW 1 (rv49): counterReply keeps its own doc comment");
  {
    const guard = readFileSync("lib/request-guard.ts", "utf8");
    is("the comment on the SET NX + INCR reply sits right above counterReply", /The count of a SET NX \+ INCR pipeline[^/]*\*\/\r?\nfunction counterReply\(/.test(guard), true);
    is("and limitKey has its own, right above it", /\*\/\r?\nasync function limitKey\(/.test(guard) && !/as withinEssentialLimit does, so a getter cannot answer for them\.\r?\n \*\/\r?\n\/\*\*/.test(guard), true);
  }
  done();
}

void main();
